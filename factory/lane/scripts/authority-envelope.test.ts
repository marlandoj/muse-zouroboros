import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTHORITY_EVENT_KINDS,
  buildDrillEnvelope,
  buildDrillRequest,
  composeEffectiveRung,
  DECISIONS,
  DELEGATION_DIMENSIONS,
  DENY_REASONS,
  ENVELOPE_CONTRACT_ID,
  ENVELOPE_RUNGS,
  ENVELOPE_TERMINAL_OUTCOMES,
  EVIDENCE_KINDS,
  evaluateRequest,
  ISOLATION_MODES,
  LIFETIME_KINDS,
  loadGlobalRungFixture,
  PRINCIPAL_KINDS,
  revokeTerminalGrants,
  runRollbackDrill,
  sha256Hex,
  validateAuthorityEvents,
  validateCapabilityEnvelopeBlock,
  validateDelegation,
  validateEnvelope,
  type AuthorityEnvelope,
  type Decision,
  type DelegationDimension,
  type DenyReason,
  type EvaluationContext,
  type EvaluationRequest,
} from "./authority-envelope";

const FACTORY_DIR = join(import.meta.dir, "..");
const FIXTURE_DIR = join(FACTORY_DIR, "fixtures", "authority-envelope");
const SCHEMA_PATH = join(FACTORY_DIR, "contracts", "authority-envelope-v1.schema.json");
const SCRIPT_PATH = join(import.meta.dir, "authority-envelope.ts");

interface Mutation {
  op: "set" | "remove";
  path: Array<string | number>;
  value?: unknown;
}

interface CorpusCase {
  name: string;
  mode: "evaluate" | "delegate" | "compose" | "embedding-block" | "embedding-events";
  expect?: Decision;
  expected_reasons?: DenyReason[];
  expected_dimensions?: DelegationDimension[];
  envelope_mutations?: Mutation[];
  request_mutations?: Mutation[];
  child_mutations?: Mutation[];
  context?: EvaluationContext;
  global?: string;
  cap?: string;
  expected?: string;
  valid?: boolean;
  mutations?: Mutation[];
}

interface Corpus {
  fixture_version: number;
  base_envelope: string;
  base_request: string;
  delegation_child: string;
  global_rung: string;
  base_embedding_block: unknown;
  base_authority_events: unknown[];
  cases: CorpusCase[];
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function applyMutations<T>(input: T, mutations: readonly Mutation[]): T {
  const output = clone(input) as unknown as Record<string | number, unknown>;
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

const corpus = readJson(join(FIXTURE_DIR, "cases.json")) as Corpus;
const baseEnvelope = readJson(join(FIXTURE_DIR, corpus.base_envelope)) as AuthorityEnvelope;
const baseRequest = readJson(join(FIXTURE_DIR, corpus.base_request)) as EvaluationRequest;
const childEnvelope = readJson(join(FIXTURE_DIR, corpus.delegation_child)) as AuthorityEnvelope;

function runCli(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["bun", SCRIPT_PATH, ...args], { stdout: "pipe", stderr: "pipe" });
  return {
    exitCode: result.exitCode,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

describe("authority-envelope schema agreement", () => {
  const schema = readJson(SCHEMA_PATH) as any;

  test("schema and exported structural vocabularies agree", () => {
    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
    expect(schema.$id).toBe("https://zouroboros.ai/schemas/authority-envelope-v1.schema.json");
    expect(schema.properties.contract_id.const).toBe(ENVELOPE_CONTRACT_ID);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.$defs.rung.enum).toEqual([...ENVELOPE_RUNGS]);
    expect(schema.$defs.principal.properties.kind.enum).toEqual([...PRINCIPAL_KINDS]);
    expect(schema.$defs.environment.properties.isolation_mode.enum).toEqual([...ISOLATION_MODES]);
    expect(schema.$defs.lifetime.properties.kind.enum).toEqual([...LIFETIME_KINDS]);
    expect(schema.$defs.approvalBinding.properties.required_terminal_outcome.enum).toEqual([...ENVELOPE_TERMINAL_OUTCOMES, null]);
    expect(schema.$defs.enforcementEvidence.properties.kind.enum).toEqual([...EVIDENCE_KINDS]);
    expect(schema.required).toEqual([
      "contract_id",
      "schema_version",
      "envelope_id",
      "principal",
      "capabilities",
      "validity",
      "environment",
      "approval_binding",
      "global_rung_cap",
      "delegation",
      "integration_refs",
      "enforcement_evidence",
    ]);
    expect(schema.$defs.capabilityGrant.required).toContain("revoked_at");
    expect(schema.$defs.capabilityGrant.additionalProperties).toBe(false);
  });

  test("the fixture-pinned global rung ladder matches the schema and module vocabularies", () => {
    const fixture = loadGlobalRungFixture(join(FIXTURE_DIR, corpus.global_rung));
    expect(fixture.ladder).toEqual([...ENVELOPE_RUNGS]);
    expect(schema.$defs.rung.enum).toEqual(fixture.ladder);
    expect(fixture.ladder.includes(fixture.current)).toBe(true);
  });

  test("base fixtures are structurally valid", () => {
    expect(validateEnvelope(baseEnvelope)).toEqual({ ok: true, issues: [] });
    expect(validateEnvelope(childEnvelope)).toEqual({ ok: true, issues: [] });
    expect(sha256Hex("authority-envelope-fixture-evidence-v1")).toBe(baseEnvelope.enforcement_evidence.sha256);
  });

  test("fixture corpus contains every required scenario", () => {
    expect(corpus.fixture_version).toBe(1);
    expect(corpus.cases.length).toBeGreaterThanOrEqual(40);
    const names = corpus.cases.map((entry) => entry.name);
    expect(new Set(names).size).toBe(names.length);
    const modes = new Set(corpus.cases.map((entry) => entry.mode));
    expect([...modes].sort()).toEqual(["compose", "delegate", "embedding-block", "embedding-events", "evaluate"]);
  });
});

describe("fail-closed evaluation corpus", () => {
  for (const fixture of corpus.cases.filter((entry) => entry.mode === "evaluate")) {
    test(fixture.name, () => {
      const envelope = applyMutations(baseEnvelope, fixture.envelope_mutations ?? []);
      const request = applyMutations(baseRequest, fixture.request_mutations ?? []);
      const result = evaluateRequest(envelope, request, fixture.context ?? { receipt_terminalized: false, terminal_outcome: null });
      expect(result.decision).toBe(fixture.expect!);
      if (fixture.expect === "PERMIT") {
        expect(result.reasons).toEqual([]);
      } else {
        for (const reason of fixture.expected_reasons!) expect(result.reasons).toContain(reason);
      }
      const last = result.events.at(-1)!;
      expect(last.kind).toBe("decision");
      expect(last.decision).toBe(result.decision);
      expect(result.events.map((event) => event.sequence)).toEqual(result.events.map((_, index) => index + 1));
      expect(validateAuthorityEvents(result.events).ok).toBe(true);
    });
  }

  test("every deny fixture in the corpus denies", () => {
    const denyCases = corpus.cases.filter((entry) => entry.mode === "evaluate" && entry.expect === "DENY");
    expect(denyCases.length).toBeGreaterThanOrEqual(15);
    for (const fixture of denyCases) {
      const envelope = applyMutations(baseEnvelope, fixture.envelope_mutations ?? []);
      const request = applyMutations(baseRequest, fixture.request_mutations ?? []);
      const result = evaluateRequest(envelope, request, fixture.context ?? { receipt_terminalized: false, terminal_outcome: null });
      expect(result.decision).toBe("DENY");
    }
  });
});

describe("delegation subset proof", () => {
  for (const fixture of corpus.cases.filter((entry) => entry.mode === "delegate")) {
    test(fixture.name, () => {
      const child = applyMutations(childEnvelope, fixture.child_mutations ?? []);
      const result = validateDelegation(baseEnvelope, child);
      if (fixture.expect === "PERMIT") {
        expect(result.ok).toBe(true);
        expect(result.issues).toEqual([]);
        expect(result.events.at(-1)!.decision).toBe("PERMIT");
      } else {
        expect(result.ok).toBe(false);
        const dimensions = [...new Set(result.issues.map((issue) => issue.dimension))];
        expect(dimensions.sort()).toEqual([...fixture.expected_dimensions!].sort());
        expect(result.events.some((event) => event.kind === "violation" && event.reason === "delegation_excess")).toBe(true);
        expect(result.events.at(-1)!.decision).toBe("DENY");
      }
    });
  }

  test("delegation dimensions vocabulary is closed", () => {
    for (const fixture of corpus.cases.filter((entry) => entry.mode === "delegate")) {
      for (const dimension of fixture.expected_dimensions ?? []) {
        expect(DELEGATION_DIMENSIONS).toContain(dimension);
      }
    }
  });
});

describe("cap-only rung composition", () => {
  for (const fixture of corpus.cases.filter((entry) => entry.mode === "compose")) {
    test(fixture.name, () => {
      expect(composeEffectiveRung(fixture.global!, fixture.cap!)).toBe(fixture.expected! as (typeof ENVELOPE_RUNGS)[number]);
    });
  }

  test("no global/cap pair can raise the effective rung above the global rung", () => {
    for (const globalRung of ENVELOPE_RUNGS) {
      for (const cap of ENVELOPE_RUNGS) {
        const effective = composeEffectiveRung(globalRung, cap);
        expect(ENVELOPE_RUNGS.indexOf(effective)).toBeLessThanOrEqual(ENVELOPE_RUNGS.indexOf(globalRung));
      }
    }
  });

  test("no corpus envelope can raise the fixture-pinned global rung", () => {
    const fixture = loadGlobalRungFixture(join(FIXTURE_DIR, corpus.global_rung));
    const globalIndex = ENVELOPE_RUNGS.indexOf(fixture.current as (typeof ENVELOPE_RUNGS)[number]);
    const envelopes: AuthorityEnvelope[] = [baseEnvelope, childEnvelope];
    for (const entry of corpus.cases.filter((item) => item.mode === "evaluate")) {
      envelopes.push(applyMutations(baseEnvelope, entry.envelope_mutations ?? []));
    }
    for (const envelope of envelopes) {
      const effective = composeEffectiveRung(fixture.current, (envelope as { global_rung_cap: string }).global_rung_cap);
      expect(ENVELOPE_RUNGS.indexOf(effective)).toBeLessThanOrEqual(globalIndex);
    }
  });
});

describe("receipt embedding blocks", () => {
  for (const fixture of corpus.cases.filter((entry) => entry.mode === "embedding-block")) {
    test(fixture.name, () => {
      const block = applyMutations(corpus.base_embedding_block, fixture.mutations ?? []);
      expect(validateCapabilityEnvelopeBlock(block).ok).toBe(fixture.valid!);
    });
  }

  for (const fixture of corpus.cases.filter((entry) => entry.mode === "embedding-events")) {
    test(fixture.name, () => {
      const events = applyMutations(corpus.base_authority_events, fixture.mutations ?? []);
      expect(validateAuthorityEvents(events).ok).toBe(fixture.valid!);
    });
  }
});

describe("terminal grant rollback drill", () => {
  test("the drill proves revocation restores the pre-grant outcome", () => {
    const result = runRollbackDrill();
    expect(result.ok).toBe(true);
    expect(result.stages.map((stage) => stage.name)).toEqual(["pre-grant", "granted", "terminalized"]);
    expect(result.stages[0]!.decision).toBe("DENY");
    expect(result.stages[1]!.decision).toBe("PERMIT");
    expect(result.stages[2]!.decision).toBe("DENY");
    expect(result.stages[2]!.reasons).toContain("terminal_grant_revoked");
    expect(result.stages[2]!.decision).toBe(result.stages[0]!.decision);
  });

  test("the drill operates exclusively on a disposable root and leaves it inspectable when supplied", () => {
    const root = mkdtempSync(join(tmpdir(), "authority-envelope-drill-test-"));
    try {
      const result = runRollbackDrill(root);
      expect(result.ok).toBe(true);
      expect(result.root).toBe(root);
      const files = readdirSync(root).sort();
      expect(files).toEqual([
        "granted.envelope.json",
        "granted.request.json",
        "pre-grant.envelope.json",
        "pre-grant.request.json",
        "terminalized.envelope.json",
        "terminalized.request.json",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("revocation only marks terminal-lifetime envelopes", () => {
    const runLifetime = clone(buildDrillEnvelope(true));
    runLifetime.approval_binding.lifetime = { kind: "run" };
    const untouched = revokeTerminalGrants(runLifetime, "2026-06-01T13:00:00Z");
    expect(untouched.capabilities.every((grant) => grant.revoked_at === null)).toBe(true);
    const terminal = revokeTerminalGrants(buildDrillEnvelope(true), "2026-06-01T13:00:00Z");
    expect(terminal.capabilities.every((grant) => grant.revoked_at === "2026-06-01T13:00:00Z")).toBe(true);
  });

  test("the drill request itself is well-formed", () => {
    const result = evaluateRequest(buildDrillEnvelope(true), buildDrillRequest());
    expect(result.decision).toBe("PERMIT");
  });
});

describe("read-only validator cli", () => {
  test("--help performs no work and exits 0", () => {
    const result = runCli(["--help"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("usage: bun authority-envelope.ts");
  });

  test("check accepts the base envelope with single-line json on stdout", () => {
    const result = runCli(["check", join(FIXTURE_DIR, corpus.base_envelope)]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(result.stdout) as { ok: boolean; issues: unknown[] }).toEqual({ ok: true, issues: [] });
  });

  test("check proves cap-only composition against the rung fixture", () => {
    const result = runCli([
      "check",
      join(FIXTURE_DIR, corpus.base_envelope),
      "--rung-fixture",
      join(FIXTURE_DIR, corpus.global_rung),
    ]);
    expect(result.exitCode).toBe(0);
    const payload = JSON.parse(result.stdout) as { ok: boolean; effective_rung: string; global_rung: string };
    expect(payload.ok).toBe(true);
    expect(ENVELOPE_RUNGS.indexOf(payload.effective_rung as (typeof ENVELOPE_RUNGS)[number])).toBeLessThanOrEqual(
      ENVELOPE_RUNGS.indexOf(payload.global_rung as (typeof ENVELOPE_RUNGS)[number]),
    );
  });

  test("evaluate exits 0 on PERMIT and 3 on DENY", () => {
    const permit = runCli(["evaluate", join(FIXTURE_DIR, corpus.base_envelope), join(FIXTURE_DIR, corpus.base_request)]);
    expect(permit.exitCode).toBe(0);
    expect((JSON.parse(permit.stdout) as { decision: string }).decision).toBe("PERMIT");
    const denyRoot = mkdtempSync(join(tmpdir(), "authority-envelope-cli-test-"));
    try {
      const denyRequest = clone(baseRequest);
      denyRequest.capability = "factory.unlisted";
      const denyPath = join(denyRoot, "deny-request.json");
      writeFileSync(denyPath, JSON.stringify(denyRequest));
      const deny = runCli(["evaluate", join(FIXTURE_DIR, corpus.base_envelope), denyPath]);
      expect(deny.exitCode).toBe(3);
      expect((JSON.parse(deny.stdout) as { decision: string }).decision).toBe("DENY");
    } finally {
      rmSync(denyRoot, { recursive: true, force: true });
    }
  });

  test("malformed envelope input exits 1", () => {
    const root = mkdtempSync(join(tmpdir(), "authority-envelope-cli-test-"));
    try {
      const malformedPath = join(root, "malformed.json");
      writeFileSync(malformedPath, "{not json");
      const result = runCli(["check", malformedPath]);
      expect(result.exitCode).toBe(1);
      expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("drill subcommand exits 0 with single-line json", () => {
    const result = runCli(["drill"]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect((JSON.parse(result.stdout) as { ok: boolean }).ok).toBe(true);
  });
});

describe("vocabulary integrity", () => {
  test("decision and reason vocabularies are closed and unique", () => {
    expect(new Set(DECISIONS).size).toBe(DECISIONS.length);
    expect(new Set(DENY_REASONS).size).toBe(DENY_REASONS.length);
    expect(new Set(AUTHORITY_EVENT_KINDS).size).toBe(AUTHORITY_EVENT_KINDS.length);
  });
});
