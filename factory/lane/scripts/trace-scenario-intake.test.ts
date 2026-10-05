import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorSha256 } from "./actor-system-twin";
import {
  createHoldoutFingerprint,
  finalizeHoldoutManifest,
  readHoldoutState,
  writeHoldoutState,
  type HoldoutState,
} from "./heldout-cohort";
import { canonicalize, finalizeReceipt, type RunReceipt } from "./run-receipt-contract";
import { runScenario } from "./scenario-run";
import { parseScenarioSpec, type ScenarioSpec } from "./scenario-spec";
import {
  expireTraceCandidates,
  intakeTraceCandidate,
  readTraceIntakeState,
  reviewTraceCandidate,
  validateReviewLedger,
  validateSufficientReceipt,
  type TraceScenarioDraft,
} from "./trace-scenario-intake";

const NOW = "2026-08-19T20:00:00.000Z";
const LATER = "2026-08-20T20:00:00.000Z";
const HOLDOUT_CREATED = "2026-08-01T00:00:00.000Z";
const DISJOINT_HOLDOUT = "independent evaluator puzzle concerning a calendar repair with no relationship to factory receipt scenarios whatsoever";

let root = "";
let holdoutPath = "";

function receipt(): RunReceipt {
  const path = join(import.meta.dir, "..", "fixtures", "run-receipt", "valid-success.json");
  return finalizeReceipt(JSON.parse(readFileSync(path, "utf8")) as RunReceipt);
}

function draft(overrides: Partial<TraceScenarioDraft> = {}): TraceScenarioDraft {
  return {
    observedFailure: "A synthetic factory action terminated before the user-visible acknowledgement.",
    hypothesizedCause: "The synthetic delivery step did not commit its acknowledgement edge.",
    expectedBehavior: "The scenario must preserve the terminal outcome and visible acknowledgement.",
    scenarioVersion: "v1",
    scenario: {
      scenario_id: "trace-delivery-edge",
      description: "Synthetic receipt lineage check",
      seed: 1056,
      steps: [{ name: "verify", run: "printf synthetic-ok", expect: { exit_code: 0, stdout_contains: ["synthetic-ok"] } }],
    },
    ...overrides,
  };
}

function holdouts(plaintext = DISJOINT_HOLDOUT, exposureCount = 0): HoldoutState {
  const item = createHoldoutFingerprint({
    itemId: "heldout-synthetic-001",
    version: "v1",
    plaintext,
    createdAt: HOLDOUT_CREATED,
    expiresAt: "2026-12-01T00:00:00.000Z",
  });
  item.exposureCount = exposureCount;
  return { manifest: finalizeHoldoutManifest([item]), accessLedger: [] };
}

function intake(overrides: Partial<Parameters<typeof intakeTraceCandidate>[0]> = {}) {
  return intakeTraceCandidate({
    receipt: receipt(),
    draft: draft(),
    holdoutStatePath: holdoutPath,
    stateRoot: root,
    actor: "synthetic-evaluator",
    now: NOW,
    ...overrides,
  });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "trace-intake-"));
  holdoutPath = join(root, "holdouts.json");
  writeHoldoutState(holdoutPath, holdouts());
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("canonical receipt and redaction boundary", () => {
  test("requires verified receipt hash, authority, terminal evidence, and both edge proofs", () => {
    expect(validateSufficientReceipt(receipt())).toEqual([]);
    const missingAuthority = receipt();
    missingAuthority.authority.envelope_kind = "none";
    missingAuthority.receipt_hash = finalizeReceipt(missingAuthority).receipt_hash;
    expect(validateSufficientReceipt(missingAuthority)).toContain("authority is unavailable");

    const missingEdge = receipt();
    missingEdge.verification.edge_proof.anchor_ok = false;
    missingEdge.receipt_hash = finalizeReceipt(missingEdge).receipt_hash;
    const held = intake({ receipt: missingEdge });
    expect(held.disposition).toBe("hold");
    expect(held.reasons.some((reason) => reason.includes("edge"))).toBe(true);
  });

  test("rejects secret-shaped fields and credential-shaped values before persistence", () => {
    const secretKeyDraft = draft() as TraceScenarioDraft & { api_key?: string };
    secretKeyDraft.api_key = "synthetic-placeholder";
    expect(() => intake({ draft: secretKeyDraft })).toThrow("secret-shaped key");
    expect(readTraceIntakeState(root).candidates).toHaveLength(0);

    const credential = ["Bear", "er ", "synthetic", "credential", "value"].join("");
    expect(() => intake({ draft: draft({ observedFailure: credential }) })).toThrow("credential-shaped value");
    expect(readTraceIntakeState(root).candidates).toHaveLength(0);
  });

  test("persists only a redacted structural contract and immutable receipt hashes", () => {
    const runtimeDraft = draft() as TraceScenarioDraft & { runtimeOnly?: string };
    runtimeDraft.runtimeOnly = "discard-me";
    (runtimeDraft.scenario as ScenarioSpec & { runtimeOnly?: string }).runtimeOnly = "discard-me-too";
    const result = intake({ draft: runtimeDraft });
    expect(result.disposition).toBe("quarantined");
    expect(result.candidate?.state).toBe("quarantined");
    const bytes = readFileSync(join(root, "trace-intake-state.json"), "utf8");
    expect(bytes).not.toContain('"contract_id"');
    expect(bytes).not.toContain('"events"');
    expect(bytes).not.toContain("runtimeOnly");
    expect(bytes).not.toContain("discard-me");
    expect(bytes).not.toContain(DISJOINT_HOLDOUT);
    expect(bytes).toContain(result.candidate!.sourceReceiptHash);
    expect(readHoldoutState(holdoutPath).accessLedger.at(-1)?.purpose).toBe("contamination_check");
  });

  test("preserves only the declared actor-system twin authority fields", () => {
    const actorDraft = draft({
      scenario: {
        scenario_id: "trace-actor-system",
        seed: 1057001,
        twin: {
          kind: "actor-system",
          fixture: "/synthetic/actor-manifest.json",
          contract_id: "tool-success",
          authority_kind: "approved_manifest",
          manifest_sha256: "1".repeat(64),
          contract_sha256: "2".repeat(64),
          review_sha256: "3".repeat(64),
        },
        steps: [{ name: "verify", run: "true", expect: { exit_code: 0 } }],
      },
    });
    (actorDraft.scenario.twin as any).runtimeOnly = "discard-me";
    const result = intake({ draft: actorDraft });
    expect(result.candidate?.contract.scenario.twin).toEqual({
      kind: "actor-system",
      fixture: "/synthetic/actor-manifest.json",
      contract_id: "tool-success",
      authority_kind: "approved_manifest",
      manifest_sha256: "1".repeat(64),
      contract_sha256: "2".repeat(64),
      review_sha256: "3".repeat(64),
    });
    expect(readFileSync(join(root, "trace-intake-state.json"), "utf8")).not.toContain("runtimeOnly");
  });
});

describe("quarantine, evidence, and deterministic replay", () => {
  test("quarantines exact and threshold overlap while holding unavailable evidence", () => {
    const contractText = canonicalize(draft());
    writeHoldoutState(holdoutPath, holdouts(contractText));
    const exact = intake();
    expect(exact.disposition).toBe("quarantined");
    expect(exact.candidate?.quarantineReasons).toContain("exact_hash_overlap");

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "trace-intake-"));
    holdoutPath = join(root, "holdouts.json");
    writeHoldoutState(holdoutPath, holdouts(contractText));
    const threshold = intake({ draft: draft({ expectedBehavior: "The scenario must preserve the terminal outcome and visible acknowledgement without duplication." }) });
    expect(threshold.candidate?.quarantineReasons).toContain("normalized_8gram_overlap");
    expect(threshold.contamination!.maximumOverlap).toBeGreaterThanOrEqual(0.6);

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "trace-intake-"));
    holdoutPath = join(root, "holdouts.json");
    writeHoldoutState(holdoutPath, holdouts(DISJOINT_HOLDOUT, 2));
    expect(intake().disposition).toBe("hold");

    rmSync(holdoutPath, { force: true });
    expect(intake().disposition).toBe("hold");
  });

  test("deduplicates exact identity and source receipt contract combinations", () => {
    const first = intake();
    const second = intake();
    expect(first.candidate?.candidateHash).toBe(second.candidate?.candidateHash);
    expect(second.disposition).toBe("duplicate");
    expect(readTraceIntakeState(root).candidates).toHaveLength(1);
  });
});

describe("human review, expiry, and rollback", () => {
  test("requires a human review bound to the exact candidate hash", async () => {
    const candidate = intake().candidate!;
    expect(() => reviewTraceCandidate({
      stateRoot: root,
      candidateId: candidate.candidateId,
      candidateHash: "0".repeat(64),
      actor: "human-operator",
      reviewerKind: "human",
      decision: "admit",
      reason: "synthetic evidence complete",
      now: LATER,
      scenarioOutputPath: join(root, "admitted.yaml"),
    })).toThrow("candidate hash mismatch");

    const admitted = reviewTraceCandidate({
      stateRoot: root,
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      actor: "human-operator",
      reviewerKind: "human",
      decision: "admit",
      reason: "synthetic evidence complete",
      now: LATER,
      scenarioOutputPath: join(root, "admitted.yaml"),
    });
    expect(admitted.candidate.state).toBe("admitted");
    expect(validateReviewLedger(readTraceIntakeState(root).reviews)).toEqual([]);
    expect(admitted.review.holdoutManifestHash).toBe(candidate.holdoutManifestHash);
    expect(admitted.review.maximumHoldoutOverlap).toBe(candidate.maximumHoldoutOverlap);
    expect(admitted.review.quarantineReasons).toEqual(candidate.quarantineReasons);
    const output = JSON.parse(readFileSync(admitted.scenarioOutputPath!, "utf8"));
    expect(output.lineage.source_receipt_hash).toBe(candidate.sourceReceiptHash);
    expect(output.lineage.candidate_hash).toBe(candidate.candidateHash);
    expect(output.lineage.review_hash).toBe(admitted.review.recordHash);
    const parsed = parseScenarioSpec(admitted.scenarioOutputPath!);
    expect(parsed.lineage).toEqual(output.lineage);
    const savedFactory = {
      dir: process.env.FACTORY_STATE_DIR,
      mode: process.env.FACTORY_STATE_MODE,
      outside: process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT,
      runs: process.env.SF009_RUNS_PATH,
    };
    process.env.FACTORY_STATE_DIR = root;
    process.env.FACTORY_STATE_MODE = "test";
    process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
    process.env.SF009_RUNS_PATH = join(root, "lineage-runs.jsonl");
    try {
      const run = await runScenario(admitted.scenarioOutputPath!);
      expect(run.verdict).toBe("passed");
      expect(run.lineage).toEqual(output.lineage);
      const runBytes = readFileSync(process.env.SF009_RUNS_PATH, "utf8");
      expect(runBytes).not.toContain('"events"');
      expect(runBytes).not.toContain(DISJOINT_HOLDOUT);
    } finally {
      for (const [name, value] of [
        ["FACTORY_STATE_DIR", savedFactory.dir],
        ["FACTORY_STATE_MODE", savedFactory.mode],
        ["FACTORY_STATE_ALLOW_OUTSIDE_ROOT", savedFactory.outside],
        ["SF009_RUNS_PATH", savedFactory.runs],
      ] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
    expect(() => reviewTraceCandidate({
      stateRoot: root,
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      actor: "human-operator",
      reviewerKind: "human",
      decision: "reject",
      reason: "cannot reverse",
      now: LATER,
    })).toThrow("immutable in state admitted");
  });

  test("admission binds an actor twin to the final ZOU-1056 review hash", () => {
    const contract = {
      id: "tool-success",
      actorKind: "tool",
      interaction: "invoke",
      initialState: "ready",
      fault: "none",
      recovery: "commit_once",
      approval: "not_applicable",
      expectedTerminal: "completed",
    } as const;
    const manifest = JSON.stringify({
      schemaVersion: 1,
      manifestId: "admitted-lineage-test",
      classification: "synthetic_only",
      reviewBinding: "human review",
      replicateSeeds: [1057001],
      contracts: [contract],
    });
    const fixture = join(root, "actor-lineage-manifest.json");
    writeFileSync(fixture, manifest);
    const candidate = intake({
      draft: draft({
        scenarioVersion: "actor-v1",
        scenario: {
          scenario_id: "trace-actor-lineage",
          seed: 1057001,
          twin: {
            kind: "actor-system",
            fixture,
            contract_id: contract.id,
            authority_kind: "admitted_lineage",
            manifest_sha256: actorSha256(manifest),
            contract_sha256: actorSha256(contract),
            review_sha256: "0".repeat(64),
          },
          steps: [{ name: "verify", run: "true", expect: { exit_code: 0 } }],
        },
      }),
    }).candidate!;
    const admitted = reviewTraceCandidate({
      stateRoot: root,
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      actor: "human-operator",
      reviewerKind: "human",
      decision: "admit",
      reason: "actor contract reviewed",
      now: LATER,
      scenarioOutputPath: join(root, "actor-admitted.json"),
    });
    const parsed = parseScenarioSpec(admitted.scenarioOutputPath!);
    expect(parsed.twin?.kind).toBe("actor-system");
    if (parsed.twin?.kind === "actor-system") expect(parsed.twin.review_sha256).toBe(admitted.review.recordHash);
    expect(parsed.lineage?.review_hash).toBe(admitted.review.recordHash);
  });

  test("makes rejection and expiry irreversible", () => {
    const rejectedCandidate = intake().candidate!;
    const rejected = reviewTraceCandidate({
      stateRoot: root,
      candidateId: rejectedCandidate.candidateId,
      candidateHash: rejectedCandidate.candidateHash,
      actor: "human-operator",
      reviewerKind: "human",
      decision: "reject",
      reason: "insufficient synthetic value",
      now: LATER,
    });
    expect(rejected.candidate.state).toBe("rejected");
    expect(() => reviewTraceCandidate({
      stateRoot: root,
      candidateId: rejectedCandidate.candidateId,
      candidateHash: rejectedCandidate.candidateHash,
      actor: "human-operator",
      reviewerKind: "human",
      decision: "admit",
      reason: "cannot reverse",
      now: LATER,
      scenarioOutputPath: join(root, "late.yaml"),
    })).toThrow("immutable in state rejected");

    const nextRoot = mkdtempSync(join(tmpdir(), "trace-intake-expiry-"));
    const nextHoldout = join(nextRoot, "holdouts.json");
    try {
      writeHoldoutState(nextHoldout, holdouts());
      const short = intakeTraceCandidate({
        receipt: receipt(), draft: draft({ scenarioVersion: "v2" }), holdoutStatePath: nextHoldout,
        stateRoot: nextRoot, actor: "synthetic-evaluator", now: NOW, expiresAt: "2026-08-19T21:00:00.000Z",
      }).candidate!;
      expect(expireTraceCandidates(nextRoot, LATER).candidates[0].state).toBe("expired");
      expect(() => reviewTraceCandidate({
        stateRoot: nextRoot, candidateId: short.candidateId, candidateHash: short.candidateHash,
        actor: "human-operator", reviewerKind: "human", decision: "admit", reason: "too late", now: LATER,
        scenarioOutputPath: join(nextRoot, "late.yaml"),
      })).toThrow("immutable in state expired");
    } finally {
      rmSync(nextRoot, { recursive: true, force: true });
    }
  });

  test("compensates a post-write failure and preserves the exact baseline", () => {
    const candidate = intake().candidate!;
    const output = join(root, "admitted.yaml");
    const baseline = "scenario_id: baseline\nseed: 1\nsteps: []\n";
    writeFileSync(output, baseline);
    const beforeState = readFileSync(join(root, "trace-intake-state.json"), "utf8");
    expect(() => reviewTraceCandidate({
      stateRoot: root,
      candidateId: candidate.candidateId,
      candidateHash: candidate.candidateHash,
      actor: "human-operator",
      reviewerKind: "human",
      decision: "admit",
      reason: "rollback drill",
      now: LATER,
      scenarioOutputPath: output,
      injectFailureAfterScenarioWrite: true,
    })).toThrow("injected post-write failure");
    expect(readFileSync(output, "utf8")).toBe(baseline);
    expect(readFileSync(join(root, "trace-intake-state.json"), "utf8")).toBe(beforeState);
    expect(readTraceIntakeState(root).candidates[0].state).toBe("quarantined");
  });
});

describe("default-off CLI", () => {
  test("exits before any input read or state write", () => {
    const missingRoot = join(root, "must-not-exist");
    const result = spawnSync("bun", [join(import.meta.dir, "trace-scenario-intake.ts"), "intake", "--receipt", join(root, "missing.json"), "--root", missingRoot], {
      env: { ...process.env, SF009_TRACE_INTAKE: "off" },
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(() => readFileSync(missingRoot)).toThrow();
  });

  test("shadow mode cannot admit a scenario", () => {
    const candidate = intake().candidate!;
    const output = join(root, "shadow-must-not-admit.yaml");
    const result = spawnSync("bun", [
      join(import.meta.dir, "trace-scenario-intake.ts"),
      "review",
      "--root", root,
      "--candidate-id", candidate.candidateId,
      "--candidate-hash", candidate.candidateHash,
      "--actor", "human-operator",
      "--reviewer-kind", "human",
      "--decision", "admit",
      "--reason", "shadow must remain advisory",
      "--now", LATER,
      "--output", output,
    ], {
      env: { ...process.env, SF009_TRACE_INTAKE: "shadow" },
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("requires SF009_TRACE_INTAKE=enforce");
    expect(() => readFileSync(output)).toThrow();
    expect(readTraceIntakeState(root).candidates[0].state).toBe("quarantined");
  });
});

describe("fresh-process lineage persistence", () => {
  test("survives CLI intake and enforce review with exact hashes", () => {
    const receiptPath = join(root, "synthetic-receipt.json");
    const draftPath = join(root, "synthetic-draft.json");
    const output = join(root, "fresh-process-scenario.json");
    writeFileSync(receiptPath, JSON.stringify(receipt()));
    writeFileSync(draftPath, JSON.stringify(draft()));

    const intakeResult = spawnSync("bun", [
      join(import.meta.dir, "trace-scenario-intake.ts"),
      "intake",
      "--receipt", receiptPath,
      "--draft", draftPath,
      "--holdouts", holdoutPath,
      "--root", root,
      "--actor", "synthetic-evaluator",
      "--now", NOW,
    ], {
      env: { ...process.env, SF009_TRACE_INTAKE: "enforce" },
      encoding: "utf8",
    });
    expect(intakeResult.status).toBe(0);
    const candidate = JSON.parse(intakeResult.stdout).candidate as ReturnType<typeof intake>["candidate"];
    expect(candidate?.state).toBe("quarantined");

    const reviewResult = spawnSync("bun", [
      join(import.meta.dir, "trace-scenario-intake.ts"),
      "review",
      "--root", root,
      "--candidate-id", candidate!.candidateId,
      "--candidate-hash", candidate!.candidateHash,
      "--actor", "human-operator",
      "--reviewer-kind", "human",
      "--decision", "admit",
      "--reason", "fresh-process evidence verified",
      "--now", LATER,
      "--output", output,
    ], {
      env: { ...process.env, SF009_TRACE_INTAKE: "enforce" },
      encoding: "utf8",
    });
    expect(reviewResult.status).toBe(0);
    const reviewed = JSON.parse(reviewResult.stdout) as ReturnType<typeof reviewTraceCandidate>;
    const scenario = JSON.parse(readFileSync(output, "utf8"));
    const state = readTraceIntakeState(root);
    expect(state.candidates[0].state).toBe("admitted");
    expect(state.reviews[0].recordHash).toBe(reviewed.review.recordHash);
    expect(scenario.lineage.candidate_hash).toBe(candidate!.candidateHash);
    expect(scenario.lineage.review_hash).toBe(reviewed.review.recordHash);
    expect(scenario.lineage.source_receipt_hash).toBe(candidate!.sourceReceiptHash);
  });
});
