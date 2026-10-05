import { afterEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSyntheticSkillPromotionQualification } from "./skill-promotion-decision-cohort.ts";
import {
  computeSummaryHash,
  finalizeSignature,
  type SkillPromotionSummary,
} from "./skill-promotion-decision-contract.ts";
import { evaluateSkillPromotionDecision } from "./skill-promotion-decision-runner.ts";
import { DECISION_LIFECYCLE_BRIDGE_REQUEST } from "./decision-lifecycle-bridge-contract.ts";
import {
  readDecisionLifecycleShadowLedger,
  runDecisionLifecycleShadowCli,
  runDecisionLifecycleShadowRunner,
  type DecisionLifecycleShadowRunnerResult,
} from "./decision-lifecycle-bridge-runner.ts";

const fixture = join(import.meta.dir, "../scenarios/fixtures/actor-system-cohort.json");
const runner = join(import.meta.dir, "decision-lifecycle-bridge-runner.ts");
const roots: string[] = [];
const originalMode = process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE;

afterEach(() => {
  if (originalMode === undefined) delete process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE;
  else process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE = originalMode;
  while (roots.length > 0) {
    const root = roots.pop()!;
    if (!root.startsWith(tmpdir())) throw new Error(`refusing to remove non-temporary test path: ${root}`);
    rmSync(root, { recursive: true, force: true });
  }
});

function request() {
  const qualification = buildSyntheticSkillPromotionQualification(fixture);
  const hold = evaluateSkillPromotionDecision(
    qualification.protocol,
    qualification.observations,
    qualification.approved_lifecycle,
    qualification.candidate_lifecycle,
    qualification.predecessors,
    null,
  );
  const { summary_sha256: _hash, ...body } = hold;
  const recommendationBody = {
    ...body,
    human_signature_valid: true,
    decision: "PROMOTION_RECOMMENDED" as const,
    reasons: [],
  };
  const summary: SkillPromotionSummary = {
    ...recommendationBody,
    summary_sha256: computeSummaryHash(recommendationBody),
  };
  const signature = finalizeSignature({
    schema: "skill-promotion-signature/v1",
    actor: "operator",
    signed_at: qualification.protocol.evaluation_time,
    evidence_preimage_sha256: hold.evidence_preimage_sha256,
    requested_decision: "PROMOTION_RECOMMENDED",
  });
  return {
    schema: DECISION_LIFECYCLE_BRIDGE_REQUEST,
    trace_id: "dlb-02-test-trace",
    observed_at: qualification.protocol.evaluation_time,
    actor: { id: "decision-runner", authority: "observe-only" as const },
    protocol: qualification.protocol,
    summary,
    signature,
    lifecycle_record: qualification.candidate_lifecycle,
  };
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "zou-1469-shadow-runner-"));
  roots.push(root);
  return root;
}

function spawnRunnerProcess(requestPath: string, ledgerPath: string): Promise<DecisionLifecycleShadowRunnerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", [runner, "--request", requestPath, "--ledger", ledgerPath], {
      env: { ...process.env, ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE: "shadow" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`shadow runner exited ${String(code)}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as DecisionLifecycleShadowRunnerResult);
    });
  });
}

describe("decision lifecycle shadow runner", () => {
  test("off mode returns before reading input or creating ledger state", () => {
    const root = temporaryRoot();
    let reads = 0;
    const result = runDecisionLifecycleShadowRunner("off", () => {
      reads += 1;
      throw new Error("must not read");
    }, join(root, "absent", "ledger.jsonl"));
    expect(result.ledger_action).toBe("off");
    expect(reads).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });

  test("appends one canonical, authority-free observation with durable permissions", () => {
    const root = temporaryRoot();
    const ledger = join(root, "shadow.jsonl");
    const result = runDecisionLifecycleShadowRunner("shadow", request, ledger);
    expect(result.disposition).toBe("WOULD_REQUEST_PROMOTION");
    expect(result.ledger_action).toBe("appended");
    expect(result.observation?.requested_transition).toEqual({ from: "approved", to: "promoted" });
    if (!result.observation) throw new Error("expected a canonical shadow observation");
    expect(readDecisionLifecycleShadowLedger(ledger)).toEqual([result.observation]);
    expect(readFileSync(ledger, "utf8")).toBe(`${JSON.stringify(result.observation)}\n`);
    expect(statSync(ledger).mode & 0o077).toBe(0);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  test("suppresses duplicate decision, subject, and revision tuples deterministically", () => {
    const root = temporaryRoot();
    const ledger = join(root, "shadow.jsonl");
    const first = runDecisionLifecycleShadowRunner("shadow", request, ledger);
    const second = runDecisionLifecycleShadowRunner("shadow", request, ledger);
    expect(first.ledger_action).toBe("appended");
    expect(second.ledger_action).toBe("duplicate");
    expect(second.observation).toEqual(first.observation);
    expect(readDecisionLifecycleShadowLedger(ledger)).toHaveLength(1);
  });

  test("returns HOLD without writing malformed input", () => {
    const root = temporaryRoot();
    const ledger = join(root, "shadow.jsonl");
    const result = runDecisionLifecycleShadowRunner("shadow", () => ({ ...request(), unknown: true }), ledger);
    expect(result.disposition).toBe("HOLD");
    expect(result.ledger_action).toBe("not-recorded");
    expect(result.observation).toBeNull();
    expect(existsSync(ledger)).toBe(false);
  });

  test("fails closed on a malformed or noncanonical existing ledger", () => {
    const root = temporaryRoot();
    const ledger = join(root, "shadow.jsonl");
    writeFileSync(ledger, "{\"broken\":true}\n", { mode: 0o600 });
    expect(() => runDecisionLifecycleShadowRunner("shadow", request, ledger)).toThrow();
    expect(readFileSync(ledger, "utf8")).toBe("{\"broken\":true}\n");
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  test("refuses a ledger symlink without changing its target", () => {
    const root = temporaryRoot();
    const target = join(root, "target.jsonl");
    const ledger = join(root, "shadow.jsonl");
    writeFileSync(target, "", { mode: 0o600 });
    symlinkSync(target, ledger);
    expect(() => runDecisionLifecycleShadowRunner("shadow", request, ledger)).toThrow(
      "decision lifecycle ledger must be a regular file",
    );
    expect(readFileSync(target, "utf8")).toBe("");
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  test("replays byte-equivalent observations across separate processes", () => {
    const root = temporaryRoot();
    const ledger = join(root, "shadow.jsonl");
    const firstRequest = request();
    const secondRequest = {
      ...firstRequest,
      trace_id: "dlb-02-second-process",
      observed_at: new Date(Date.parse(firstRequest.observed_at) + 1_000).toISOString(),
    };
    const firstPath = join(root, "first.json");
    const secondPath = join(root, "second.json");
    writeFileSync(firstPath, JSON.stringify(firstRequest));
    writeFileSync(secondPath, JSON.stringify(secondRequest));
    const env = { ...process.env, ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE: "shadow" };
    const first = spawnSync("bun", [runner, "--request", firstPath, "--ledger", ledger], { encoding: "utf8", env });
    const second = spawnSync("bun", [runner, "--request", secondPath, "--ledger", ledger], { encoding: "utf8", env });
    expect(first.status).toBe(0);
    expect(second.status).toBe(0);
    const firstResult = JSON.parse(first.stdout) as DecisionLifecycleShadowRunnerResult;
    const secondResult = JSON.parse(second.stdout) as DecisionLifecycleShadowRunnerResult;
    expect(firstResult.ledger_action).toBe("appended");
    expect(secondResult.ledger_action).toBe("duplicate");
    expect(JSON.stringify(secondResult.observation)).toBe(JSON.stringify(firstResult.observation));
    expect(readDecisionLifecycleShadowLedger(ledger)).toHaveLength(1);
    expect(readdirSync(root).sort()).toEqual(["first.json", "second.json", "shadow.jsonl"]);
  });

  test("serializes concurrent processes into one append and one duplicate", async () => {
    const root = temporaryRoot();
    const ledger = join(root, "shadow.jsonl");
    const requestPath = join(root, "request.json");
    writeFileSync(requestPath, JSON.stringify(request()));
    const results = await Promise.all([
      spawnRunnerProcess(requestPath, ledger),
      spawnRunnerProcess(requestPath, ledger),
    ]);
    expect(results.map((result) => result.ledger_action).sort()).toEqual(["appended", "duplicate"]);
    expect(results[0]?.observation).toEqual(results[1]?.observation);
    expect(readDecisionLifecycleShadowLedger(ledger)).toHaveLength(1);
    expect(existsSync(`${ledger}.lock`)).toBe(false);
  });

  test("CLI remains read-free while bridge mode is off", () => {
    const root = temporaryRoot();
    delete process.env.ZOUROBOROS_DECISION_LIFECYCLE_BRIDGE_MODE;
    expect(runDecisionLifecycleShadowCli(["--request", join(root, "absent.json")])).toBe(0);
    expect(readdirSync(root)).toEqual([]);
  });
});
