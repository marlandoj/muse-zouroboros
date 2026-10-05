import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TRAJECTORY_FORBIDDEN_FIELDS,
  TRAJECTORY_REQUEST_KEYS,
  buildTrajectoryReport,
  computeTrajectoryRequestHash,
  parseTrajectoryVerifierReport,
  parseTrajectoryVerifierRequest,
  trajectoryClaimEvidenceHash,
  trajectorySha256,
  type TrajectoryVerifierRequest,
} from "./trajectory-verifier-contract.ts";
import {
  activeTrajectoryVerifierPorts,
  activeTrajectoryVerifierRoots,
  activeTrajectoryVerifierWorkers,
  runTrajectoryVerifier,
} from "./trajectory-verifier-runtime.ts";

const hash = (label: string) => trajectorySha256(label);

function requestFixture(): TrajectoryVerifierRequest {
  const sourceReceiptHash = hash("source-receipt");
  const verifierModelId = "verifier-stub-v1";
  const verifierPrompt = hash("verifier-prompt");
  const verifierHistory = hash("verifier-history");
  const rubric = hash("rubric");
  const claims = [
    { claim_id: "terminal", field: "terminal" as const, expected: "completed", evidence_sha256: trajectoryClaimEvidenceHash("terminal", "completed", sourceReceiptHash) },
    { claim_id: "attempts", field: "attempts" as const, expected: 1, evidence_sha256: trajectoryClaimEvidenceHash("attempts", 1, sourceReceiptHash) },
    { claim_id: "committed", field: "committed" as const, expected: true, evidence_sha256: trajectoryClaimEvidenceHash("committed", true, sourceReceiptHash) },
  ];
  const request: TrajectoryVerifierRequest = {
    schema_version: 1,
    request_id: "request-1058",
    scenario_id: "scenario-1058",
    seed: 1057001,
    claims,
    redacted_observations: {
      transcript_sha256: hash("transcript"),
      initial_response_sha256: hash("response"),
      generator_root_sha256: hash("generator-root"),
      verifier_root_sha256: hash("verifier-root"),
      qualitative_evidence: {
        artifact_id: "qualitative-stub-1058",
        verifier_model_id: verifierModelId,
        verifier_prompt_sha256: verifierPrompt,
        verifier_history_sha256: verifierHistory,
        rubric_sha256: rubric,
        request_sha256: "0".repeat(64),
        score: 1,
        confidence: 0.95,
        rationale_sha256: hash("deterministic-rationale"),
      },
    },
    source_receipt_id: "rr-0123456789ABCDEFGHJKMNPQRS",
    source_receipt_hash: sourceReceiptHash,
    generator_model_id: "generator-stub-v1",
    generator_prompt_sha256: hash("generator-prompt"),
    generator_history_sha256: hash("generator-history"),
    verifier_model_id: verifierModelId,
    verifier_prompt_sha256: verifierPrompt,
    verifier_history_sha256: verifierHistory,
    rubric_sha256: rubric,
    replay_tool_url: "http://127.0.0.1:43123/replay",
  };
  request.redacted_observations.qualitative_evidence.request_sha256 = computeTrajectoryRequestHash(request);
  return request;
}

const replay = {
  terminal: "completed",
  attempts: 1,
  delay_ms: 0,
  committed: true,
  compensated: false,
  resumed: false,
  state_version: 2,
};

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function runtimeInput() {
  const generatorRoot = mkdtempSync(join(tmpdir(), "sf009-generator-test-"));
  roots.push(generatorRoot);
  const { replay_tool_url: _, ...request } = requestFixture();
  request.redacted_observations.qualitative_evidence.request_sha256 = "0".repeat(64);
  return { request, generatorRoot, replay: () => replay };
}

describe("trajectory verifier contract", () => {
  test("request allowlist and forbidden inventory match the approved seed", () => {
    expect(TRAJECTORY_REQUEST_KEYS).toHaveLength(16);
    expect(new Set(TRAJECTORY_REQUEST_KEYS).size).toBe(16);
    expect(TRAJECTORY_FORBIDDEN_FIELDS).toHaveLength(12);
    expect(new Set(TRAJECTORY_FORBIDDEN_FIELDS).size).toBe(12);
    expect(Object.keys(parseTrajectoryVerifierRequest(requestFixture())).sort()).toEqual([...TRAJECTORY_REQUEST_KEYS].sort());
  });

  test("unknown and recursively forbidden fields fail closed", () => {
    expect(() => parseTrajectoryVerifierRequest({ ...requestFixture(), fixture_path: "/tmp/cohort.json" })).toThrow("forbidden field");
    const nested = structuredClone(requestFixture()) as unknown as Record<string, unknown>;
    (nested.redacted_observations as Record<string, unknown>).hidden_answer = "completed";
    expect(() => parseTrajectoryVerifierRequest(nested)).toThrow("hidden_answer");
    expect(() => parseTrajectoryVerifierRequest({ ...requestFixture(), extra: true })).toThrow("unknown keys");
  });

  test("secret-shaped values and non-loopback replay URLs fail closed", () => {
    expect(() => parseTrajectoryVerifierRequest({ ...requestFixture(), generator_model_id: "ghp_1234567890abcdef" })).toThrow("secret-shaped");
    expect(() => parseTrajectoryVerifierRequest({ ...requestFixture(), replay_tool_url: "https://example.com/replay" })).toThrow("127.0.0.1");
    expect(() => parseTrajectoryVerifierRequest({ ...requestFixture(), replay_tool_url: "http://user:pass@127.0.0.1:43123/replay" })).toThrow("127.0.0.1");
  });

  test("complete replay emits a canonical PASS report", () => {
    const report = buildTrajectoryReport(parseTrajectoryVerifierRequest(requestFixture()), replay);
    expect(report.disposition).toBe("PASS");
    expect(report.reproduction_ratio).toBe(1);
    expect(report.unresolved_uncertainty).toEqual([]);
    expect(report.report_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parseTrajectoryVerifierReport(report)).toEqual(report);
  });

  test("same request and replay produce byte-identical reports", () => {
    const first = buildTrajectoryReport(parseTrajectoryVerifierRequest(requestFixture()), replay);
    const second = buildTrajectoryReport(parseTrajectoryVerifierRequest(requestFixture()), replay);
    expect(first).toEqual(second);
    expect(first.report_hash).toBe(second.report_hash);
  });

  test("claim mismatch returns advisory HOLD with uncertainty", () => {
    const report = buildTrajectoryReport(parseTrajectoryVerifierRequest(requestFixture()), { ...replay, committed: false });
    expect(report.disposition).toBe("HOLD");
    expect(report.reproduction_ratio).toBe(2 / 3);
    expect(report.unresolved_uncertainty).toContain("claim not reproduced: committed");
  });

  test("same generator and verifier identities return HOLD", () => {
    const request = requestFixture();
    request.verifier_model_id = request.generator_model_id;
    request.redacted_observations.qualitative_evidence.verifier_model_id = request.generator_model_id;
    request.redacted_observations.qualitative_evidence.request_sha256 = computeTrajectoryRequestHash(request);
    const report = buildTrajectoryReport(parseTrajectoryVerifierRequest(request), replay);
    expect(report.disposition).toBe("HOLD");
    expect(report.unresolved_uncertainty).toContain("generator and verifier model identities are equal");
  });

  test("unbound qualitative evidence returns HOLD", () => {
    const request = requestFixture();
    request.redacted_observations.qualitative_evidence.request_sha256 = hash("wrong-request");
    const report = buildTrajectoryReport(parseTrajectoryVerifierRequest(request), replay);
    expect(report.disposition).toBe("HOLD");
    expect(report.unresolved_uncertainty).toContain("qualitative evidence request hash mismatch");
  });

  test("claim evidence drift returns HOLD", () => {
    const request = requestFixture();
    request.claims[0].evidence_sha256 = hash("drift");
    request.redacted_observations.qualitative_evidence.request_sha256 = computeTrajectoryRequestHash(request);
    const report = buildTrajectoryReport(parseTrajectoryVerifierRequest(request), replay);
    expect(report.disposition).toBe("HOLD");
    expect(report.unresolved_uncertainty).toContain("claim evidence mismatch: terminal");
  });

  test("tampered report hash is rejected", () => {
    const report = buildTrajectoryReport(parseTrajectoryVerifierRequest(requestFixture()), replay);
    expect(() => parseTrajectoryVerifierReport({ ...report, confidence: 0.1 })).toThrow("report hash mismatch");
  });

  test("fresh secret-stripped worker reaches only the opaque loopback broker", async () => {
    process.env.TRAJECTORY_TEST_API_KEY = "must-not-cross";
    try {
      let replayCalls = 0;
      const input = runtimeInput();
      const report = await runTrajectoryVerifier({ ...input, replay: () => { replayCalls++; return replay; } });
      expect(report.disposition).toBe("PASS");
      expect(report.boundary_observations).toEqual({
        environment_secret_free: true,
        loopback_only: true,
        generator_root_absent: true,
        answer_fields_absent: true,
      });
      expect(replayCalls).toBe(1);
    } finally {
      delete process.env.TRAJECTORY_TEST_API_KEY;
    }
  });

  test("worker failure returns HOLD and removes every runtime resource", async () => {
    const input = runtimeInput();
    const report = await runTrajectoryVerifier({ ...input, replay: () => { throw new Error("forced replay failure"); } });
    expect(report.disposition).toBe("HOLD");
    expect(report.unresolved_uncertainty).toContain("trajectory verifier worker failed");
    expect(activeTrajectoryVerifierPorts()).toEqual([]);
    expect(activeTrajectoryVerifierRoots()).toEqual([]);
    expect(activeTrajectoryVerifierWorkers()).toBe(0);
  });

  test("worker timeout returns HOLD and removes every runtime resource", async () => {
    const input = runtimeInput();
    const report = await runTrajectoryVerifier({ ...input, replay: async () => { await Bun.sleep(1000); return replay; }, timeoutMs: 20 });
    expect(report.disposition).toBe("HOLD");
    expect(report.unresolved_uncertainty).toContain("trajectory verifier worker timed out");
    expect(activeTrajectoryVerifierPorts()).toEqual([]);
    expect(activeTrajectoryVerifierRoots()).toEqual([]);
    expect(activeTrajectoryVerifierWorkers()).toBe(0);
  });

  test("verifier roots are distinct and disposable", async () => {
    const before = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith("sf009-verifier-")));
    const input = runtimeInput();
    const report = await runTrajectoryVerifier(input);
    expect(report.disposition).toBe("PASS");
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith("sf009-verifier-") && !before.has(name));
    expect(after).toEqual([]);
    expect(existsSync(input.generatorRoot)).toBe(true);
  });

  test("equal generator and verifier root hashes return HOLD", () => {
    const request = requestFixture();
    request.redacted_observations.verifier_root_sha256 = request.redacted_observations.generator_root_sha256;
    request.redacted_observations.qualitative_evidence.request_sha256 = computeTrajectoryRequestHash(request);
    const report = buildTrajectoryReport(parseTrajectoryVerifierRequest(request), replay);
    expect(report.disposition).toBe("HOLD");
    expect(report.unresolved_uncertainty).toContain("generator and verifier root hashes are equal");
  });
});
