/** Cap-one Hermes executor child. Only the root supervisor supplies authority.
 * The retained claim remains held; a separately pinned execution approval and
 * private live supervisor channel authorize this one contained invocation.
 */
import { createHash } from "node:crypto";
import { fstatSync, lstatSync, readFileSync, readSync, writeSync } from "node:fs";
import { Database } from "bun:sqlite";
import { admitHeldHermesWork } from "./factory-work-contract";
import { factoryClaimStorageKeyV2 } from "./factory-claim-identity";
import type { FactoryExecutionSubject } from "./factory-execution-subject";
import { runExecutorChain, type ExecutorChainOptions } from "./executor-runner";
import { runHarness } from "./harness-router";
import { OperationJournal, type CrashBoundary, type JournalAuthority } from "./run-operation-journal";
import { canonicalize, CONTRACT_ID, RECEIPT_SCHEMA_VERSION, type RunReceipt } from "./run-receipt-contract";

const SCOPE = "factory.hermes.contained-execution/v1";
const INVOKE = "factory.hermes.execute-once";
const REF = "hermes:contained-execution/v1";
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function fail(): never { throw new Error("HERMES_EXECUTION_HELD"); }

export interface ExecutionPacket {
  schema: "hermes-contained-execution/v1";
  plan_sha256: string;
  source_head: string;
  execution_id: string;
  journal_path: string;
  journal_identity: [number, number];
  worker_uid: number;
  worker_gid: number;
  workdir: string;
  harness: "codex" | "claude-code";
  model: string;
  timeout_ms: number;
  approved_at_ms: number;
  expires_at_ms: number;
  claim: {
    receipt: { schema: string; transition: string; request_id: string; key: string; provider: string;
      factory_work_id: string; generation: number; owner: string;
      reader_admission_proof: { schema: string; opaque_sha256: string };
      lease_started_ms: number; lease_expires_ms: number; requested_lease_ms: number;
      transition_sequence: number; recorded_at_ms: number };
    retained_work: { schema: string; work: unknown; work_sha256: string; authority_artifact_sha256: string;
      reader_proof_sha256: string; claim_receipt_sha256: string; snapshot_sha256: string;
      receipt_sha256: string; board_identity_sha256: string; high_water_sha256: string;
      claim_eligible: false; dispatch_eligible: false };
  };
}
interface Dependencies {
  fence(stage: "reserve" | "launch", binding: string): void;
  now?: () => number;
  harnessRun?: ExecutorChainOptions["harnessRun"];
  healthProbe?: ExecutorChainOptions["healthProbe"];
  crashInjector?: (boundary: CrashBoundary) => void;
}
export interface ContainedExecutionResult {
  schema: "hermes-contained-execution-result/v1";
  status: "held";
  operation_id: string;
  execution_id: string;
  factory_work_id: string;
  receipt_sha256: string | null;
  replay: boolean;
  dispatch_eligible: false;
}
function immutable<T>(value: T): T {
  const copied = JSON.parse(JSON.stringify(value)) as T;
  function freeze(item: unknown) { if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); } }
  freeze(copied); return copied;
}
function template(operation: string, key: string, packet: ExecutionPacket, authority: JournalAuthority, evidence: unknown): RunReceipt {
  const artifact = canonicalize(evidence);
  return {
    contract_id: CONTRACT_ID, schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: "rr-00000000000000000000000000", operation_id: operation,
    idempotency_key: key, receipt_hash: "0".repeat(64),
    trigger: { kind: "factory", identity: "hermes-contained-execution", intent: key, input_hash: "0".repeat(64), ts: new Date(0).toISOString() },
    lineage: { parent_receipt_id: null, trace_id: key.slice(0, 32), span_id: key.slice(32, 48),
      inherited_state_refs: [`git:${packet.source_head}`, `sha256:${packet.claim.retained_work.authority_artifact_sha256}`], wave_id: null, seed_id: null },
    versions: { contract_version: CONTRACT_ID, policy_version: packet.plan_sha256, model_versions: { executor: packet.model },
      tool_versions: { source_revision: packet.source_head }, schema_migrations: [] },
    authority: { envelope_kind: authority.envelopeKind, approving_authority: authority.approvingAuthority,
      approval_ts: authority.approvalTs, approval_ref: authority.approvalRef, autonomy_tier: authority.autonomyTier,
      authorization_evidence_ref: authority.authorizationEvidenceRef }, events: [], attempts: [],
    terminal: { outcome: "held", committed_state_hash: "0".repeat(64), ledger_entries: [],
      artifacts: [{ kind: "evaluation", ref: REF, hash: digest(artifact), description: artifact }] },
    acknowledgements: { accepted: { kind: "accepted", event_id: "evt-placeholder", ts: new Date(0).toISOString(), evidence_ref: REF }, completed: null, user_visible: null },
    verification: { verifier_identity: "hermes-contained-execution", verifier_org_separate: false,
      checks: [], edge_proof: { chain_ok: true, anchor_ok: true, ledger_head: null } },
    observation: { user_visible_outcome: null, user_confirmed: null, feedback_ref: null },
    ts_created: new Date(0).toISOString(), ts_terminal: new Date(0).toISOString(),
  };
}
async function execute(input: ExecutionPacket, dependencies: Dependencies): Promise<ContainedExecutionResult> {
  const packet = immutable(input), now = dependencies.now ?? Date.now;
  const retained = packet.claim?.retained_work, receipt = packet.claim?.receipt;
  if (packet.schema !== "hermes-contained-execution/v1" || !hex(packet.plan_sha256)
    || !/^[a-f0-9]{40}$/.test(packet.source_head) || !/^exec-[A-Za-z0-9_.:-]{1,120}$/.test(packet.execution_id)
    || !["codex", "claude-code"].includes(packet.harness) || !/^[A-Za-z0-9_.:-]{1,128}$/.test(packet.model)
    || !Number.isSafeInteger(packet.timeout_ms) || packet.timeout_ms < 1 || packet.timeout_ms > 120_000
    || ![packet.worker_uid, packet.worker_gid, packet.approved_at_ms, packet.expires_at_ms].every(Number.isSafeInteger)
    || packet.worker_uid <= 0 || packet.worker_gid <= 0 || packet.approved_at_ms <= 0
    || packet.expires_at_ms <= packet.approved_at_ms || packet.expires_at_ms - packet.approved_at_ms > 3_600_000
    || !retained || retained.schema !== "held-claim-selected-work/v1" || retained.claim_eligible !== false || retained.dispatch_eligible !== false
    || [retained.work_sha256, retained.authority_artifact_sha256, retained.reader_proof_sha256, retained.claim_receipt_sha256,
      retained.snapshot_sha256, retained.receipt_sha256, retained.board_identity_sha256, retained.high_water_sha256].some(x => !hex(x))
    || digest(canonicalize(retained.work)) !== retained.work_sha256 || digest(canonicalize(receipt)) !== retained.claim_receipt_sha256) fail();
  const [work] = await admitHeldHermesWork([retained.work]);
  if (!work || work.source_status !== "ready" || receipt.schema !== "factory-claim-receipt/v2" || receipt.transition !== "acquire"
    || receipt.provider !== "hermes" || receipt.factory_work_id !== work.factory_work_id
    || receipt.key !== factoryClaimStorageKeyV2({ schema: "factory-claim-subject/v2", provider: "hermes", work_id: work.factory_work_id })
    || receipt.generation !== 1 || receipt.transition_sequence !== 1 || !/^[A-Za-z0-9_.:-]{1,160}$/.test(receipt.owner)
    || receipt.reader_admission_proof?.schema !== "factory-reader-admission-proof/v1"
    || receipt.reader_admission_proof.opaque_sha256 !== retained.reader_proof_sha256
    || ![receipt.lease_started_ms, receipt.lease_expires_ms].every(Number.isSafeInteger)) fail();
  const subject: FactoryExecutionSubject = { schema: "factory-execution-subject/v1", provider: "hermes",
    factory_work_id: work.factory_work_id, claim_key: receipt.key, claim_generation: receipt.generation,
    claim_owner: receipt.owner, reader_proof_sha256: retained.reader_proof_sha256, execution_id: packet.execution_id };
  const key = digest(canonicalize([subject.factory_work_id, subject.claim_generation, packet.execution_id]));
  const binding = digest(canonicalize(packet));
  const authority: JournalAuthority = { envelopeKind: "operator_approval", approvingAuthority: "operator",
    approvalTs: new Date(packet.approved_at_ms).toISOString(), approvalRef: `sha256:${packet.plan_sha256}`,
    autonomyTier: "T0", authorizationEvidenceRef: `sha256:${retained.authority_artifact_sha256}`,
    scopes: ["operation.reserve", INVOKE], expiresAt: new Date(packet.expires_at_ms).toISOString() };
  let previous = 0;
  function fence(stage: "reserve" | "launch") {
    const first = now();
    if (!Number.isSafeInteger(first) || first < previous || first < packet.approved_at_ms) fail();
    dependencies.fence(stage, binding);
    const last = now();
    if (!Number.isSafeInteger(last) || last < first || last + packet.timeout_ms >= Math.min(packet.expires_at_ms, receipt.lease_expires_ms)) fail();
    previous = last;
    const st = lstatSync(packet.journal_path);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.dev !== packet.journal_identity[0] || st.ino !== packet.journal_identity[1]) fail();
  }
  // Already initialized schema only; create:false alone also accepts version0.
  const check = new Database(packet.journal_path, { readonly: true, strict: true });
  try { check.exec("PRAGMA busy_timeout=3000"); if ((check.query("PRAGMA user_version").get() as { user_version: number }).user_version !== 2) fail(); }
  finally { check.close(); }
  const journal = new OperationJournal(packet.journal_path, { create: false, maxBusyRetries: 0,
    now: () => new Date(now()).toISOString(), crashInjector: dependencies.crashInjector });
  const result = (operation: string, terminal: RunReceipt | null, replay: boolean): ContainedExecutionResult => ({
    schema: "hermes-contained-execution-result/v1", status: "held",
    operation_id: operation, execution_id: packet.execution_id, factory_work_id: work.factory_work_id,
    receipt_sha256: terminal?.receipt_hash ?? null, replay, dispatch_eligible: false });
  try {
    // Recover before time-based admission: an expired approval may read its
    // own existing terminal record but can never create or launch new work.
    const prior = journal.db.query("SELECT operation_id,canonical_input FROM operations WHERE scope=? AND idempotency_key=?")
      .get(SCOPE, "cap-one") as { operation_id: string; canonical_input: string } | null;
    const intent = { schema: "hermes-contained-intent/v1", binding, key, subject,
      authority_artifact_sha256: retained.authority_artifact_sha256, work_sha256: retained.work_sha256 };
    if (prior) {
      if (prior.canonical_input !== canonicalize(intent)) fail();
      const terminal = journal.receipt(prior.operation_id);
      if (terminal) {
        const artifacts = terminal.terminal.artifacts.filter(x => x.ref === REF);
        if (artifacts.length !== 1 || digest(artifacts[0]!.description) !== artifacts[0]!.hash) fail();
        const stored = JSON.parse(artifacts[0]!.description);
        if (stored.binding !== binding || canonicalize(stored.subject) !== canonicalize(subject)) fail();
        const state = journal.db.query(`SELECT s.state,s.canonical_evidence FROM effect_states s JOIN effect_definitions d
          ON d.effect_id=s.effect_id WHERE d.operation_id=? ORDER BY s.commit_sequence DESC LIMIT 1`)
          .get(prior.operation_id) as { state: string; canonical_evidence: string } | null;
        if (!state || canonicalize(JSON.parse(state.canonical_evidence)) !== canonicalize(stored)
          || terminal.terminal.outcome === "success" && state.state !== "committed") fail();
      }
      return result(prior.operation_id, terminal, true);
    }
    fence("reserve");
    const reserved = journal.reserve({ scope: SCOPE, idempotencyKey: "cap-one", intent,
      triggerKind: "factory", triggerIdentity: "hermes-contained-execution", authority });
    if (reserved.status !== "reserved") fail();
    // Atomic UNIQUE reservation wins across processes. The loser never probes
    // or retries an effect, even if it saw no prior row in the first read.
    if (reserved.existing) return result(reserved.operationId, journal.receipt(reserved.operationId), true);
    journal.beginAttempt(reserved.operationId, 1);
    let evidence: unknown = { binding, subject, effect: "uncertain", output_sha256: null };
    const observed = await journal.executeEffect(reserved.operationId, { attemptN: 1, adapterKind: REF,
      sideEffectKind: "api_call", target: packet.harness, input: { binding, subject }, reversible: false,
      rollbackRef: null, authorityScope: INVOKE }, authority, {
      dispatch: async () => {
        try {
          const run = await runExecutorChain({ prompt: `${work.title}\n\n${work.description}`, workdir: packet.workdir,
            timeoutMs: packet.timeout_ms, chain: [packet.harness], launchPolicy: "single_launch", factorySubject: subject,
            env: { SWARM_RESOLVED_MODEL: packet.model }, healthProbe: dependencies.healthProbe,
            harnessRun: async (...args) => { fence("launch"); return (dependencies.harnessRun ?? runHarness)(...args); } });
          evidence = { binding, subject, effect: run.launch?.effect ?? "uncertain",
            output_sha256: digest(run.output), success: run.success, launch_count: run.launch?.count ?? 0 };
          return { state: run.launch?.effect === "completed" && run.success ? "committed" : "ambiguous", evidence };
        } catch { return { state: "ambiguous", evidence }; }
      }, probe: () => ({ state: "ambiguous", evidence }),
    });
    const success = observed.state === "committed";
    journal.completeAttempt(reserved.operationId, 1, success ? "success" : "failure", success ? null : "HERMES_EXECUTION_UNCERTAIN");
    // The existing receipt contract correctly requires a separate verifier for
    // a committed mutation. Keep that committed effect pending review; never
    // forge verifier_org_separate merely to manufacture a terminal receipt.
    if (success) return result(reserved.operationId, null, false);
    const terminal = journal.terminalize(reserved.operationId, "held",
      "HERMES_EXECUTION_UNCERTAIN", template(reserved.operationId, key, packet, authority, evidence));
    return result(reserved.operationId, terminal, false);
  } finally { journal.close(); }
}

/** Explicit injection is restricted to disposable tests; never CLI authority. */
export async function runHermesExecutionFixture(packet: ExecutionPacket, dependencies: Dependencies) {
  if (process.env.FACTORY_STATE_MODE !== "test" || typeof dependencies.harnessRun !== "function"
    || typeof dependencies.healthProbe !== "function") fail();
  return execute(packet, dependencies);
}
function receive(): unknown {
  const parts: number[] = [], byte = Buffer.alloc(1);
  while (parts.length <= 100_000) { if (readSync(0, byte, 0, 1, null) !== 1) fail(); if (byte[0] === 10) return JSON.parse(Buffer.from(parts).toString()); parts.push(byte[0]!); }
  return fail();
}
function send(value: unknown): void { const data = Buffer.from(canonicalize(value) + "\n"); if (writeSync(1, data) !== data.length) fail(); }
if (import.meta.main) {
  try {
    if (process.argv.slice(2).join(" ") !== "--root-child" || process.platform !== "linux" || process.getuid?.() === 0
      || !fstatSync(0).isFIFO() || !fstatSync(1).isFIFO()) fail();
    const uid = readFileSync(`/proc/${process.ppid}/status`, "utf8").match(/^Uid:\s+(.*)$/m)?.[1]?.trim().split(/\s+/);
    if (!uid || uid.length !== 4 || uid.some(x => x !== "0")) fail();
    const packet = receive() as ExecutionPacket;
    if (process.getuid?.() !== packet.worker_uid || process.getgid?.() !== packet.worker_gid
      || process.getgroups?.().some(x => x !== packet.worker_gid)) fail();
    const result = await execute(packet, { fence(stage, binding) {
      send({ schema: "hermes-execution-fence/v1", stage, binding });
      const grant = receive();
      if (canonicalize(grant) !== canonicalize({ schema: "hermes-execution-grant/v1", stage, binding })) fail();
    } });
    send({ schema: "hermes-execution-terminal/v1", result });
  } catch { send({ schema: "hermes-execution-held/v1" }); process.exitCode = 2; }
}
