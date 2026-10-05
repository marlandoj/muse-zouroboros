import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, relative, resolve } from "node:path";
import {
  FACTORY_STATE_MUTATION_EVIDENCE_ROOT,
  assertFactoryStateMutationMayProceed,
  createFactoryStateMutationReceipt,
  factoryStateMutationEvidenceMode,
  factoryStateMutationPayloadSha256,
  parseTicketClaimOwnerPayload,
  readFactoryStateMutationCycleId,
  readFactoryStateMutationReceipt,
  resolveFactoryStateMutationCycle,
  validateFactoryStateClaimTerminalProof,
  writeFactoryStateMutationReceipt,
  type FactoryStateMutationEvidenceMode,
  type FactoryStateMutationReceipt,
} from "./factory-state-mutation-evidence";

const DEFAULT_LEASE_MINUTES = 60;
const MIN_LEASE_MINUTES = 5;
const MAX_LEASE_MINUTES = 120;

export interface TicketClaimRecord {
  schema_version: 1;
  ticket_id: string;
  execution_id: string;
  claimed_at: string;
  lease_expires_at: string;
  pid: number;
}

export type TicketClaimResult =
  | { status: "acquired"; record: TicketClaimRecord; claim_path: string }
  | { status: "contended"; record: TicketClaimRecord; claim_path: string; reason: string }
  | { status: "unavailable"; claim_path: string; reason: string };

export interface AcquireTicketClaimOptions {
  stateDir?: string;
  nowMs?: number;
  leaseMs?: number;
  pid?: number;
}

export interface ReconcileTicketClaimsOptions {
  stateDir: string;
  nowMs?: number;
  dryRun?: boolean;
  executionAlive?: (claim: TicketClaimRecord) => boolean;
  mutationEvidenceMode?: FactoryStateMutationEvidenceMode;
  interruptAfterStage?: "prepared" | "claim-removed";
}

export interface TicketClaimReconcileResult {
  scanned: number;
  reclaimed: string[];
  planned: string[];
  kept: number;
  failed: number;
  evidence_receipts: string[];
  recovered: string[];
  would_reject: Array<{ ticket_id: string; reason: string }>;
}

class ClaimReleaseInterruption extends Error {}

function defaultStateDir(): string {
  return factoryStateRoot();
}

function claimRoot(stateDir: string): string {
  return join(stateDir, "ticket-claims");
}

export function ticketClaimKey(ticketId: string): string {
  const normalized = ticketId.trim();
  if (!normalized) throw new Error("ticket claim requires a Linear ticket_id");
  return createHash("sha256").update(normalized).digest("hex");
}

export function ticketClaimLeaseMs(raw = process.env.SF_TICKET_CLAIM_LEASE_MIN): number {
  const minutes = raw === undefined || raw.trim() === "" ? DEFAULT_LEASE_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < MIN_LEASE_MINUTES || minutes > MAX_LEASE_MINUTES) {
    throw new Error(`SF_TICKET_CLAIM_LEASE_MIN must be between ${MIN_LEASE_MINUTES} and ${MAX_LEASE_MINUTES}`);
  }
  return minutes * 60_000;
}

function validClaim(value: unknown): value is TicketClaimRecord {
  if (!value || typeof value !== "object") return false;
  const claim = value as Partial<TicketClaimRecord>;
  return claim.schema_version === 1
    && typeof claim.ticket_id === "string"
    && claim.ticket_id.trim() !== ""
    && typeof claim.execution_id === "string"
    && claim.execution_id.trim() !== ""
    && typeof claim.claimed_at === "string"
    && Number.isFinite(Date.parse(claim.claimed_at))
    && typeof claim.lease_expires_at === "string"
    && Number.isFinite(Date.parse(claim.lease_expires_at))
    && typeof claim.pid === "number"
    && Number.isInteger(claim.pid)
    && claim.pid > 0;
}

function readClaim(path: string): TicketClaimRecord {
  const parsed = JSON.parse(readFileSync(join(path, "owner.json"), "utf8"));
  if (!validClaim(parsed)) throw new Error("claim owner is invalid");
  if (ticketClaimKey(parsed.ticket_id) !== basename(path)) {
    throw new Error("claim owner ticket_id does not match its storage key");
  }
  return parsed;
}

function syncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

export function acquireTicketClaim(
  input: { ticket_id: string; execution_id: string },
  options: AcquireTicketClaimOptions = {},
): TicketClaimResult {
  const ticketId = input.ticket_id.trim();
  const executionId = input.execution_id.trim();
  if (!ticketId) throw new Error("ticket claim requires a Linear ticket_id");
  if (!executionId) throw new Error("ticket claim requires an execution_id");

  const stateDir = options.stateDir ?? defaultStateDir();
  const root = claimRoot(stateDir);
  const path = join(root, ticketClaimKey(ticketId));
  const nowMs = options.nowMs ?? Date.now();
  let leaseMs: number;
  try {
    leaseMs = options.leaseMs ?? ticketClaimLeaseMs();
    if (!Number.isFinite(leaseMs) || leaseMs < MIN_LEASE_MINUTES * 60_000 || leaseMs > MAX_LEASE_MINUTES * 60_000) {
      throw new Error(`ticket claim lease must be between ${MIN_LEASE_MINUTES} and ${MAX_LEASE_MINUTES} minutes`);
    }
    mkdirSync(root, { recursive: true, mode: 0o700 });
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      try {
        const record = readClaim(path);
        const expired = Date.parse(record.lease_expires_at) <= nowMs;
        return {
          status: "contended",
          record,
          claim_path: path,
          reason: expired ? "expired claim awaits reaper reconciliation" : "ticket already claimed",
        };
      } catch (readError) {
        return {
          status: "unavailable",
          claim_path: path,
          reason: `claim store is unreadable or corrupt: ${readError instanceof Error ? readError.message : String(readError)}`,
        };
      }
    }
    return {
      status: "unavailable",
      claim_path: path,
      reason: `claim store unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const record: TicketClaimRecord = {
    schema_version: 1,
    ticket_id: ticketId,
    execution_id: executionId,
    claimed_at: new Date(nowMs).toISOString(),
    lease_expires_at: new Date(nowMs + leaseMs).toISOString(),
    pid: options.pid ?? process.pid,
  };

  try {
    const descriptor = openSync(join(path, "owner.json"), "wx", 0o600);
    try {
      writeFileSync(descriptor, `${JSON.stringify(record, null, 2)}\n`);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    syncDirectory(path);
    syncDirectory(root);
    return { status: "acquired", record, claim_path: path };
  } catch (error) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      // Leaving the directory behind is fail-closed: later cycles cannot acquire it.
    }
    return {
      status: "unavailable",
      claim_path: path,
      reason: `claim could not become durable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function exactClaimEntries(path: string): void {
  const entries = readdirSync(path, { withFileTypes: true });
  if (entries.length !== 1 || entries[0]?.name !== "owner.json" || !entries[0].isFile()) {
    throw new Error("claim release requires exactly one regular owner.json descendant");
  }
}

function claimRelativePath(claim: TicketClaimRecord): string {
  return `ticket-claims/${ticketClaimKey(claim.ticket_id)}`;
}

function claimBinding(stateDir: string, producerId: string) {
  const laneLogPath = join(stateDir, "lane-utilization.jsonl");
  const sentinelPath = `${laneLogPath}.current-cycle`;
  return resolveFactoryStateMutationCycle({
    producerId,
    requestedCycleId: readFactoryStateMutationCycleId(sentinelPath),
    sentinelPath,
    laneLogPath,
  });
}

function releaseClaimWithEvidence(
  path: string,
  claim: TicketClaimRecord,
  options: ReconcileTicketClaimsOptions,
  result: TicketClaimReconcileResult,
): void {
  exactClaimEntries(path);
  const ownerPath = join(path, "owner.json");
  const ownerPayload = readFileSync(ownerPath, "utf8");
  const owner = parseTicketClaimOwnerPayload(ownerPayload);
  if (
    owner.ticket_id !== claim.ticket_id ||
    owner.execution_id !== claim.execution_id ||
    owner.claimed_at !== claim.claimed_at ||
    owner.lease_expires_at !== claim.lease_expires_at ||
    owner.pid !== claim.pid
  ) throw new Error("claim owner changed during reconciliation");
  const executionRecordPath = join(options.stateDir, `exec-${claim.execution_id}.json`);
  const terminal = validateFactoryStateClaimTerminalProof(owner, executionRecordPath);
  const targetPath = claimRelativePath(claim);
  if (path !== join(options.stateDir, targetPath)) throw new Error("claim path is not the exact ticket-derived path");
  const binding = claimBinding(options.stateDir, "ticket-claim-reaper");
  assertFactoryStateMutationMayProceed(options.mutationEvidenceMode ?? factoryStateMutationEvidenceMode(), binding);
  const prepared = createFactoryStateMutationReceipt({
    action: "claim-release",
    binding,
    target_path: targetPath,
    target_schema: "ticket-claim-owner/v1",
    before_payload: ownerPayload,
    after_payload: "",
    allowed_transitions: ["$claim_removed"],
    recorded_at: new Date(options.nowMs ?? Date.now()).toISOString(),
    claim_release: {
      stage: "prepared",
      claim_key: ticketClaimKey(claim.ticket_id),
      claim_directory_path: targetPath,
      owner_path: `${targetPath}/owner.json`,
      owner_sha256: factoryStateMutationPayloadSha256(ownerPayload),
      owner,
      terminal,
    },
  });
  result.evidence_receipts.push(writeFactoryStateMutationReceipt(prepared, { stateDir: options.stateDir }));
  if (options.interruptAfterStage === "prepared") throw new ClaimReleaseInterruption("interrupted after prepared claim-release receipt");
  unlinkSync(ownerPath);
  rmdirSync(path);
  syncDirectory(claimRoot(options.stateDir));
  if (options.interruptAfterStage === "claim-removed") throw new ClaimReleaseInterruption("interrupted after exact claim removal");
  const committed = createFactoryStateMutationReceipt({
    action: "claim-release",
    binding,
    target_path: targetPath,
    target_schema: "ticket-claim-owner/v1",
    before_payload: ownerPayload,
    after_payload: "",
    allowed_transitions: ["$claim_removed"],
    recorded_at: new Date((options.nowMs ?? Date.now()) + 1).toISOString(),
    claim_release: {
      ...prepared.claim_release!,
      stage: "committed",
      prepared_receipt_id: prepared.receipt_id,
    },
  });
  result.evidence_receipts.push(writeFactoryStateMutationReceipt(committed, { stateDir: options.stateDir }));
}

function loadClaimReleaseReceipts(stateDir: string): Array<{ path: string; receipt: FactoryStateMutationReceipt }> {
  const root = join(stateDir, FACTORY_STATE_MUTATION_EVIDENCE_ROOT);
  if (!existsSync(root)) return [];
  const receipts: Array<{ path: string; receipt: FactoryStateMutationReceipt }> = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const path = join(root, entry.name);
    const receipt = readFactoryStateMutationReceipt(path);
    if (receipt.action === "claim-release") receipts.push({ path, receipt });
  }
  return receipts;
}

function recoverPreparedClaimReleases(
  options: ReconcileTicketClaimsOptions,
  mode: FactoryStateMutationEvidenceMode,
  result: TicketClaimReconcileResult,
): Set<string> {
  const blockedTicketIds = new Set<string>();
  if (mode === "off" || options.dryRun) return blockedTicketIds;
  let receipts: ReturnType<typeof loadClaimReleaseReceipts>;
  try {
    receipts = loadClaimReleaseReceipts(options.stateDir);
  } catch (error) {
    result.failed++;
    result.would_reject.push({ ticket_id: "unknown", reason: `claim receipt recovery failed: ${error instanceof Error ? error.message : String(error)}` });
    if (mode === "enforce") blockedTicketIds.add("*");
    return blockedTicketIds;
  }
  const committedPreparedIds = new Set(
    receipts
      .filter(({ receipt }) => receipt.claim_release?.stage === "committed")
      .map(({ receipt }) => receipt.claim_release!.prepared_receipt_id!),
  );
  const unresolved = receipts.filter(({ receipt }) =>
    receipt.claim_release?.stage === "prepared" && !committedPreparedIds.has(receipt.receipt_id)
  );
  const unresolvedCounts = new Map<string, number>();
  for (const { receipt } of unresolved) {
    unresolvedCounts.set(receipt.target_path, (unresolvedCounts.get(receipt.target_path) ?? 0) + 1);
  }
  for (const loaded of unresolved) {
    const prepared = loaded.receipt;
    const proof = prepared.claim_release!;
    blockedTicketIds.add(proof.owner.ticket_id);
    if (unresolvedCounts.get(prepared.target_path) !== 1) {
      result.failed++;
      result.would_reject.push({
        ticket_id: proof.owner.ticket_id,
        reason: "prepared claim release is ambiguous",
      });
      continue;
    }
    try {
      const stateRoot = resolve(options.stateDir);
      const target = resolve(stateRoot, prepared.target_path);
      const targetRelative = relative(stateRoot, target);
      if (targetRelative.startsWith("..") || targetRelative !== prepared.target_path) throw new Error("prepared claim path escapes state root");
      if (target !== join(stateRoot, "ticket-claims", proof.claim_key)) throw new Error("prepared claim path does not match claim key");
      if (proof.terminal.execution_record_path !== join(stateRoot, `exec-${proof.owner.execution_id}.json`)) {
        throw new Error("prepared terminal record path is not the exact factory execution record");
      }
      const terminal = validateFactoryStateClaimTerminalProof(proof.owner, proof.terminal.execution_record_path);
      if (
        terminal.execution_record_sha256 !== proof.terminal.execution_record_sha256 ||
        terminal.lifecycle_state !== proof.terminal.lifecycle_state
      ) throw new Error("terminal execution proof changed after prepare");
      if (existsSync(target)) {
        exactClaimEntries(target);
        const currentOwner = readFileSync(join(target, "owner.json"), "utf8");
        if (factoryStateMutationPayloadSha256(currentOwner) !== prepared.before_sha256 || currentOwner !== prepared.before_payload) {
          throw new Error("claim owner changed after prepare");
        }
        unlinkSync(join(target, "owner.json"));
        rmdirSync(target);
        syncDirectory(claimRoot(options.stateDir));
      }
      const committed = createFactoryStateMutationReceipt({
        action: "claim-release",
        binding: prepared.binding,
        target_path: prepared.target_path,
        target_schema: "ticket-claim-owner/v1",
        before_payload: prepared.before_payload,
        after_payload: "",
        allowed_transitions: ["$claim_removed"],
        recorded_at: new Date(options.nowMs ?? Date.now()).toISOString(),
        claim_release: {
          ...proof,
          stage: "committed",
          prepared_receipt_id: prepared.receipt_id,
        },
      });
      result.evidence_receipts.push(writeFactoryStateMutationReceipt(committed, { stateDir: options.stateDir }));
      result.recovered.push(proof.owner.ticket_id);
      result.reclaimed.push(proof.owner.ticket_id);
      blockedTicketIds.delete(proof.owner.ticket_id);
    } catch (error) {
      result.failed++;
      result.would_reject.push({
        ticket_id: proof.owner.ticket_id,
        reason: `prepared claim release could not recover: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return blockedTicketIds;
}

export function reconcileExpiredTicketClaims(options: ReconcileTicketClaimsOptions): TicketClaimReconcileResult {
  const root = claimRoot(options.stateDir);
  const result: TicketClaimReconcileResult = {
    scanned: 0,
    reclaimed: [],
    planned: [],
    kept: 0,
    failed: 0,
    evidence_receipts: [],
    recovered: [],
    would_reject: [],
  };
  const mode = options.mutationEvidenceMode ?? factoryStateMutationEvidenceMode();
  const blockedTicketIds = recoverPreparedClaimReleases(options, mode, result);
  if (!existsSync(root)) return result;

  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    result.failed++;
    return result;
  }

  const nowMs = options.nowMs ?? Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      result.failed++;
      continue;
    }
    const path = join(root, entry.name);
    result.scanned++;
    let claim: TicketClaimRecord;
    try {
      claim = readClaim(path);
    } catch {
      result.failed++;
      continue;
    }
    if (blockedTicketIds.has("*") || blockedTicketIds.has(claim.ticket_id)) {
      result.kept++;
      continue;
    }
    if (Date.parse(claim.lease_expires_at) > nowMs || options.executionAlive?.(claim)) {
      result.kept++;
      continue;
    }
    if (options.dryRun) {
      result.planned.push(claim.ticket_id);
      continue;
    }
    try {
      if (mode === "off") {
        rmSync(path, { recursive: true, force: false });
      } else {
        releaseClaimWithEvidence(path, claim, options, result);
      }
      result.reclaimed.push(claim.ticket_id);
    } catch (error) {
      if (error instanceof ClaimReleaseInterruption) {
        result.failed++;
        continue;
      }
      const reason = error instanceof Error ? error.message : String(error);
      result.would_reject.push({ ticket_id: claim.ticket_id, reason });
      if (mode === "shadow") {
        try {
          rmSync(path, { recursive: true, force: false });
          result.reclaimed.push(claim.ticket_id);
          continue;
        } catch {
          result.failed++;
          continue;
        }
      }
      result.failed++;
    }
  }
  return result;
}
