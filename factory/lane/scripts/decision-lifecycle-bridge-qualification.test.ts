import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticSkillPromotionQualification } from "./skill-promotion-decision-cohort.ts";
import {
  computeSummaryHash,
  finalizeSignature,
  type SkillPromotionSummary,
} from "./skill-promotion-decision-contract.ts";
import { evaluateSkillPromotionDecision } from "./skill-promotion-decision-runner.ts";
import {
  DECISION_LIFECYCLE_BRIDGE_REQUEST,
  DECISION_LIFECYCLE_MAX_AGE_MS,
} from "./decision-lifecycle-bridge-contract.ts";
import {
  readDecisionLifecycleShadowLedger,
  runDecisionLifecycleShadowRunner,
  type DecisionLifecycleShadowRunnerResult,
} from "./decision-lifecycle-bridge-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const runner = join(import.meta.dir, "decision-lifecycle-bridge-runner.ts");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    if (!root.startsWith(tmpdir())) throw new Error(`refusing to remove non-temporary test path: ${root}`);
    rmSync(root, { recursive: true, force: true });
  }
});

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function treeHash(root: string): string {
  const entries: Array<{ path: string; mode: number; sha256: string }> = [];
  function visit(path: string, relative: string): void {
    for (const name of readdirSync(path).sort()) {
      const absolute = join(path, name);
      const nextRelative = relative ? `${relative}/${name}` : name;
      const stat = statSync(absolute);
      if (stat.isDirectory()) visit(absolute, nextRelative);
      else entries.push({ path: nextRelative, mode: stat.mode & 0o777, sha256: sha256(readFileSync(absolute)) });
    }
  }
  visit(root, "");
  return sha256(JSON.stringify(entries));
}

function requestSet() {
  const qualification = buildSyntheticSkillPromotionQualification(fixture);
  const holdSummary = evaluateSkillPromotionDecision(
    qualification.protocol,
    qualification.observations,
    qualification.approved_lifecycle,
    qualification.candidate_lifecycle,
    qualification.predecessors,
    null,
  );
  const { summary_sha256: _hash, ...body } = holdSummary;
  const recommendationBody = {
    ...body,
    human_signature_valid: true,
    decision: "PROMOTION_RECOMMENDED" as const,
    reasons: [],
  };
  const recommendation: SkillPromotionSummary = {
    ...recommendationBody,
    summary_sha256: computeSummaryHash(recommendationBody),
  };
  const signature = finalizeSignature({
    schema: "skill-promotion-signature/v1",
    actor: "operator",
    signed_at: qualification.protocol.evaluation_time,
    evidence_preimage_sha256: holdSummary.evidence_preimage_sha256,
    requested_decision: "PROMOTION_RECOMMENDED",
  });
  const base = {
    schema: DECISION_LIFECYCLE_BRIDGE_REQUEST,
    trace_id: "dlb-04-qualification",
    observed_at: qualification.protocol.evaluation_time,
    actor: { id: "decision-runner", authority: "observe-only" as const },
    protocol: qualification.protocol,
    summary: recommendation,
    signature,
    lifecycle_record: qualification.candidate_lifecycle,
  };
  return { base, holdSummary };
}

function qualificationRoot() {
  const root = mkdtempSync(join(tmpdir(), "zou-1471-bridge-qualification-"));
  roots.push(root);
  const skillContent = join(root, "forbidden", "skill-content");
  const lifecycleDatabase = join(root, "forbidden", "lifecycle-db.json");
  const shadowRoot = join(root, "allowed-shadow");
  mkdirSync(skillContent, { recursive: true });
  mkdirSync(shadowRoot, { recursive: true });
  writeFileSync(join(skillContent, "SKILL.md"), "---\nname: qualified-skill\ndescription: immutable fixture\n---\n");
  writeFileSync(join(skillContent, "runtime.ts"), "export const immutable = true;\n");
  writeFileSync(lifecycleDatabase, `${JSON.stringify({ revision: 7, state: "approved", receipts: ["immutable"] })}\n`);
  return {
    root,
    skillContent,
    lifecycleDatabase,
    shadowRoot,
    guardedHashes: () => ({
      skill_content_sha256: treeHash(skillContent),
      lifecycle_database_sha256: sha256(readFileSync(lifecycleDatabase)),
    }),
  };
}

describe("decision lifecycle bridge qualification cohort", () => {
  test("qualifies positive, HOLD, stale, malformed, mismatched, tampered, and lifecycle-blocked cases without forbidden mutation", () => {
    const { base, holdSummary } = requestSet();
    const lifecycleBlocked = structuredClone(base);
    lifecycleBlocked.lifecycle_record.security.deterministic[0]!.validUntil = new Date(
      Date.parse(lifecycleBlocked.lifecycle_record.security.deterministic[0]!.issuedAt) + 1,
    ).toISOString();
    const cases = [
      { name: "positive", input: base, disposition: "WOULD_REQUEST_PROMOTION", ledgerAction: "appended" },
      {
        name: "hold",
        input: { ...base, summary: holdSummary, signature: null },
        disposition: "HOLD",
        ledgerAction: "appended",
      },
      {
        name: "stale",
        input: {
          ...base,
          observed_at: new Date(Date.parse(base.observed_at) + DECISION_LIFECYCLE_MAX_AGE_MS + 1).toISOString(),
        },
        disposition: "HOLD",
        ledgerAction: "not-recorded",
      },
      { name: "malformed", input: { ...base, unknown: true }, disposition: "HOLD", ledgerAction: "not-recorded" },
      {
        name: "mismatched",
        input: {
          ...base,
          lifecycle_record: { ...base.lifecycle_record, subjectHash: `sha256:${"f".repeat(64)}` },
        },
        disposition: "HOLD",
        ledgerAction: "not-recorded",
      },
      {
        name: "tampered",
        input: { ...base, summary: { ...base.summary, summary_sha256: "0".repeat(64) } },
        disposition: "HOLD",
        ledgerAction: "not-recorded",
      },
      { name: "lifecycle-blocked", input: lifecycleBlocked, disposition: "HOLD", ledgerAction: "appended" },
    ] as const;

    for (const candidate of cases) {
      const environment = qualificationRoot();
      const before = environment.guardedHashes();
      const ledger = join(environment.shadowRoot, `${candidate.name}.jsonl`);
      const result = runDecisionLifecycleShadowRunner("shadow", () => structuredClone(candidate.input), ledger);
      expect(result.disposition).toBe(candidate.disposition);
      expect(result.ledger_action).toBe(candidate.ledgerAction);
      expect(environment.guardedHashes()).toEqual(before);
      if (candidate.name === "lifecycle-blocked") {
        expect(result.observation?.lifecycle_dry_verdict).toBe("DENY");
        expect(result.observation?.requested_transition).toBeNull();
      }
    }
  });

  test("suppresses duplicates across processes while preserving filesystem and lifecycle database hashes", () => {
    const environment = qualificationRoot();
    const before = environment.guardedHashes();
    const requestPath = join(environment.shadowRoot, "request.json");
    const ledger = join(environment.shadowRoot, "observations.jsonl");
    writeFileSync(requestPath, JSON.stringify(requestSet().base));
    const env = { ...process.env, ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE: "shadow" };
    const first = spawnSync("bun", [runner, "--request", requestPath, "--ledger", ledger], { encoding: "utf8", env });
    const second = spawnSync("bun", [runner, "--request", requestPath, "--ledger", ledger], { encoding: "utf8", env });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstResult = JSON.parse(first.stdout) as DecisionLifecycleShadowRunnerResult;
    const secondResult = JSON.parse(second.stdout) as DecisionLifecycleShadowRunnerResult;
    expect(firstResult.ledger_action).toBe("appended");
    expect(secondResult.ledger_action).toBe("duplicate");
    expect(secondResult.observation).toEqual(firstResult.observation);
    expect(readDecisionLifecycleShadowLedger(ledger)).toHaveLength(1);
    expect(environment.guardedHashes()).toEqual(before);
  });
});
