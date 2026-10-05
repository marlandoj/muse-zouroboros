import { createHash } from "node:crypto";
import { actorSha256, type ActorState, type ActorTranscript, type LoadedActorContract } from "./actor-system-twin.ts";
import {
  CONTRACT_ID,
  RECEIPT_SCHEMA_VERSION,
  finalizeReceipt,
  validateRunReceipt,
  type AttemptStatus,
  type RunEvent,
  type RunReceipt,
  type TerminalOutcome,
} from "./run-receipt-contract.ts";
import { parseTrajectoryVerifierReport, type TrajectoryVerifierReport } from "./trajectory-verifier-contract.ts";

export interface ActorReceiptInput {
  loaded: LoadedActorContract;
  seed: number;
  transcript: ActorTranscript;
  state: ActorState;
  approvalReceiptRef: string;
  trajectoryReport?: TrajectoryVerifierReport;
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableId(prefix: "rr" | "op", source: string): string {
  const bytes = createHash("sha256").update(source).digest();
  let output = "";
  for (let index = 0; index < 26; index++) output += CROCKFORD[bytes[index % bytes.length] % CROCKFORD.length];
  return `${prefix}-${output}`;
}

function terminalOutcome(input: ActorReceiptInput): TerminalOutcome {
  const response = input.transcript.entries.at(-1)?.response;
  if (!response) throw new Error("actor transcript must contain a terminal response");
  if (response.terminal === "completed") return "success";
  if (response.terminal === "cancelled") return "cancelled";
  if (input.loaded.contract.fault === "timeout") return "timeout";
  if (response.compensated) return "partial";
  return "failure";
}

function attemptStatus(outcome: TerminalOutcome, attempt: number, total: number): AttemptStatus {
  if (attempt < total) return "failure";
  if (outcome === "success") return "success";
  if (outcome === "cancelled") return "cancelled";
  if (outcome === "timeout") return "timeout";
  return "failure";
}

export function buildActorRunReceipt(input: ActorReceiptInput): RunReceipt {
  if (!Number.isSafeInteger(input.seed) || input.seed < 0) throw new Error("receipt seed must be a non-negative safe integer");
  if (!/^sha256:[0-9a-f]{64}$/.test(input.approvalReceiptRef)) throw new Error("approvalReceiptRef must bind a SHA-256 receipt");
  const response = input.transcript.entries.at(-1)?.response;
  if (!response) throw new Error("actor transcript must contain a terminal response");
  if (input.transcript.sha256 !== actorSha256(input.transcript.entries)) throw new Error("actor transcript hash mismatch");
  if (response.terminal !== input.loaded.contract.expectedTerminal) throw new Error("actor terminal does not match reviewed contract");
  if (input.state.status !== response.terminal || input.state.attempts !== response.attempts
    || input.state.committed !== response.committed || input.state.compensated !== response.compensated
    || input.state.resumed !== response.resumed) {
    throw new Error("actor state does not match terminal response");
  }
  const source = `${input.loaded.manifestHash}:${input.loaded.contractHash}:${input.seed}:${response.requestId}`;
  const operationId = stableId("op", source);
  const receiptId = stableId("rr", `${source}:receipt`);
  const baseMs = Date.UTC(2026, 7, 20, 0, 0, 0) + (input.seed % 1_000_000);
  const at = (offset: number) => new Date(baseMs + offset * 1_000).toISOString();
  const outcome = terminalOutcome(input);
  const attempts = Math.max(1, response.attempts);
  const events: RunEvent[] = [];
  const pushEvent = (kind: RunEvent["kind"], attemptN: number | null, details: unknown, toolCallId: string | null = null, toolResultFor: string | null = null) => {
    const sequence = events.length + 1;
    events.push({
      event_id: `evt-${input.loaded.contract.id}-${input.seed}-${sequence}`,
      source_event_id: `actor:${input.loaded.contract.id}:${input.seed}:${sequence}`,
      causal_parent_id: events.at(-1)?.event_id ?? null,
      sequence,
      cursor: `rrc:${operationId}:${sequence}`,
      kind,
      ts: at(sequence - 1),
      attempt_n: attemptN,
      tool_call_id: toolCallId,
      tool_result_for: toolResultFor,
      payload_hash: sha256(JSON.stringify(details)),
    });
  };

  pushEvent("operation.accepted", null, { contract: input.loaded.contract.id, seed: input.seed });
  const receiptAttempts: RunReceipt["attempts"] = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const callId = `actor-call-${attempt}`;
    const status = attemptStatus(outcome, attempt, attempts);
    pushEvent("attempt.started", attempt, { attempt });
    pushEvent("tool.called", attempt, { actorKind: input.loaded.contract.actorKind }, callId);
    pushEvent("tool.completed", attempt, { status }, null, callId);
    pushEvent("attempt.completed", attempt, { status });
    receiptAttempts.push({
      attempt_n: attempt,
      ts_start: at(events.length - 4),
      ts_end: at(events.length - 1),
      status,
      side_effects: attempt === attempts ? [{
        effect_id: `actor-state-${input.loaded.contract.id}-${input.seed}`,
        kind: "ledger_append",
        target: `synthetic://actor-system/${input.loaded.contract.id}`,
        committed: response.committed,
        reversible: response.committed,
        rollback_ref: response.committed ? `actor-baseline:${input.loaded.contractHash}` : null,
      }] : [],
      error: status === "success" ? null : `${input.loaded.contract.fault}:${status}`,
      retry_reason: attempt < attempts ? input.loaded.contract.fault : null,
    });
  }
  const terminalKind = outcome === "success" || outcome === "partial" ? "operation.completed" : "operation.failed";
  pushEvent(terminalKind, null, { outcome, state: input.state });
  const terminalEvent = events.at(-1)!;
  const ledgerHash = sha256(`${input.transcript.sha256}:${sha256(JSON.stringify(input.state))}`);
  const receipt: RunReceipt = {
    contract_id: CONTRACT_ID,
    schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: receiptId,
    operation_id: operationId,
    idempotency_key: `sf009:${input.loaded.contract.id}:${input.seed}:${response.requestId}`,
    receipt_hash: "0".repeat(64),
    trigger: {
      kind: "evaluator",
      identity: "SF-009 actor-system cohort",
      intent: `Execute synthetic ${input.loaded.contract.actorKind} contract ${input.loaded.contract.id}`,
      input_hash: sha256(source),
      ts: events[0].ts,
    },
    lineage: {
      parent_receipt_id: null,
      trace_id: sha256(`${source}:trace`).slice(0, 32),
      span_id: sha256(`${source}:span`).slice(0, 16),
      inherited_state_refs: [`manifest:${input.loaded.manifestHash}`, `contract:${input.loaded.contractHash}`],
      wave_id: "zou-1057-c4",
      seed_id: String(input.seed),
    },
    versions: {
      contract_version: CONTRACT_ID,
      policy_version: "zou-1057-v1",
      model_versions: {},
      tool_versions: { actor_system_twin: "v1" },
      schema_migrations: [],
    },
    authority: {
      envelope_kind: "operator_approval",
      approving_authority: "human operator",
      approval_ts: "2026-08-20T00:48:00.000Z",
      approval_ref: input.approvalReceiptRef,
      autonomy_tier: null,
      authorization_evidence_ref: `manifest:${input.loaded.manifestHash}`,
    },
    events,
    attempts: receiptAttempts,
    terminal: {
      outcome,
      committed_state_hash: sha256(JSON.stringify(input.state)),
      artifacts: [{
        kind: "evaluation",
        ref: `synthetic://actor-system/${input.loaded.contract.id}/${input.seed}`,
        hash: input.transcript.sha256,
        description: "Deterministic actor-system transcript",
      }],
      ledger_entries: [{ ledger: "sf009-actor-system", record_hash: ledgerHash, chain_verified: true }],
    },
    acknowledgements: {
      accepted: { kind: "accepted", event_id: events[0].event_id, ts: events[0].ts, evidence_ref: events[0].source_event_id },
      completed: { kind: "completed", event_id: terminalEvent.event_id, ts: terminalEvent.ts, evidence_ref: terminalEvent.source_event_id },
      user_visible: null,
    },
    verification: {
      verifier_identity: "sf009-deterministic-verifier",
      verifier_org_separate: true,
      checks: [
        { check_id: "actor-terminal", kind: "mechanical", pass: response.terminal === input.loaded.contract.expectedTerminal, evidence_ref: input.transcript.sha256, detail: "Reviewed terminal outcome matched" },
        { check_id: "actor-chain", kind: "parity", pass: true, evidence_ref: ledgerHash, detail: "Transcript and committed-state edge are hash-bound" },
      ],
      edge_proof: { chain_ok: true, anchor_ok: true, ledger_head: ledgerHash },
    },
    observation: { user_visible_outcome: null, user_confirmed: null, feedback_ref: null },
    ts_created: events[0].ts,
    ts_terminal: terminalEvent.ts,
  };
  const sourceReceipt = finalizeReceipt(receipt);
  if (input.trajectoryReport) {
    const report = parseTrajectoryVerifierReport(input.trajectoryReport);
    if (report.source_receipt_id !== sourceReceipt.receipt_id || report.source_receipt_hash !== sourceReceipt.receipt_hash) {
      throw new Error("trajectory report source receipt binding mismatch");
    }
    receipt.versions.tool_versions.trajectory_verifier = "v1";
    receipt.terminal.artifacts.push({
      kind: "evaluation",
      ref: `trajectory://${report.report_id}`,
      hash: report.report_hash,
      description: "Advisory sandboxed trajectory reproduction report",
    });
    receipt.verification.checks.push({
      check_id: "trajectory-reproduction",
      kind: "parity",
      pass: report.disposition === "PASS",
      evidence_ref: report.report_hash,
      detail: `Advisory trajectory ${report.disposition}; reproduction=${report.reproduction_ratio.toFixed(6)}`,
    });
  }
  const finalized = input.trajectoryReport ? finalizeReceipt(receipt) : sourceReceipt;
  const validation = validateRunReceipt(finalized);
  if (!validation.ok) throw new Error(`generated actor receipt is invalid: ${validation.errors.map((error) => `${error.code}:${error.path}`).join(", ")}`);
  return finalized;
}
