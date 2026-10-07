import { describe, expect, test } from "bun:test";
import { describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import {
  PANEL_ROSTER,
  PERSONA_PANEL_SCHEMA_VERSION,
  assessPanelReadiness,
  buildPersonaPanel,
  collectDegradations,
  hashPanel,
  harnessIsAvailable,
  loadPersonaPanel,
  persistPersonaPanel,
  probeHarnessAvailability,
  resolveSeatHarness,
  validatePersonaPanel,
  type AvailabilityMap,
  type PersonaPanelArtifact,
} from "./persona-panel";

const nothingLive: AvailabilityMap = {};

const onlyCodexLive: AvailabilityMap = {
  codex: { registered: true, executable: true },
};

describe("persona panel identity", () => {
  test("diversity axis is persona, not model", () => {
    const panel = buildPersonaPanel({ availability: onlyCodexLive });
    expect(panel.diversityAxis).toBe("persona");
    expect(panel.schemaVersion).toBe(PERSONA_PANEL_SCHEMA_VERSION);
  });

  test("three reviewer personas are distinct", () => {
    const panel = buildPersonaPanel({ availability: onlyCodexLive });
    const ids = panel.reviewers.map((s) => s.personaId);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    expect(validatePersonaPanel(panel).valid).toBe(true);
  });

  test("adjudicator persona is distinct from every reviewer", () => {
    const panel = buildPersonaPanel({ availability: onlyCodexLive });
    expect(panel.adjudicator.personaId).not.toBe(panel.reviewers[0].personaId);
    expect(panel.adjudicator.role).toBe("adjudicator");
  });

  test("roster names the operator-requested roles", () => {
    const reviewers = PANEL_ROSTER.filter((r) => r.role === "reviewer").map((r) => r.personaName);
    expect(reviewers).toEqual(["AI Engineer", "Zouroboros Engineer", "Security Engineer"]);
  });

  test("adjudicator is a fourth, separate roster seat", () => {
    const adjudicators = PANEL_ROSTER.filter((r) => r.role === "adjudicator");
    expect(adjudicators).toHaveLength(1);
    expect(adjudicators[0].personaName).toBe("Reality Checker");
    expect(PANEL_ROSTER).toHaveLength(4);
  });

  test("execution model never becomes the identity axis", () => {
    const panel = buildPersonaPanel({ availability: onlyCodexLive });
    // All seats may legitimately share one execution model and still validate,
    // because independence is carried by persona, not by model vendor.
    const models = [...panel.reviewers, panel.adjudicator].map((s) => s.executionModel);
    expect(new Set(models).size).toBeLessThanOrEqual(3);
    expect(validatePersonaPanel(panel).valid).toBe(true);
  });
});

describe("harness availability failover", () => {
  test("registered but non-executable counts as unavailable", () => {
    expect(
      harnessIsAvailable("codex", { codex: { registered: true, executable: false } }),
    ).toBe(false);
  });

  test("executable but unregistered counts as unavailable", () => {
    expect(
      harnessIsAvailable("codex", { codex: { registered: false, executable: true } }),
    ).toBe(false);
  });

  test("needs both registered and executable", () => {
    expect(
      harnessIsAvailable("codex", { codex: { registered: true, executable: true } }),
    ).toBe(true);
  });

  test("resolves to the primary when it is live", () => {
    const panel = buildPersonaPanel({
      availability: { "claude-code": { registered: true, executable: true } },
    });
    expect(panel.reviewers[0].resolvedHarness).toBe("claude-code");
    expect(panel.reviewers[0].degraded).toBe(false);
  });

  test("falls through the chain when the primary is down", () => {
    // gemini is reviewer-3's primary; codex is its first fallback.
    const seat = buildPersonaPanel({ availability: onlyCodexLive }).reviewers[2];
    expect(seat.degraded).toBe(true);
    expect(seat.resolvedHarness).toBe("codex");
  });

  test("holds the seat when no harness in the chain is live", () => {
    const panel = buildPersonaPanel({ availability: nothingLive });
    for (const seat of panel.reviewers) {
      expect(seat.resolvedHarness).toBeNull();
      // A held seat is the most degraded state there is; it must never read false.
      expect(seat.degraded).toBe(true);
    }
    expect(panel.policy.unavailableSeat).toBe("hold");
  });

  test("holds the seat when only an unregistered harness is present", () => {
    const panel = buildPersonaPanel({
      availability: { "claude-code": { registered: true, executable: false } },
    });
    expect(panel.reviewers[0].resolvedHarness).toBeNull();
  });

  test("resolveSeatHarness honours an explicit chain order", () => {
    const resolved = resolveSeatHarness(
      { harness: "a", chain: ["a", "b", "c"] },
      { c: { registered: true, executable: true } },
    );
    expect(resolved.harness).toBe("c");
    expect(resolved.degraded).toBe(true);
  });

  test("resolveSeatHarness returns null when the chain is exhausted", () => {
    const resolved = resolveSeatHarness({ harness: "a", chain: ["a", "b"] }, nothingLive);
    expect(resolved.harness).toBeNull();
    expect(resolved.degraded).toBe(true);
  });

  test("rejects a binding whose primary is absent from its own chain", () => {
    const resolved = resolveSeatHarness({ harness: "z", chain: ["a", "b"] }, {
      a: { registered: true, executable: true },
    });
    expect(resolved.harness).toBeNull();
    expect(resolved.reason).toContain("missing from its own chain");
  });

  test("never resolves to the same harness twice across a seat chain", () => {
    for (const seat of PANEL_ROSTER) {
      expect(new Set(seat.binding.chain).size).toBe(seat.binding.chain.length);
    }
  });
});

describe("panel integrity", () => {
  test("panel stays in shadow regardless of availability", () => {
    const panel = buildPersonaPanel({
      availability: {
        "claude-code": { registered: true, executable: true },
        codex: { registered: true, executable: true },
        gemini: { registered: true, executable: true },
        hermes: { registered: true, executable: true },
      },
    });
    expect(panel.status).toBe("shadow");
    expect(validatePersonaPanel(panel).valid).toBe(true);
  });

  test("panel hash is stable and content-sensitive", () => {
    const a = buildPersonaPanel({ availability: onlyCodexLive });
    const b = buildPersonaPanel({ availability: onlyCodexLive });
    expect(hashPanel(a)).toBe(hashPanel(b));

    const tampered: PersonaPanelArtifact = structuredClone(a);
    tampered.reviewers[0].personaId = "00000000-0000-4000-8000-000000000000";
    expect(hashPanel(tampered)).not.toBe(hashPanel(a));
  });

  test("rejects a duplicated reviewer persona", () => {
    const panel = buildPersonaPanel({ availability: onlyCodexLive });
    panel.reviewers[1].personaId = panel.reviewers[0].personaId;
    const result = validatePersonaPanel(panel);
    expect(result.valid).toBe(false);
    expect(result.errors.join(" ")).toContain("distinct");
  });

  test("rejects a panel whose hash no longer matches its seats", () => {
    const panel = buildPersonaPanel({ availability: onlyCodexLive });
    panel.reviewers[0].domain = "tampered";
    expect(validatePersonaPanel(panel).errors.join(" ")).toContain("panelHash does not match");
  });

  test("a held panel is still structurally valid", () => {
    // Hold is a ruling, not a defect. If held seats invalidated the panel it
    // could not be persisted, and the audit record would be lost.
    const panel = buildPersonaPanel({ availability: nothingLive });
    expect(validatePersonaPanel(panel).valid).toBe(true);
  });
});

describe("readiness ruling", () => {
  test("a fully resolved panel convenes", () => {
    const panel = buildPersonaPanel({
      availability: {
        "claude-code": { registered: true, executable: true },
        codex: { registered: true, executable: true },
        gemini: { registered: true, executable: true },
        hermes: { registered: true, executable: true },
      },
    });
    const readiness = assessPanelReadiness(panel);
    expect(readiness.decision).toBe("REVIEW");
    expect(readiness.ready).toBe(true);
    expect(readiness.heldSeats).toEqual([]);
  });

  test("a held seat holds the gate rather than convening a reduced quorum", () => {
    const panel = buildPersonaPanel({ availability: nothingLive });
    const readiness = assessPanelReadiness(panel);
    expect(readiness.ready).toBe(false);
    expect(readiness.decision).toBe("HOLD");
    expect(readiness.heldSeats).toEqual(["reviewer-1", "reviewer-2", "reviewer-3", "adjudicator"]);
    expect(readiness.reason).toContain("unavailableSeat=hold");
  });

  test("one dead harness fails over instead of holding", () => {
    const panel = buildPersonaPanel({
      availability: {
        "claude-code": { registered: true, executable: true },
        codex: { registered: true, executable: true },
        gemini: { registered: true, executable: true },
      },
    });
    const readiness = assessPanelReadiness(panel);
    // Only claude-code, codex and gemini are live; the adjudicator's hermes
    // primary fails over, so the panel still convenes.
    expect(readiness.decision).toBe("REVIEW");
    expect(readiness.degradations.join(" ")).toContain("failed over from hermes");
  });

  test("harness collapse is recorded as a degradation, not a rejection", () => {
    // Only codex is live, so all four seats land on it. The panel must still be
    // valid: independence is persona-carried, per Art. II.
    const panel = buildPersonaPanel({ availability: onlyCodexLive });
    expect(validatePersonaPanel(panel).valid).toBe(true);
    expect(panel.degradations.join(" ")).toContain("independence rests on persona and domain separation alone");
  });

  test("degradations are empty when the panel is served as chartered", () => {
    const panel = buildPersonaPanel({
      availability: {
        "claude-code": { registered: true, executable: true },
        codex: { registered: true, executable: true },
        gemini: { registered: true, executable: true },
        hermes: { registered: true, executable: true },
      },
    });
    expect(panel.degradations).toEqual([]);
  });

  test("a tampered panel is held even when every harness is live", () => {
    const panel = buildPersonaPanel({
      availability: {
        "claude-code": { registered: true, executable: true },
        codex: { registered: true, executable: true },
        gemini: { registered: true, executable: true },
        hermes: { registered: true, executable: true },
      },
    });
    panel.reviewers[0].domain = "tampered";
    const readiness = assessPanelReadiness(panel);
    expect(readiness.decision).toBe("HOLD");
    expect(readiness.reason).toContain("structural validation");
  });

  test("a held panel round-trips through persistence", () => {
    const panel = buildPersonaPanel({ availability: nothingLive, generatedAt: "2026-10-02T00:00:00.000Z" });
    const target = `${path.join(os.tmpdir(), `zo-panel-${process.pid}.json`)}`;
    persistPersonaPanel(panel, target);
    const reloaded = loadPersonaPanel(target);
    fs.unlinkSync(target);
    expect(reloaded.panelHash).toBe(panel.panelHash);
    expect(assessPanelReadiness(reloaded).decision).toBe("HOLD");
  });
});

describe("live host probe", () => {
  test("reports real availability for the registered harnesses", () => {
    const availability = probeHarnessAvailability();
    expect(Object.keys(availability).length).toBeGreaterThan(0);
    for (const state of Object.values(availability)) {
      expect(typeof state.registered).toBe("boolean");
      expect(typeof state.executable).toBe("boolean");
    }
  });

  test("every roster chain resolves when all harnesses are live", () => {
    const allLive: AvailabilityMap = Object.fromEntries(
      Object.keys(probeHarnessAvailability()).map((id) => [id, { registered: true, executable: true }]),
    );
    expect(Object.keys(allLive).length).toBeGreaterThan(0);
    for (const seat of buildPersonaPanel({ availability: allLive }).reviewers) {
      expect(seat.resolvedHarness).not.toBeNull();
      expect(seat.degraded).toBe(false);
    }
  });
});

// These assert what this particular machine has installed. CI runners have no
// harness binaries, so running them there would fail on a fact about the runner
// rather than about the panel.
describe.skipIf(process.env.CI)("live host expectations", () => {
  test("claude-code is live on this host", () => {
    const availability = probeHarnessAvailability();
    expect(harnessIsAvailable("claude-code", availability)).toBe(true);
  });

  test("every roster chain resolves against the live host", () => {
    const availability = probeHarnessAvailability();
    for (const seat of buildPersonaPanel({ availability }).reviewers) {
      expect(seat.resolvedHarness).not.toBeNull();
    }
  });
});
