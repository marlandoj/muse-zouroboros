import { describe, expect, test } from "bun:test";
import { evaluateOutcomeCoverage } from "./outcome-coverage-gate";
import { resolveOutcomeEnvelope, type OutcomeEnvelope } from "./outcome-envelope";

function measured(index: number): OutcomeEnvelope {
  const minute = String(index % 60).padStart(2, "0");
  const result = resolveOutcomeEnvelope({
    execution_id: `exec-${index}`,
    ticket: "ZOU-1528",
    terminal_state: "failed",
    started_at: `2026-08-27T01:${minute}:00.000Z`,
    terminal_at: `2026-08-27T02:${minute}:00.000Z`,
    recorded_at: `2026-08-27T03:${minute}:00.000Z`,
    executor: { id: "executor-a", harness: "codex", model: "gpt-5.6" },
    commit_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    verification: {
      id: "verifier-b",
      harness: "postflight",
      model: "deterministic",
      verdict: "fail",
      decided_at: `2026-08-27T02:${minute}:30.000Z`,
      commit_digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      evidence_digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    },
  });
  if (result.ok === false) throw new Error(result.errors.join("; "));
  return result.envelope;
}

function held(index: number): OutcomeEnvelope {
  const row = measured(index);
  return {
    ...row,
    disposition: "held_unmeasured",
    verification: null,
    hold: { code: "missing", detail: "fixture" },
  };
}

function heldAccepted(index: number): OutcomeEnvelope {
  const minute = String(index % 60).padStart(2, "0");
  const result = resolveOutcomeEnvelope({
    execution_id: `accepted-held-${index}`,
    ticket: "ZOU-1528",
    terminal_state: "accepted",
    started_at: `2026-08-27T01:${minute}:00.000Z`,
    terminal_at: `2026-08-27T02:${minute}:00.000Z`,
    recorded_at: `2026-08-27T03:${minute}:00.000Z`,
    executor: { id: "executor-a", harness: "codex", model: "gpt-5.6" },
    commit_digest: null,
  });
  if (result.ok === false) throw new Error(result.errors.join("; "));
  return result.envelope;
}

describe("outcome coverage gate", () => {
  test("defaults off and never blocks collection or transitions", () => {
    const decision = evaluateOutcomeCoverage([]);
    expect(decision.mode).toBe("off");
    expect(decision.enforcement_active).toBeFalse();
    expect(decision.transition_allowed).toBeTrue();
    expect(decision.ready).toBeFalse();
  });

  test("shadow reports a would-block result without enforcing it", () => {
    const decision = evaluateOutcomeCoverage(Array.from({ length: 29 }, (_, index) => measured(index)), { mode: "shadow" });
    expect(decision.authorized).toBeTrue();
    expect(decision.ready).toBeFalse();
    expect(decision.would_block).toBeTrue();
    expect(decision.transition_allowed).toBeTrue();
  });

  test("requires at least 95 percent over the most recent 30 eligible terminals", () => {
    const passing = [...Array.from({ length: 29 }, (_, index) => measured(index)), held(29)];
    const failing = [...Array.from({ length: 28 }, (_, index) => measured(index)), held(28), held(29)];
    expect(evaluateOutcomeCoverage(passing, { mode: "shadow" }).ready).toBeTrue();
    expect(evaluateOutcomeCoverage(passing, { mode: "shadow" }).window_coverage).toBeCloseTo(29 / 30);
    expect(evaluateOutcomeCoverage(failing, { mode: "shadow" }).ready).toBeFalse();
  });

  test("ignores typed exclusions in the eligible rolling denominator", () => {
    const exclusion = resolveOutcomeEnvelope({
      execution_id: "excluded",
      ticket: "ZOU-1528",
      terminal_state: "held",
      started_at: "2026-08-27T00:00:00.000Z",
      terminal_at: "2026-08-27T00:01:00.000Z",
      recorded_at: "2026-08-27T00:02:00.000Z",
      executor: { id: "executor-a", harness: "codex", model: "gpt-5.6" },
      commit_digest: null,
      exclusion: { code: "operator_aborted", reason: "fixture" },
    });
    if (exclusion.ok === false) throw new Error(exclusion.errors.join("; "));
    const decision = evaluateOutcomeCoverage([
      exclusion.envelope,
      ...Array.from({ length: 30 }, (_, index) => measured(index)),
    ], { mode: "shadow" });
    expect(decision.eligible_total).toBe(30);
    expect(decision.ready).toBeTrue();
  });

  test("requires evidence on every successful terminal even when overall coverage exceeds 95 percent", () => {
    const decision = evaluateOutcomeCoverage([
      ...Array.from({ length: 29 }, (_, index) => measured(index)),
      heldAccepted(29),
    ], { mode: "shadow" });
    expect(decision.window_coverage).toBeCloseTo(29 / 30);
    expect(decision.successful_coverage).toBe(0);
    expect(decision.ready).toBeFalse();
  });

  test("fails closed when a mode exceeds the authorized shadow ceiling", () => {
    const decision = evaluateOutcomeCoverage(Array.from({ length: 30 }, (_, index) => measured(index)), { mode: "enforce" });
    expect(decision.authorized).toBeFalse();
    expect(decision.transition_allowed).toBeFalse();
    expect(decision.reason).toContain("exceeds the operator-authorized ceiling");
  });
});
