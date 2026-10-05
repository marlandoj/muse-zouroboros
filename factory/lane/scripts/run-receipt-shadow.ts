import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import {
  canonicalize,
  CONTRACT_ID,
  RECEIPT_SCHEMA_VERSION,
  type AttemptStatus,
  type RunReceipt,
  type SideEffectKind,
  type TerminalOutcome,
  type TriggerKind,
} from "./run-receipt-contract";
import {
  createEdgeProofPlan,
  EdgeProofError,
  MAX_EDGE_PROOF_TOTAL_POLL_MS,
  probeEdgeOnce,
  type EdgeAdapterKind,
  type EdgeProofAdapter,
  type EdgeProofObservation,
  type EdgeProofPlan,
} from "./run-edge-proof";
import {
  OperationJournal,
  type JournalAuthority,
  type ObservationalEffectSource,
} from "./run-operation-journal";
import {
  loadReceiptShadowExternalConfig,
  RECEIPT_SHADOW_EXTERNAL_CONFIG_ENV,
  type ReceiptShadowExternalConfig,
} from "./runtime-config";
import { parsePolicy } from "../../../Skills/zouroboros-governance/scripts/autonomy-classifier";

export const RECEIPT_SHADOW_CONTRACT_ID = "zouroboros-run-receipt-shadow/v1" as const;
export const RECEIPT_SHADOW_MODES = ["off", "shadow"] as const;
export const RECEIPT_SHADOW_RUN_CLASSES = ["scheduled_agent", "factory_execution", "external_side_effect"] as const;

export type ReceiptShadowMode = typeof RECEIPT_SHADOW_MODES[number];
export type ReceiptShadowRunClass = typeof RECEIPT_SHADOW_RUN_CLASSES[number];

interface ShadowRegistryProducer {
  id: string;
  run_class: ReceiptShadowRunClass;
  source: string;
  trigger_kind: TriggerKind;
  edge_adapter: EdgeAdapterKind;
  edge_adapter_version: string;
  edge_requirement: "required";
}

interface ShadowRegistry {
  contract_id: typeof RECEIPT_SHADOW_CONTRACT_ID;
  version: number;
  producers: ShadowRegistryProducer[];
}

export interface ShadowObservedEffect {
  adapterKind: string;
  sideEffectKind: SideEffectKind;
  target: string;
  input: unknown;
  authorityScope: string;
  source: ObservationalEffectSource;
  evidence: unknown;
}

export interface ShadowEdgeInput {
  targetId: string;
  expectedState: unknown;
  createdAt: string;
  deadline: string;
  maxAttempts?: number;
  probeTimeoutMs?: number;
  pollIntervalMs?: number;
}

export interface BeginShadowRunInput {
  producerId: string;
  runClass: ReceiptShadowRunClass;
  idempotencyKey: string;
  intent: unknown;
  triggerIdentity: string;
  authority: JournalAuthority;
  attemptN?: number;
  observedEffect: ShadowObservedEffect;
  edge: ShadowEdgeInput;
}

export interface CompleteShadowRunInput {
  producerId: string;
  runClass: ReceiptShadowRunClass;
  idempotencyKey: string;
  authority: JournalAuthority;
  attemptN?: number;
  attemptStatus: AttemptStatus;
  error?: string | null;
  retryReason?: string | null;
  retryable?: boolean;
  observedEffect?: ShadowObservedEffect;
  terminalOutcome?: TerminalOutcome | null;
  reasonCode: string;
  policyVersion?: string | null;
  sourceRevision?: string | null;
  artifacts?: RunReceipt["terminal"]["artifacts"];
  ledgerEntries?: RunReceipt["terminal"]["ledger_entries"];
}

export type ShadowWriteResult =
  | { mode: "off"; status: "off" }
  | { mode: "shadow"; status: "recorded" | "held" | "nonterminal" | "dangling"; operationId: string | null; receiptHash?: string; reasonCode?: string; producerOverheadMs: number }
  | { mode: "shadow"; status: "error"; operationId: string | null; reasonCode: string; producerOverheadMs: number };

export interface HarvestEdgeProofsInput {
  adapters: EdgeProofAdapter[];
  authority: JournalAuthority;
  now?: () => string;
  maxPlans?: number;
}

export interface HarvestEdgeProofsResult {
  mode: ReceiptShadowMode;
  scanned: number;
  appended: number;
  supplemented: number;
  errors: Array<{ planId: string; reasonCode: string }>;
}

const SHA256 = /^[0-9a-f]{64}$/;
const ZERO_SHA256 = "0".repeat(64);
export const RECEIPT_SHADOW_WRITE_HIGH_WATER_BYTES = 56 * 1024 * 1024;

function externalConfig(env: Record<string, string | undefined>): ReceiptShadowExternalConfig | null {
  const path = env[RECEIPT_SHADOW_EXTERNAL_CONFIG_ENV];
  if (!path) return null;
  const testRoot = env.NODE_ENV === "test" ? env.FACTORY_RECEIPT_SHADOW_TEST_ROOT : undefined;
  const loaded = loadReceiptShadowExternalConfig(path, testRoot ? { testRoot } : {});
  if (!loaded.ok) throw new Error(loaded.errors.join("; "));
  return loaded.config;
}

export function receiptShadowConfig(env: Record<string, string | undefined> = process.env): ReceiptShadowExternalConfig | null {
  return externalConfig(env);
}

interface ShadowBinding {
  config: ReceiptShadowExternalConfig;
  authority: JournalAuthority;
  registry: ShadowRegistry;
}

function noneAuthority(): JournalAuthority {
  return {
    envelopeKind: "none",
    approvingAuthority: null,
    approvalTs: null,
    approvalRef: null,
    autonomyTier: "T0",
    authorizationEvidenceRef: null,
    scopes: [],
    expiresAt: null,
  };
}

function deriveShadowBinding(config: ReceiptShadowExternalConfig, env: Record<string, string | undefined>): ShadowBinding {
  if (config.mode !== "shadow") throw new Error("receipt shadow config is not active");
  const policyBytes = readFileSync(config.policy_path);
  if (createHash("sha256").update(policyBytes).digest("hex") !== config.policy_sha256) throw new Error("receipt shadow policy hash mismatch");
  const policy = parsePolicy(JSON.parse(policyBytes.toString("utf8")) as unknown);
  if (!policy) throw new Error("receipt shadow policy is invalid");
  const registryBytes = readFileSync(config.registry_path);
  if (createHash("sha256").update(registryBytes).digest("hex") !== config.registry_sha256) throw new Error("receipt shadow registry hash mismatch");
  const registry = JSON.parse(registryBytes.toString("utf8")) as ShadowRegistry;
  if (registry.contract_id !== RECEIPT_SHADOW_CONTRACT_ID || registry.version !== 1 || !Array.isArray(registry.producers)) {
    throw new Error("receipt shadow registry contract is invalid");
  }
  const grant = policy.receipt_shadow;
  const requiredScopes = ["operation.reserve", "observe:workspace", "observe:github"];
  const bound = SHA256.test(config.activation_manifest_sha256)
    && config.activation_manifest_sha256 !== ZERO_SHA256
    && config.effective_config_sha256 !== ZERO_SHA256
    && env.FACTORY_RECEIPT_SHADOW_MODE === "shadow"
    && env.FACTORY_RECEIPT_SHADOW_AUTOMATION_ID === config.automation_id
    && env.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH === config.activation_manifest_sha256
    && env.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH === config.effective_config_sha256
    && grant?.enabled === true
    && grant.mode === "shadow"
    && canonicalize(grant.allowed_runtimes) === canonicalize([config.runtime])
    && canonicalize(grant.automation_ids) === canonicalize([config.automation_id])
    && canonicalize([...grant.scopes].sort()) === canonicalize([...requiredScopes].sort());
  if (!bound) throw new Error("receipt shadow authority unavailable");
  return {
    config,
    registry,
    authority: {
      envelopeKind: "receipt_authority",
      approvingAuthority: "human-operator",
      approvalTs: null,
      approvalRef: `activation-manifest:sha256:${config.activation_manifest_sha256}`,
      autonomyTier: "T0",
      authorizationEvidenceRef: `receipt-config:sha256:${config.effective_config_sha256};policy:sha256:${config.policy_sha256}`,
      scopes: requiredScopes,
      expiresAt: null,
    },
  };
}

export function shadowAuthority(
  env: Record<string, string | undefined> = process.env,
): JournalAuthority {
  try {
    const config = externalConfig(env);
    return config ? deriveShadowBinding(config, env).authority : noneAuthority();
  } catch {
    return noneAuthority();
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function elapsedMs(started: number): number {
  return Math.max(0, Number((performance.now() - started).toFixed(3)));
}

function requireShadowBinding(authority: JournalAuthority, config: ReceiptShadowExternalConfig | null, env: Record<string, string | undefined>): ShadowBinding {
  if (!config) throw new Error("receipt shadow requires an active external config");
  const binding = deriveShadowBinding(config, env);
  if (canonicalize(authority) !== canonicalize(binding.authority)) throw new Error("receipt shadow authority mismatch");
  return binding;
}

export function receiptShadowMode(env: Record<string, string | undefined> = process.env): ReceiptShadowMode {
  const config = externalConfig(env);
  return configuredMode(config, env);
}

function configuredMode(config: ReceiptShadowExternalConfig | null, env: Record<string, string | undefined>): ReceiptShadowMode {
  const value = config?.mode ?? env.FACTORY_RECEIPT_SHADOW_MODE;
  if (!value || value === "off") return "off";
  if (value === "shadow") return value;
  throw new Error(`invalid FACTORY_RECEIPT_SHADOW_MODE ${value}`);
}

function shadowPaths(config: ReceiptShadowExternalConfig): {
  dbPath: string;
  registryPath: string;
  registrySha256: string;
  maxPlansPerHarvest: number;
  writeHighWaterBytes: number;
  maxDatabaseBytes: number;
} {
  if (config.mode !== "shadow") throw new Error("receipt shadow requires an active external config");
  return {
    dbPath: config.database_path,
    registryPath: config.registry_path,
    registrySha256: config.registry_sha256,
    maxPlansPerHarvest: config.max_plans_per_harvest,
    writeHighWaterBytes: config.write_high_water_bytes,
    maxDatabaseBytes: config.max_database_bytes,
  };
}

function shadowWriteCapacityReason(dbPath: string, highWaterBytes: number, maxDatabaseBytes: number): string | null {
  const bytes = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]
    .reduce((sum, candidate) => sum + (existsSync(candidate) ? statSync(candidate).size : 0), 0);
  if (bytes >= maxDatabaseBytes) return "receipt_shadow_database_limit";
  return bytes >= highWaterBytes ? "receipt_shadow_database_high_water" : null;
}

function registeredProducer(registry: ShadowRegistry, producerId: string, runClass: ReceiptShadowRunClass): ShadowRegistryProducer {
  const producer = registry.producers.find((entry) => entry.id === producerId);
  if (!producer || producer.run_class !== runClass) throw new Error(`unregistered receipt shadow producer ${producerId}`);
  return producer;
}

function scopeFor(runClass: ReceiptShadowRunClass): string {
  return `receipt-shadow:${runClass}`;
}

function edgePlan(operationId: string, producer: ShadowRegistryProducer, input: BeginShadowRunInput): EdgeProofPlan {
  const traceHash = sha256(`${input.runClass}\0${input.idempotencyKey}`);
  return createEdgeProofPlan({
    operationId,
    traceId: traceHash.slice(0, 32),
    actorHash: sha256(input.producerId),
    verifierIdentityHash: sha256(`receipt-shadow-readback:${producer.edge_adapter}`),
    adapterKind: producer.edge_adapter,
    adapterVersion: producer.edge_adapter_version,
    targetId: input.edge.targetId,
    expectedStateHash: sha256(canonicalize(input.edge.expectedState)),
    requirement: producer.edge_requirement,
    preRegisteredNoSideEffects: false,
    declaredExternalEffects: 1,
    createdAt: input.edge.createdAt,
    deadline: input.edge.deadline,
    maxAttempts: input.edge.maxAttempts ?? 12,
    probeTimeoutMs: input.edge.probeTimeoutMs ?? 5_000,
    pollIntervalMs: input.edge.pollIntervalMs ?? 5_000,
  });
}

function importEffect(
  journal: OperationJournal,
  operationId: string,
  attemptN: number,
  authority: JournalAuthority,
  effect: ShadowObservedEffect,
): void {
  const result = journal.importObservedEffect(operationId, {
    attemptN,
    adapterKind: effect.adapterKind,
    sideEffectKind: effect.sideEffectKind,
    target: effect.target,
    input: effect.input,
    reversible: false,
    rollbackRef: null,
    authorityScope: effect.authorityScope,
  }, authority, effect.source, effect.evidence);
  if (result.status === "held") throw new Error(result.reasonCode ?? "observational effect held");
}

function receiptTemplate(input: CompleteShadowRunInput, operationId: string): RunReceipt {
  const identityHash = sha256(`${input.runClass}\0${input.idempotencyKey}`);
  return {
    contract_id: CONTRACT_ID,
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: "rr-00000000000000000000000000",
    operation_id: operationId,
    idempotency_key: input.idempotencyKey,
    receipt_hash: "0".repeat(64),
    trigger: {
      kind: "factory",
      identity: input.producerId,
      intent: input.idempotencyKey,
      input_hash: "0".repeat(64),
      ts: new Date(0).toISOString(),
    },
    lineage: {
      parent_receipt_id: null,
      trace_id: identityHash.slice(0, 32),
      span_id: identityHash.slice(32, 48),
      inherited_state_refs: input.sourceRevision ? [`git:${input.sourceRevision}`] : [],
      wave_id: "phase-b-zou-1055",
      seed_id: "seed-phase-b-zou-1055-shadow-receipts-2026-08-11",
    },
    versions: {
      contract_version: CONTRACT_ID,
      policy_version: input.policyVersion ?? null,
      model_versions: {},
      tool_versions: input.sourceRevision ? { source_revision: input.sourceRevision } : {},
      schema_migrations: [],
    },
    authority: {
      envelope_kind: input.authority.envelopeKind,
      approving_authority: input.authority.approvingAuthority,
      approval_ts: input.authority.approvalTs,
      approval_ref: input.authority.approvalRef,
      autonomy_tier: input.authority.autonomyTier,
      authorization_evidence_ref: input.authority.authorizationEvidenceRef,
    },
    events: [],
    attempts: [],
    terminal: {
      outcome: input.terminalOutcome ?? "held",
      committed_state_hash: "0".repeat(64),
      artifacts: input.artifacts ?? [],
      ledger_entries: input.ledgerEntries ?? [],
    },
    acknowledgements: {
      accepted: {
        kind: "accepted",
        event_id: "evt-placeholder",
        ts: new Date(0).toISOString(),
        evidence_ref: "receipt-shadow-placeholder",
      },
      completed: null,
      user_visible: null,
    },
    verification: {
      verifier_identity: "receipt-shadow-harvester",
      verifier_org_separate: true,
      checks: [],
      edge_proof: { chain_ok: true, anchor_ok: true, ledger_head: null },
    },
    observation: { user_visible_outcome: null, user_confirmed: null, feedback_ref: null },
    ts_created: new Date(0).toISOString(),
    ts_terminal: new Date(0).toISOString(),
  };
}

export function beginShadowRun(
  input: BeginShadowRunInput,
  env: Record<string, string | undefined> = process.env,
): ShadowWriteResult {
  const started = performance.now();
  let operationId: string | null = null;
  let journal: OperationJournal | undefined;
  try {
    const config = externalConfig(env);
    if (configuredMode(config, env) === "off") return { mode: "off", status: "off" };
    const binding = requireShadowBinding(input.authority, config, env);
    const authority = binding.authority;
    const paths = shadowPaths(binding.config);
    const capacityReason = shadowWriteCapacityReason(paths.dbPath, paths.writeHighWaterBytes, paths.maxDatabaseBytes);
    if (capacityReason) return { mode: "shadow", status: "held", operationId: null, reasonCode: capacityReason, producerOverheadMs: elapsedMs(started) };
    const producer = registeredProducer(binding.registry, input.producerId, input.runClass);
    journal = new OperationJournal(paths.dbPath);
    const reserved = journal.reserve({
      scope: scopeFor(input.runClass),
      idempotencyKey: input.idempotencyKey,
      intent: input.intent,
      triggerKind: producer.trigger_kind,
      triggerIdentity: input.triggerIdentity,
      authority,
      sourceWriter: input.observedEffect.source.writer,
      sourceEventId: `${input.producerId}:${input.idempotencyKey}:accepted`,
    });
    if (reserved.status === "held") {
      return { mode: "shadow", status: "held", operationId: null, reasonCode: reserved.reasonCode, producerOverheadMs: elapsedMs(started) };
    }
    operationId = reserved.operationId;
    journal.assertOperationAuthority(operationId, authority);
    const attemptN = input.attemptN ?? 1;
    journal.beginAttempt(operationId, attemptN, { producerOverheadMs: elapsedMs(started) });
    importEffect(journal, operationId, attemptN, authority, input.observedEffect);
    journal.registerEdgeProofPlan(edgePlan(operationId, producer, input));
    return { mode: "shadow", status: "recorded", operationId, producerOverheadMs: elapsedMs(started) };
  } catch (error) {
    return { mode: "shadow", status: "error", operationId, reasonCode: error instanceof Error ? error.message : String(error), producerOverheadMs: elapsedMs(started) };
  } finally {
    journal?.close();
  }
}

export function completeShadowRun(
  input: CompleteShadowRunInput,
  env: Record<string, string | undefined> = process.env,
): ShadowWriteResult {
  const started = performance.now();
  let operationId: string | null = null;
  let journal: OperationJournal | undefined;
  try {
    const config = externalConfig(env);
    if (configuredMode(config, env) === "off") return { mode: "off", status: "off" };
    const binding = requireShadowBinding(input.authority, config, env);
    const authority = binding.authority;
    const paths = shadowPaths(binding.config);
    const capacityReason = shadowWriteCapacityReason(paths.dbPath, paths.writeHighWaterBytes, paths.maxDatabaseBytes);
    if (capacityReason) return { mode: "shadow", status: "held", operationId: null, reasonCode: capacityReason, producerOverheadMs: elapsedMs(started) };
    registeredProducer(binding.registry, input.producerId, input.runClass);
    if (!existsSync(paths.dbPath)) {
      return { mode: "shadow", status: "dangling", operationId: null, reasonCode: "accepted_operation_missing", producerOverheadMs: elapsedMs(started) };
    }
    journal = new OperationJournal(paths.dbPath, { create: false });
    const reserved = journal.findOperation(scopeFor(input.runClass), input.idempotencyKey);
    if (!reserved) return { mode: "shadow", status: "dangling", operationId: null, reasonCode: "accepted_operation_missing", producerOverheadMs: elapsedMs(started) };
    operationId = reserved.operationId;
    journal.assertOperationAuthority(operationId, authority);
    const attemptN = input.attemptN ?? 1;
    if (input.observedEffect) importEffect(journal, operationId, attemptN, authority, input.observedEffect);
    const overhead = elapsedMs(started);
    journal.completeAttempt(operationId, attemptN, input.attemptStatus, input.error ?? null, input.retryReason ?? null, { producerOverheadMs: overhead });
    if (input.retryable) {
      if (input.terminalOutcome) throw new Error("retryable attempt cannot terminalize the operation");
      return { mode: "shadow", status: "nonterminal", operationId, producerOverheadMs: elapsedMs(started) };
    }
    if (!input.terminalOutcome) return { mode: "shadow", status: "nonterminal", operationId, producerOverheadMs: elapsedMs(started) };
    const receipt = journal.terminalize(operationId, input.terminalOutcome, input.reasonCode, receiptTemplate(input, operationId));
    return { mode: "shadow", status: "recorded", operationId, receiptHash: receipt.receipt_hash, producerOverheadMs: elapsedMs(started) };
  } catch (error) {
    return { mode: "shadow", status: "error", operationId, reasonCode: error instanceof Error ? error.message : String(error), producerOverheadMs: elapsedMs(started) };
  } finally {
    journal?.close();
  }
}

export async function harvestEdgeProofs(
  input: HarvestEdgeProofsInput,
  env: Record<string, string | undefined> = process.env,
): Promise<HarvestEdgeProofsResult> {
  const config = externalConfig(env);
  if (configuredMode(config, env) === "off") return { mode: "off", scanned: 0, appended: 0, supplemented: 0, errors: [] };
  const binding = requireShadowBinding(input.authority, config, env);
  const authority = binding.authority;
  const paths = shadowPaths(binding.config);
  const capacityReason = shadowWriteCapacityReason(paths.dbPath, paths.writeHighWaterBytes, paths.maxDatabaseBytes);
  if (capacityReason) return { mode: "shadow", scanned: 0, appended: 0, supplemented: 0, errors: [{ planId: "journal", reasonCode: capacityReason }] };
  const journal = new OperationJournal(paths.dbPath, { create: false });
  const result: HarvestEdgeProofsResult = { mode: "shadow", scanned: 0, appended: 0, supplemented: 0, errors: [] };
  const startedAt = performance.now();
  try {
    const currentTime = (input.now ?? (() => new Date().toISOString()))();
    const rows = journal.db.query(`
      SELECT p.canonical_plan
      FROM edge_proof_plans p
      LEFT JOIN edge_proof_observations o
        ON o.commit_sequence = (
          SELECT MAX(latest.commit_sequence)
          FROM edge_proof_observations latest
          WHERE latest.plan_id = p.plan_id
        )
      WHERE o.plan_id IS NULL
         OR (o.status = 'retryable' AND o.next_poll_at IS NOT NULL AND o.next_poll_at <= ?)
      ORDER BY p.created_at
      LIMIT ?
    `)
      .all(currentTime, Math.max(1, Math.min(input.maxPlans ?? paths.maxPlansPerHarvest, paths.maxPlansPerHarvest, 12))) as Array<{ canonical_plan: string }>;
    for (const row of rows) {
      const plan = JSON.parse(row.canonical_plan) as EdgeProofPlan;
      result.scanned++;
      try {
        if (performance.now() - startedAt + plan.probe_timeout_ms > MAX_EDGE_PROOF_TOTAL_POLL_MS) {
          result.errors.push({ planId: plan.plan_id, reasonCode: "harvest_deadline_exhausted" });
          break;
        }
        if (!binding.registry.producers.some((producer) => producer.edge_adapter === plan.adapter.kind && producer.edge_adapter_version === plan.adapter.version)) {
          throw new Error("edge adapter is not registered");
        }
        const adapter = input.adapters.find((candidate) => candidate.kind === plan.adapter.kind && candidate.version === plan.adapter.version);
        if (!adapter) throw new Error("edge adapter is unavailable");
        const prior = (journal.db.query("SELECT canonical_observation FROM edge_proof_observations WHERE plan_id = ? ORDER BY attempt")
          .all(plan.plan_id) as Array<{ canonical_observation: string }>).map((entry) => JSON.parse(entry.canonical_observation) as EdgeProofObservation);
        if (prior.at(-1)?.status === "confirmed") continue;
        const observation = await probeEdgeOnce(plan, prior, adapter, authority, (input.now ?? (() => new Date().toISOString()))());
        journal.appendEdgeProofObservation(plan, observation);
        result.appended++;
        if (journal.receipt(plan.operation_id) && (observation.status !== "retryable" || observation.next_poll_at === null)) {
          journal.appendEdgeProofSupplement(plan, observation);
          result.supplemented++;
        }
      } catch (error) {
        result.errors.push({ planId: plan.plan_id, reasonCode: error instanceof EdgeProofError ? error.code : "edge_harvest_failed" });
      }
    }
    return result;
  } finally {
    journal.close();
  }
}
