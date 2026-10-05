import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ARTIFACT_KINDS,
  ATTEMPT_STATUSES,
  AUTHORITY_KINDS,
  canonicalize,
  CHECK_KINDS,
  CONTRACT_ID,
  EVENT_KINDS,
  eventsAfterCursor,
  finalizeReceipt,
  mapLegacyShippingOutcome,
  parseRunReceipt,
  ReceiptContractError,
  reconstructRunReceipt,
  redactReceipt,
  SIDE_EFFECT_KINDS,
  TERMINAL_OUTCOMES,
  TRIGGER_KINDS,
  validateReceiptSet,
  validateRunReceipt,
  type ReceiptErrorCode,
  type RunReceipt,
} from "./run-receipt-contract";
import { sha256Hex, validateAuthorityEvents, validateCapabilityEnvelopeBlock } from "./authority-envelope";

const FACTORY_DIR = join(import.meta.dir, "..");
const FIXTURE_DIR = join(FACTORY_DIR, "fixtures", "run-receipt");
const SCHEMA_PATH = join(FACTORY_DIR, "contracts", "run-receipt-v1.schema.json");

interface Mutation {
  op: "set" | "remove";
  path: Array<string | number>;
  value?: unknown;
}

interface FixtureCase {
  name: string;
  valid: boolean;
  mode: "receipt" | "redaction" | "receipt_set" | "cursor" | "reconstruction";
  expected_error?: ReceiptErrorCode;
  cursor?: string;
  expected_sequences?: number[];
  redact_paths?: string[];
  mutations: Mutation[];
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function rawBase(): RunReceipt {
  return readJson(join(FIXTURE_DIR, "valid-success.json")) as RunReceipt;
}

function baseReceipt(): RunReceipt {
  return finalizeReceipt(rawBase());
}

function applyMutations<T>(input: T, mutations: readonly Mutation[]): T {
  const output = clone(input) as unknown as Record<string, unknown>;
  for (const mutation of mutations) {
    let current: unknown = output;
    for (const part of mutation.path.slice(0, -1)) current = (current as Record<string | number, unknown>)[part];
    const key = mutation.path.at(-1)!;
    if (mutation.op === "remove") {
      if (Array.isArray(current) && typeof key === "number") current.splice(key, 1);
      else delete (current as Record<string | number, unknown>)[key];
    } else {
      (current as Record<string | number, unknown>)[key] = clone(mutation.value);
    }
  }
  return output as unknown as T;
}

function materialize(fixture: FixtureCase): RunReceipt {
  return finalizeReceipt(applyMutations(rawBase(), fixture.mutations));
}

const corpus = readJson(join(FIXTURE_DIR, "cases.json")) as { fixture_version: number; base: string; cases: FixtureCase[] };

describe("canonical run-receipt v1 schema", () => {
  test("schema and exported structural vocabularies agree", () => {
    const schema = readJson(SCHEMA_PATH) as any;
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://zouroboros.ai/schemas/run-receipt-v1.schema.json");
    expect(schema.properties.contract_id.const).toBe(CONTRACT_ID);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.event.additionalProperties).toBe(false);
    expect(schema.$defs.trigger.properties.kind.enum).toEqual([...TRIGGER_KINDS]);
    expect(schema.$defs.authority.properties.envelope_kind.enum).toEqual([...AUTHORITY_KINDS]);
    expect(schema.$defs.event.properties.kind.enum).toEqual([...EVENT_KINDS]);
    expect(schema.$defs.attempt.properties.status.enum).toEqual([...ATTEMPT_STATUSES]);
    expect(schema.$defs.sideEffect.properties.kind.enum).toEqual([...SIDE_EFFECT_KINDS]);
    expect(schema.$defs.terminal.properties.outcome.enum).toEqual([...TERMINAL_OUTCOMES]);
    expect(schema.$defs.verificationCheck.properties.kind.enum).toEqual([...CHECK_KINDS]);
    expect(schema.$defs.artifact.properties.kind.enum).toEqual([...ARTIFACT_KINDS]);
  });

  test("fixture corpus contains every required scenario", () => {
    expect(corpus.fixture_version).toBe(1);
    expect(corpus.base).toBe("valid-success.json");
    expect(corpus.cases.length).toBeGreaterThanOrEqual(12);
    expect(corpus.cases.map((entry) => entry.name)).toEqual([
      "success",
      "failure",
      "partial-timeout",
      "cancelled",
      "expired-authority-failure",
      "autonomy-shadow",
      "consensus-evaluation",
      "contradictory-ledger",
      "redacted-secrets",
      "duplicate-idempotency-conflict",
      "cursor-resume",
      "missing-edge-proof",
      "restart-rebuild",
      "conflicting-writer",
      "missing-transition",
      "dangling-tool-call",
    ]);
  });
});

describe("canonical fixture corpus", () => {
  for (const fixture of corpus.cases) {
    test(fixture.name, () => {
      if (fixture.mode === "redaction") {
        const unredacted = applyMutations(rawBase(), fixture.mutations);
        const receipt = redactReceipt(unredacted, fixture.redact_paths ?? [], "fixture redaction");
        const result = validateRunReceipt(receipt);
        expect(result.errors).toEqual([]);
        expect(result.ok).toBe(true);
        expect(canonicalize(receipt)).not.toContain("fixture-secret-value");
        expect(receipt.versions.tool_versions.api_token).toBe("[REDACTED]");
        return;
      }

      const receipt = materialize(fixture);
      if (fixture.mode === "receipt_set") {
        const conflicting = clone(receipt);
        conflicting.receipt_id = "rr-01J00000000000000000000002";
        conflicting.operation_id = "op-01J00000000000000000000002";
        conflicting.trigger.input_hash = "9999999999999999999999999999999999999999999999999999999999999999";
        conflicting.events = conflicting.events.map((event) => ({
          ...event,
          cursor: `rrc:op-01J00000000000000000000002:${event.sequence}`,
        }));
        const result = validateReceiptSet([receipt, finalizeReceipt(conflicting)]);
        expect(result.ok).toBe(false);
        expect(result.errors.some((error) => error.code === fixture.expected_error)).toBe(true);
        return;
      }

      if (fixture.mode === "cursor") {
        const events = eventsAfterCursor(receipt, fixture.cursor!);
        expect(events.map((event) => event.sequence)).toEqual(fixture.expected_sequences!);
        expect(validateRunReceipt(receipt).ok).toBe(true);
        return;
      }

      if (fixture.mode === "reconstruction") {
        const shuffled = [
          receipt.events[4], receipt.events[0], receipt.events[6], receipt.events[2],
          receipt.events[1], receipt.events[3], receipt.events[5], clone(receipt.events[3]),
        ];
        const rebuilt = reconstructRunReceipt(receipt, shuffled);
        expect(canonicalize(rebuilt)).toBe(canonicalize(receipt));
        expect(rebuilt.receipt_hash).toBe(receipt.receipt_hash);
        expect(validateRunReceipt(rebuilt).ok).toBe(true);
        return;
      }

      const result = validateRunReceipt(receipt);
      expect(result.ok).toBe(fixture.valid);
      if (fixture.valid) expect(result.errors).toEqual([]);
      else expect(result.errors.some((error) => error.code === fixture.expected_error)).toBe(true);
    });
  }
});

describe("receipt semantics", () => {
  test("parser returns an immutable copy of a valid receipt", () => {
    const receipt = baseReceipt();
    const parsed = parseRunReceipt(receipt);
    parsed.trigger.intent = "changed copy";
    expect(receipt.trigger.intent).toBe("Validate canonical run receipt");
  });

  test("a dropped delivery edge preserves completed execution without claiming visibility", () => {
    const receipt = rawBase();
    receipt.events = receipt.events.slice(0, -1);
    receipt.acknowledgements.user_visible = null;
    receipt.observation.user_visible_outcome = null;
    const finalized = finalizeReceipt(receipt);
    expect(validateRunReceipt(finalized)).toEqual({ ok: true, errors: [] });
    expect(finalized.acknowledgements.completed?.event_id).toBe("evt-operation-complete");
    expect(finalized.acknowledgements.user_visible).toBeNull();
  });

  test("content mutation after finalization fails hash verification", () => {
    const receipt = baseReceipt();
    receipt.observation.user_visible_outcome = "tampered";
    const result = validateRunReceipt(receipt);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "hash_mismatch")).toBe(true);
  });

  test("cursor errors are explicit and operation-bound", () => {
    const receipt = baseReceipt();
    expect(() => eventsAfterCursor(receipt, "bad")).toThrow(ReceiptContractError);
    expect(() => eventsAfterCursor(receipt, "rrc:op-01J00000000000000000000002:1")).toThrow("another operation");
    expect(() => eventsAfterCursor(receipt, "rrc:op-01J00000000000000000000001:99")).toThrow("beyond");
  });

  test("legacy shipping outcomes remain readable without rewriting legacy state", () => {
    expect(mapLegacyShippingOutcome("merged")).toBe("success");
    expect(mapLegacyShippingOutcome("accepted")).toBe("success");
    expect(mapLegacyShippingOutcome("failed")).toBe("failure");
    expect(mapLegacyShippingOutcome("needs-review")).toBe("held");
    expect(mapLegacyShippingOutcome("merge_queued")).toBeNull();
  });

  test("the validator rejects unknown top-level fields", () => {
    const receipt = baseReceipt() as RunReceipt & { unexpected?: boolean };
    receipt.unexpected = true;
    const result = validateRunReceipt(receipt);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "schema_invalid" && error.path === "/unexpected")).toBe(true);
  });

  test("the validator rejects unknown nested fields like the JSON Schema", () => {
    const receipt = baseReceipt() as RunReceipt & { trigger: RunReceipt["trigger"] & { unexpected?: boolean } };
    receipt.trigger.unexpected = true;
    const result = validateRunReceipt(receipt);
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "schema_invalid" && error.path === "/trigger/unexpected")).toBe(true);
  });
});

describe("additive authority embedding (ZOU-1059)", () => {
  const embeddedBlock = {
    envelope_ref: "fixtures/authority-envelope/valid-envelope.json",
    envelope_sha256: sha256Hex("embedded-envelope"),
    evaluation_summary: { decision: "PERMIT", evaluated_at: "2026-06-01T12:00:00Z", reason_count: 0 },
  };
  const embeddedEvents = [
    { sequence: 1, kind: "violation", capability: "factory.contract-test", decision: "DENY", reason: "resource_not_listed", ts: "2026-06-01T12:00:00Z" },
    { sequence: 2, kind: "decision", capability: "factory.contract-test", decision: "DENY", reason: null, ts: "2026-06-01T12:00:00Z" },
  ];

  test("the authority required set is unchanged by the additive embedding", () => {
    const schema = readJson(SCHEMA_PATH) as any;
    expect(schema.$defs.authority.required).toEqual([
      "envelope_kind",
      "approving_authority",
      "approval_ts",
      "approval_ref",
      "autonomy_tier",
      "authorization_evidence_ref",
    ]);
    expect(schema.$defs.authority.required).not.toContain("capability_envelope");
    expect(schema.$defs.authority.required).not.toContain("authority_events");
    expect(schema.required).not.toContain("capability_envelope");
  });

  test("capability_envelope and authority_events are declared with closed additive shapes", () => {
    const schema = readJson(SCHEMA_PATH) as any;
    expect(schema.$defs.authority.properties.capability_envelope).toEqual({ $ref: "#/$defs/capabilityEnvelope" });
    expect(schema.$defs.authority.properties.authority_events).toEqual({
      type: "array",
      items: { $ref: "#/$defs/authorityEvent" },
    });
    expect(schema.$defs.capabilityEnvelope.required).toEqual(["envelope_ref", "envelope_sha256", "evaluation_summary"]);
    expect(schema.$defs.capabilityEnvelope.additionalProperties).toBe(false);
    expect(schema.$defs.authorityEvent.required).toEqual(["sequence", "kind", "capability", "decision", "reason", "ts"]);
    expect(schema.$defs.authorityEvent.additionalProperties).toBe(false);
    expect(schema.$defs.authorityEvent.properties.kind.enum).toEqual(["decision", "violation"]);
    expect(schema.$defs.authorityEvent.properties.decision.enum).toEqual(["PERMIT", "DENY"]);
  });

  test("embedded authority blocks validate through the envelope module", () => {
    expect(validateCapabilityEnvelopeBlock(embeddedBlock)).toEqual({ ok: true, issues: [] });
    expect(validateAuthorityEvents(embeddedEvents)).toEqual({ ok: true, issues: [] });
    expect(validateCapabilityEnvelopeBlock({ ...embeddedBlock, unexpected: true }).ok).toBe(false);
  });

  test("legacy fixtures carry no embedding and continue to validate unchanged", () => {
    const raw = rawBase();
    expect("capability_envelope" in raw.authority).toBe(false);
    expect("authority_events" in raw.authority).toBe(false);
    expect(validateRunReceipt(finalizeReceipt(rawBase()))).toEqual({ ok: true, errors: [] });
  });

  test("runtime validator acceptance of embedded authority remains deferred behind activation authority", () => {
    const receipt = rawBase() as RunReceipt & { authority: RunReceipt["authority"] & { capability_envelope?: unknown } };
    receipt.authority.capability_envelope = embeddedBlock;
    const result = validateRunReceipt(finalizeReceipt(receipt));
    expect(result.ok).toBe(false);
    expect(result.errors.some((error) => error.code === "schema_invalid" && error.path === "/authority/capability_envelope")).toBe(true);
  });
});
