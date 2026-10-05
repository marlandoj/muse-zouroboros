import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEvidenceManifest } from "./factory-evidence";
import { parseOutcomeLedger, reconcileOutcomeEvidence } from "./outcome-evidence-reconcile";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function sandbox(): { stateDir: string; evaluationsDir: string; ledgerPath: string } {
  const root = mkdtempSync(join(tmpdir(), "outcome-evidence-"));
  roots.push(root);
  const stateDir = join(root, "state");
  const evaluationsDir = join(root, "evaluations");
  mkdirSync(stateDir);
  mkdirSync(evaluationsDir);
  return { stateDir, evaluationsDir, ledgerPath: join(stateDir, "outcome-evidence-ledger.jsonl") };
}

function execution(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    execution_id: id,
    identifier: "ZOU-1528",
    ticket_id: "linear-id",
    state: "accepted",
    status: "accepted",
    stage: "accepted",
    delivery_target: "accepted",
    target_reached: true,
    started_at: "2026-08-27T01:00:00.000Z",
    completed_at: "2026-08-27T01:30:00.000Z",
    state_updated_at: "2026-08-27T01:30:00.000Z",
    executor: { id: "executor-a", harness: "codex", model: "gpt-5.6" },
    commit_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    pr_number: 42,
    model_cost_usd: 1.5,
    ...overrides,
  };
}

function verdict(
  id: string,
  sources: { evaluationsDir: string },
  variant = "v1",
): Record<string, unknown> {
  const commitDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const manifest = createEvidenceManifest({
    schema_version: 1,
    ticket: "ZOU-1528",
    execution_id: id,
    commit_digest: commitDigest,
    seed_hash: null,
    author: { provider: "openai", model: "gpt-5.6" },
    executor: { provider: "openai", model: "gpt-5.6" },
    reviewers: [{ provider: "anthropic", model: "claude" }],
    review_evidence: { status: "pass", evidence: [], hashes: {} },
    tests: [],
    test_evidence: { status: "pass", evidence: [], hashes: {} },
    artifacts: [variant],
    trace_verification: { status: "pass", evidence: [], hashes: {} },
    feature_contract: { status: "pass", evidence: [], hashes: {} },
    supply_chain: { status: "pass", evidence: [], hashes: {}, attestation_hash: null },
    verdict: "pass",
    rollout_mode: "blocking",
    override: null,
    generated_at: "2026-08-27T01:31:00.000Z",
  });
  const manifestPath = join(sources.evaluationsDir, `${id}-${variant}.evidence.json`);
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return {
    ticket: "ZOU-1528",
    execution_id: id,
    verdict: "pass",
    rework: false,
    evidence: "verifier receipt",
    decided_at: "2026-08-27T01:31:00.000Z",
    evidence_mode: "blocking",
    evidence_manifest_path: manifestPath,
    evidence_manifest_hash: manifest.content_hash,
    outcome_verifier: { id: "verifier-b", harness: "postflight", model: "deterministic" },
    commit_digest: commitDigest,
    evidence_digest: manifest.content_hash,
  };
}

describe("outcome evidence reconciliation", () => {
  test("joins exact execution identity into a measured append-only row", () => {
    const sources = sandbox();
    writeFileSync(join(sources.stateDir, "exec-one.json"), JSON.stringify(execution("exec-one")));
    writeFileSync(join(sources.evaluationsDir, "one.verdict.json"), JSON.stringify(verdict("exec-one", sources)));
    const report = reconcileOutcomeEvidence({ sources, apply: true, now: "2026-08-27T02:00:00.000Z" });
    expect(report.appended).toBe(1);
    expect(report.measured).toBe(1);
    expect(report.source_errors).toEqual([]);
    const ledger = parseOutcomeLedger(readFileSync(sources.ledgerPath, "utf8"));
    expect(ledger.errors).toEqual([]);
    expect(ledger.rows[0]?.envelope.execution_id).toBe("exec-one");
    expect(ledger.rows[0]?.envelope.pull_request).toEqual({ number: 42, fate: "merged" });
    expect(ledger.rows[0]?.envelope.cost?.amount_usd).toBe(1.5);
  });

  test("is idempotent and appends a superseding row only when evidence changes", () => {
    const sources = sandbox();
    writeFileSync(join(sources.stateDir, "exec-one.json"), JSON.stringify(execution("exec-one")));
    writeFileSync(join(sources.evaluationsDir, "one.verdict.json"), JSON.stringify(verdict("exec-one", sources)));
    const first = reconcileOutcomeEvidence({ sources, apply: true, now: "2026-08-27T02:00:00.000Z" });
    const second = reconcileOutcomeEvidence({ sources, apply: true, now: "2026-08-27T02:05:00.000Z" });
    expect(first.appended).toBe(1);
    expect(second.appended).toBe(0);
    expect(second.unchanged).toBe(1);
    const changed = verdict("exec-one", sources, "v2");
    writeFileSync(join(sources.evaluationsDir, "one.verdict.json"), JSON.stringify(changed));
    const third = reconcileOutcomeEvidence({ sources, apply: true, now: "2026-08-27T02:01:00.000Z" });
    expect(third.appended).toBe(1);
    expect(third.superseded).toBe(1);
    const ledger = parseOutcomeLedger(readFileSync(sources.ledgerPath, "utf8"));
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[1]?.supersedes).toBe(ledger.rows[0]?.record_id ?? null);
  });

  test("classifies duplicate verifier claims as held_unmeasured", () => {
    const sources = sandbox();
    writeFileSync(join(sources.stateDir, "exec-one.json"), JSON.stringify(execution("exec-one")));
    writeFileSync(join(sources.evaluationsDir, "one.verdict.json"), JSON.stringify(verdict("exec-one", sources)));
    writeFileSync(join(sources.evaluationsDir, "two.verdict.json"), JSON.stringify(verdict("exec-one", sources)));
    const report = reconcileOutcomeEvidence({ sources, now: "2026-08-27T02:00:00.000Z" });
    expect(report.held_unmeasured).toBe(1);
    expect(report.generated[0]?.envelope.hold?.code).toBe("duplicate");
  });

  test("uses a typed exclusion for pre-instrumentation terminals", () => {
    const sources = sandbox();
    writeFileSync(join(sources.stateDir, "exec-old.json"), JSON.stringify(execution("exec-old", {
      started_at: "2026-07-01T01:00:00.000Z",
      completed_at: "2026-07-01T01:30:00.000Z",
      state_updated_at: "2026-07-01T01:30:00.000Z",
    })));
    const report = reconcileOutcomeEvidence({ sources, now: "2026-08-27T02:00:00.000Z" });
    expect(report.excluded).toBe(1);
    expect(report.generated[0]?.envelope.exclusion?.code).toBe("pre_instrumentation");
  });

  test("invalid verifier bindings remain held and visible without corrupting the ledger", () => {
    const sources = sandbox();
    writeFileSync(join(sources.stateDir, "exec-one.json"), JSON.stringify(execution("exec-one")));
    const invalid = verdict("exec-one", sources);
    delete invalid.evidence_digest;
    writeFileSync(join(sources.evaluationsDir, "one.verdict.json"), JSON.stringify(invalid));
    const report = reconcileOutcomeEvidence({ sources, apply: true, now: "2026-08-27T02:00:00.000Z" });
    expect(report.appended).toBe(1);
    expect(report.held_unmeasured).toBe(1);
    expect(report.source_errors).toHaveLength(1);
    expect(report.generated[0]?.envelope.hold?.code).toBe("missing");
  });

  test("reports malformed sources and fails closed on a torn ledger", () => {
    const sources = sandbox();
    writeFileSync(join(sources.stateDir, "exec-bad.json"), "{not-json");
    writeFileSync(join(sources.stateDir, "exec-one.json"), JSON.stringify(execution("exec-one")));
    writeFileSync(sources.ledgerPath, "{torn\n");
    const report = reconcileOutcomeEvidence({ sources, apply: true, now: "2026-08-27T02:00:00.000Z" });
    expect(report.source_errors).toHaveLength(1);
    expect(report.ledger_errors).toHaveLength(1);
    expect(report.write_blocked).toBeTrue();
    expect(report.appended).toBe(0);
    expect(readFileSync(sources.ledgerPath, "utf8")).toBe("{torn\n");
  });
});
