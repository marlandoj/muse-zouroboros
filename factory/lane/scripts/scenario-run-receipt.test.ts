import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  actorSha256,
  createActorSystemMachine,
  loadActorSystemContract,
  parseActorSystemManifest,
  type ActorSystemManifest,
} from "./actor-system-twin.ts";
import { buildActorRunReceipt } from "./scenario-run-receipt.ts";
import { canonicalize, validateRunReceipt } from "./run-receipt-contract.ts";
import {
  buildTrajectoryReport,
  computeTrajectoryReportHash,
  computeTrajectoryRequestHash,
  trajectoryClaimEvidenceHash,
  trajectorySha256,
  type TrajectoryReplayObservation,
  type TrajectoryVerifierRequest,
} from "./trajectory-verifier-contract.ts";

const source = "/home/workspace/Projects/zouroboros-evidence-substrate/plans/zou-1057-reviewed-synthetic-cohort-2026-08-20.json";
const root = mkdtempSync(join(tmpdir(), "zou-1057-c2-"));
const fixture = join(root, "cohort.json");
const approvalReceiptRef = `sha256:${"32de64da25af84759eb75e8dff5567eb4f30edb23fe239346c228a3ea93a10d6"}`;
let manifest: ActorSystemManifest;
let manifestHash: string;

beforeAll(() => {
  const bytes = readFileSync(source);
  writeFileSync(fixture, bytes);
  manifest = parseActorSystemManifest(JSON.parse(bytes.toString("utf8")));
  manifestHash = createHash("sha256").update(bytes).digest("hex");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function execute(contractId: string, seed: number) {
  const contract = manifest.contracts.find((entry) => entry.id === contractId)!;
  const loaded = loadActorSystemContract(fixture, contractId, {
    kind: "approved_manifest",
    manifestHash,
    contractHash: actorSha256(contract),
    reviewHash: "a".repeat(64),
  });
  const machine = createActorSystemMachine(loaded, seed);
  machine.handle({ requestId: `${contractId}-${seed}`, approval: contract.approval === "required_allow" ? "allow" : "deny" });
  return { loaded, machine };
}

function trajectoryReport(execution: ReturnType<typeof execute>, seed: number) {
  const base = buildActorRunReceipt({ loaded: execution.loaded, seed, transcript: execution.machine.transcript(), state: execution.machine.state(), approvalReceiptRef });
  const response = execution.machine.transcript().entries.at(-1)!.response;
  const replay: TrajectoryReplayObservation = {
    terminal: response.terminal,
    attempts: response.attempts,
    delay_ms: response.delayMs,
    committed: response.committed,
    compensated: response.compensated,
    resumed: response.resumed,
    state_version: response.stateVersion,
  };
  const verifierPrompt = trajectorySha256("receipt-verifier-prompt");
  const verifierHistory = trajectorySha256("receipt-verifier-history");
  const rubric = trajectorySha256("receipt-rubric");
  const claims = Object.entries(replay).map(([field, expected]) => ({
    claim_id: `receipt-${field}`,
    field: field as keyof TrajectoryReplayObservation,
    expected,
    evidence_sha256: trajectoryClaimEvidenceHash(field as keyof TrajectoryReplayObservation, expected, base.receipt_hash),
  }));
  const request: TrajectoryVerifierRequest = {
    schema_version: 1,
    request_id: `receipt-${seed}`,
    scenario_id: "receipt-trajectory",
    seed,
    claims,
    redacted_observations: {
      transcript_sha256: execution.machine.transcript().sha256,
      initial_response_sha256: trajectorySha256(replay),
      generator_root_sha256: trajectorySha256("receipt-generator-root"),
      verifier_root_sha256: trajectorySha256("receipt-verifier-root"),
      qualitative_evidence: {
        artifact_id: `qualitative-${seed}`,
        verifier_model_id: "verifier-stub-v1",
        verifier_prompt_sha256: verifierPrompt,
        verifier_history_sha256: verifierHistory,
        rubric_sha256: rubric,
        request_sha256: "0".repeat(64),
        score: 1,
        confidence: 1,
        rationale_sha256: trajectorySha256("receipt-rationale"),
      },
    },
    source_receipt_id: base.receipt_id,
    source_receipt_hash: base.receipt_hash,
    generator_model_id: "generator-stub-v1",
    generator_prompt_sha256: trajectorySha256("receipt-generator-prompt"),
    generator_history_sha256: trajectorySha256("receipt-generator-history"),
    verifier_model_id: "verifier-stub-v1",
    verifier_prompt_sha256: verifierPrompt,
    verifier_history_sha256: verifierHistory,
    rubric_sha256: rubric,
    replay_tool_url: "http://127.0.0.1:43123/replay",
  };
  request.redacted_observations.qualitative_evidence.request_sha256 = computeTrajectoryRequestHash(request);
  return { base, report: buildTrajectoryReport(request, replay) };
}

describe("actor transcript to canonical run-receipt v1", () => {
  test("all 60 reviewed replicates validate with complete authority and edge proof", () => {
    for (const contract of manifest.contracts) {
      for (const seed of manifest.replicateSeeds) {
        const { loaded, machine } = execute(contract.id, seed);
        const receipt = buildActorRunReceipt({ loaded, seed, transcript: machine.transcript(), state: machine.state(), approvalReceiptRef });
        expect(validateRunReceipt(receipt)).toEqual({ ok: true, errors: [] });
        expect(receipt.authority.envelope_kind).toBe("operator_approval");
        expect(receipt.acknowledgements.completed).not.toBeNull();
        expect(receipt.verification.edge_proof).toEqual(expect.objectContaining({ chain_ok: true, anchor_ok: true }));
        expect(receipt.terminal.committed_state_hash).toMatch(/^[0-9a-f]{64}$/);
      }
    }
  });

  test("same transcript and state produce byte-identical receipt hashes", () => {
    const first = execute("api-rate-limit-retry", 1057002);
    const second = execute("api-rate-limit-retry", 1057002);
    const a = buildActorRunReceipt({ loaded: first.loaded, seed: 1057002, transcript: first.machine.transcript(), state: first.machine.state(), approvalReceiptRef });
    const b = buildActorRunReceipt({ loaded: second.loaded, seed: 1057002, transcript: second.machine.transcript(), state: second.machine.state(), approvalReceiptRef });
    expect(canonicalize(a)).toBe(canonicalize(b));
    expect(a.receipt_hash).toBe(b.receipt_hash);
  });

  test("retry, timeout, cancellation, and compensation map to canonical attempts and outcomes", () => {
    const cases = [
      ["tool-transient-retry", "success", 2],
      ["tool-timeout", "timeout", 1],
      ["tool-cancel-during-run", "cancelled", 1],
      ["system-partial-commit", "partial", 1],
    ] as const;
    for (const [id, outcome, attempts] of cases) {
      const execution = execute(id, 1057001);
      const receipt = buildActorRunReceipt({ loaded: execution.loaded, seed: 1057001, transcript: execution.machine.transcript(), state: execution.machine.state(), approvalReceiptRef });
      expect(receipt.terminal.outcome).toBe(outcome);
      expect(receipt.attempts).toHaveLength(attempts);
    }
  });

  test("empty, tampered, and unauthorized inputs fail closed", () => {
    const execution = execute("tool-success", 1057001);
    expect(() => buildActorRunReceipt({ loaded: execution.loaded, seed: 1057001, transcript: { entries: [], sha256: actorSha256([]) }, state: execution.machine.state(), approvalReceiptRef })).toThrow("terminal response");
    const transcript = execution.machine.transcript();
    transcript.sha256 = "b".repeat(64);
    expect(() => buildActorRunReceipt({ loaded: execution.loaded, seed: 1057001, transcript, state: execution.machine.state(), approvalReceiptRef })).toThrow("transcript hash mismatch");
    expect(() => buildActorRunReceipt({ loaded: execution.loaded, seed: 1057001, transcript: execution.machine.transcript(), state: execution.machine.state(), approvalReceiptRef: "missing" })).toThrow("approvalReceiptRef");
    expect(() => buildActorRunReceipt({ loaded: execution.loaded, seed: 1057001, transcript: execution.machine.transcript(), state: { ...execution.machine.state(), committed: false }, approvalReceiptRef })).toThrow("state does not match");
  });

  test("advisory trajectory report binds through existing v1 artifact and parity shapes", () => {
    const execution = execute("tool-success", 1057001);
    const { base, report } = trajectoryReport(execution, 1057001);
    const receipt = buildActorRunReceipt({
      loaded: execution.loaded,
      seed: 1057001,
      transcript: execution.machine.transcript(),
      state: execution.machine.state(),
      approvalReceiptRef,
      trajectoryReport: report,
    });
    expect(receipt.receipt_hash).not.toBe(base.receipt_hash);
    expect(receipt.terminal.outcome).toBe(base.terminal.outcome);
    expect(receipt.terminal.artifacts).toContainEqual(expect.objectContaining({ kind: "evaluation", hash: report.report_hash }));
    expect(receipt.verification.checks).toContainEqual(expect.objectContaining({ check_id: "trajectory-reproduction", kind: "parity", pass: true }));
    expect(validateRunReceipt(receipt)).toEqual({ ok: true, errors: [] });
  });

  test("trajectory source drift fails before receipt finalization", () => {
    const execution = execute("tool-success", 1057001);
    const { report } = trajectoryReport(execution, 1057001);
    report.source_receipt_hash = "f".repeat(64);
    report.report_hash = computeTrajectoryReportHash(report);
    expect(() => buildActorRunReceipt({
      loaded: execution.loaded,
      seed: 1057001,
      transcript: execution.machine.transcript(),
      state: execution.machine.state(),
      approvalReceiptRef,
      trajectoryReport: report,
    })).toThrow("source receipt binding mismatch");
  });
});
