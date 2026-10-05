import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  OUTCOME_ENVELOPE_SCHEMA,
  parseOutcomeEnvelope,
  resolveOutcomeEnvelope,
  serializeOutcomeEnvelope,
  type OutcomeEnvelope,
  type OutcomeEvidenceFailure,
  type ResolveOutcomeEnvelopeInput,
} from "./outcome-envelope";

interface Fixture {
  name: string;
  input: ResolveOutcomeEnvelopeInput;
  disposition: OutcomeEnvelope["disposition"];
  hold_code: OutcomeEvidenceFailure | null;
}

const fixturePath = join(
  import.meta.dir,
  "..",
  "improvements-portfolio-2026-08-26",
  "01-outcome-evidence-coverage",
  "fixtures",
  "terminal-outcomes.json",
);
const fixtures = JSON.parse(readFileSync(fixturePath, "utf8")) as Fixture[];

describe("OutcomeEnvelope", () => {
  for (const fixture of fixtures) {
    test(`resolves ${fixture.name}`, () => {
      const result = resolveOutcomeEnvelope(fixture.input);
      expect(result.ok).toBeTrue();
      if (result.ok === false) return;
      expect(result.envelope.schema).toBe(OUTCOME_ENVELOPE_SCHEMA);
      expect(result.envelope.disposition).toBe(fixture.disposition);
      expect(result.envelope.hold?.code ?? null).toBe(fixture.hold_code);
      expect(parseOutcomeEnvelope(result.envelope).ok).toBeTrue();
    });
  }

  test("never accepts executor-authored verification as measured", () => {
    const base = fixtures[0]?.input;
    expect(base).toBeDefined();
    if (!base || typeof base.verification !== "object" || base.verification === null) return;
    const result = resolveOutcomeEnvelope({
      ...base,
      verification: { ...base.verification, id: "executor-a" },
    });
    expect(result.ok).toBeTrue();
    if (result.ok === false) return;
    expect(result.envelope.disposition).toBe("held_unmeasured");
    expect(result.envelope.hold?.code).toBe("forged");
  });

  test("supports a reconciliation-owned duplicate hold without counting it as measured", () => {
    const result = resolveOutcomeEnvelope({
      ...fixtures[0]!.input,
      forced_hold: { code: "duplicate", detail: "two verdict sidecars claim the execution" },
    });
    expect(result.ok).toBeTrue();
    if (result.ok === false) return;
    expect(result.envelope.disposition).toBe("held_unmeasured");
    expect(result.envelope.hold?.code).toBe("duplicate");
    expect(parseOutcomeEnvelope(result.envelope).ok).toBeTrue();
  });

  test("rejects unknown fields at every strict schema boundary", () => {
    const result = resolveOutcomeEnvelope(fixtures[0]!.input);
    expect(result.ok).toBeTrue();
    if (result.ok === false) return;
    const parsed = parseOutcomeEnvelope({ ...result.envelope, surprise: true });
    expect(parsed.ok).toBeFalse();
    if (parsed.ok === true) return;
    expect(parsed.errors).toContain("envelope.surprise: unknown field");
  });

  test("rejects a forged disposition or hold classification", () => {
    const result = resolveOutcomeEnvelope(fixtures[3]!.input);
    expect(result.ok).toBeTrue();
    if (result.ok === false) return;
    const forged = { ...result.envelope, disposition: "measured", hold: null };
    const parsed = parseOutcomeEnvelope(forged);
    expect(parsed.ok).toBeFalse();
  });

  test("serializes deterministically regardless of input property order", () => {
    const result = resolveOutcomeEnvelope(fixtures[0]!.input);
    expect(result.ok).toBeTrue();
    if (result.ok === false) return;
    const reversed = Object.fromEntries(Object.entries(result.envelope).reverse());
    const parsed = parseOutcomeEnvelope(reversed);
    expect(parsed.ok).toBeTrue();
    if (parsed.ok === false) return;
    expect(serializeOutcomeEnvelope(parsed.envelope)).toBe(serializeOutcomeEnvelope(result.envelope));
  });
});
