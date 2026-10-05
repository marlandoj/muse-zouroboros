import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeOutcomeEvidenceMetrics, loadFirstPassQualityMetrics } from "./factory-metrics";
import { appendFirstPassLedger } from "./first-pass-ledger";
import type { FactoryRecord } from "./factory-collect";
import { resolveOutcomeEnvelope, type OutcomeEnvelope } from "./outcome-envelope";

function envelope(input: Record<string, unknown>): OutcomeEnvelope {
  const result = resolveOutcomeEnvelope({
    execution_id: input.execution_id,
    ticket: "ZOU-1528",
    terminal_state: input.terminal_state ?? "accepted",
    started_at: "2026-08-27T01:00:00.000Z",
    terminal_at: "2026-08-27T01:30:00.000Z",
    recorded_at: "2026-08-27T01:31:00.000Z",
    executor: { id: "executor-a", harness: "codex", model: "gpt-5.6" },
    commit_digest: input.commit_digest,
    verification: input.verification,
    exclusion: input.exclusion,
  });
  if (result.ok === false) throw new Error(result.errors.join("; "));
  return result.envelope;
}

const verification = {
  id: "verifier-b",
  harness: "postflight",
  model: "deterministic",
  verdict: "pass",
  decided_at: "2026-08-27T01:30:30.000Z",
  commit_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  evidence_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
};

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("independent first-pass quality metrics", () => {
  test("reports missing ledger and incomplete contracts as unmeasured, never perfect", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-metrics-"));
    temporaryRoots.push(root);
    const report = loadFirstPassQualityMetrics(join(root, "missing.jsonl"), [factoryRecord(null)]);
    expect(report.ledger_available).toBeFalse();
    expect(report.contract_completeness).toBe(0);
    expect(report.metrics).toBeNull();
  });

  test("computes independent yield, defects, and full strata from valid append-only evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-metrics-"));
    temporaryRoots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    appendFirstPassLedger(path, {
      ticket: "ZOU-1529",
      cycle_number: 0,
      prior_cycle: null,
      recorded_at: "2026-08-28T00:00:00.000Z",
      stratum: { archetype: "code", repository: "/repo", harness: "codex", validator_version: "validator-v1" },
      verdict: {
        schema: "zsf.validator-verdict.v1",
        schema_version: 1,
        execution_id: "exec-1",
        candidate_cycle_id: "exec-1-cycle-0",
        candidate_commit_digest: digest("a"),
        validation_contract_digest: digest("b"),
        validator_environment_digest: digest("c"),
        evidence_digest: digest("d"),
        validator: { id: "validator", harness: "local", model: "deterministic" },
        verdict: "fail",
        defect_classes: ["deterministic_test_failure"],
        reasons: ["test failed"],
        decided_at: "2026-08-28T00:00:00.000Z",
      },
    });
    const report = loadFirstPassQualityMetrics(path, [factoryRecord(digest("b"))]);
    expect(report.ledger_errors).toEqual([]);
    expect(report.contract_completeness).toBe(1);
    expect(report.metrics?.first_pass_yield).toBe(0);
    expect(report.metrics?.failed_cycles).toBe(1);
    expect(report.metrics?.defect_classes.deterministic_test_failure).toBe(1);
    expect(Object.keys(report.metrics?.strata ?? {})).toEqual(["code|/repo|codex|validator-v1"]);
  });

  test("withholds metrics when a torn or forged ledger row is present", () => {
    const root = mkdtempSync(join(tmpdir(), "first-pass-metrics-"));
    temporaryRoots.push(root);
    const path = join(root, "first-pass-ledger.jsonl");
    writeFileSync(path, '{"schema":"zsf.first-pass-ledger-row.v1"}\n');
    const report = loadFirstPassQualityMetrics(path, [factoryRecord(null)]);
    expect(report.ledger_errors.length).toBeGreaterThan(0);
    expect(report.ledger_rows).toBe(0);
    expect(report.metrics).toBeNull();
  });
});

function factoryRecord(contractDigest: string | null): FactoryRecord {
  return {
    execution_id: "exec-1",
    kind: "execution",
    ticket_id: "ticket-1",
    identifier: "ZOU-1529",
    gate_decision: "SWARM",
    shadow_phase: "shadow",
    status: "implementation_complete",
    stages: { decision: "unknown", seed: "unknown", execute: "2026-08-28T00:00:00.000Z", postflight: null, pr: null },
    verdict_ref: null,
    measured: false,
    verdict: null,
    cycle_time_hours: null,
    archetype: "code",
    first_pass_validation: {
      mode: "shadow",
      contract_digest: contractDigest,
      ledger_record_id: null,
      verdict: null,
      repository: "/repo",
      harness: "codex",
      validator_version: "validator-v1",
      errors: contractDigest === null ? 1 : 0,
    },
    collected_at: "2026-08-28T00:01:00.000Z",
  };
}

describe("outcome evidence metrics", () => {
  test("keeps excluded and held outcomes out of measured coverage and success", () => {
    const metrics = computeOutcomeEvidenceMetrics([
      envelope({ execution_id: "measured", commit_digest: verification.commit_digest, verification }),
      envelope({ execution_id: "held", commit_digest: null }),
      envelope({
        execution_id: "excluded",
        terminal_state: "held",
        commit_digest: null,
        exclusion: { code: "pre_instrumentation", reason: "legacy" },
      }),
    ]);
    expect(metrics.terminal_count).toBe(3);
    expect(metrics.eligible_terminal_count).toBe(2);
    expect(metrics.measured_count).toBe(1);
    expect(metrics.held_unmeasured_count).toBe(1);
    expect(metrics.excluded_count).toBe(1);
    expect(metrics.evidence_coverage).toBe(0.5);
    expect(metrics.successful_measured_count).toBe(1);
    expect(metrics.promotion_ready).toBeFalse();
  });

  test("requires both the coverage floor and minimum sample", () => {
    const rows = Array.from({ length: 30 }, (_, index) => envelope({
      execution_id: `measured-${index}`,
      terminal_state: "failed",
      commit_digest: verification.commit_digest,
      verification: { ...verification, verdict: "fail" },
    }));
    expect(computeOutcomeEvidenceMetrics(rows.slice(0, 29)).promotion_ready).toBeFalse();
    expect(computeOutcomeEvidenceMetrics(rows).promotion_ready).toBeTrue();
  });

  test("never reports promotion ready with an unmeasured successful terminal", () => {
    const failures = Array.from({ length: 29 }, (_, index) => envelope({
      execution_id: `failure-${index}`,
      terminal_state: "failed",
      commit_digest: verification.commit_digest,
      verification: { ...verification, verdict: "fail" },
    }));
    const acceptedHeld = envelope({ execution_id: "accepted-held", commit_digest: null });
    const metrics = computeOutcomeEvidenceMetrics([...failures, acceptedHeld]);
    expect(metrics.evidence_coverage).toBeCloseTo(29 / 30);
    expect(metrics.successful_evidence_coverage).toBe(0);
    expect(metrics.promotion_ready).toBeFalse();
  });
});
