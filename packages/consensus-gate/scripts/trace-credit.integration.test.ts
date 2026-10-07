import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const PROVIDER_KEYS = new Set([
  "SYNTHETIC_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENCODE_API_KEY",
  "ZO_CLIENT_IDENTITY_TOKEN",
  "ZO_TOKEN",
]);

let tmpHome = "";

function sandboxEnv(traceId: string): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name, value]) => value !== undefined && !PROVIDER_KEYS.has(name) && !name.startsWith("LINEUP_") && name !== "GATE_LINEUP_PROFILE",
    ),
  ) as Record<string, string>;
  for (const key of PROVIDER_KEYS) env[key] = "";
  env.HOME = tmpHome;
  env.ZO_TRACE_ID = traceId;
  env.CONSENSUS_MODELS = "hf:zai-org/GLM-5.2,xai:grok-3-mini,hf:moonshotai/Kimi-K2.7-Code";
  env.CONSENSUS_DETERMINISTIC_FIRST = "0";
  env.CONSENSUS_RECALL_BIAS = "0";
  env.CONSENSUS_ALLOW_MOCK = "1";
  env.CONSENSUS_FORCE_MOCK = "1";
  env.CONSENSUS_ATTESTATION_KEY_PATH = join(tmpHome, "attestation.key");
  return env;
}

afterEach(() => {
  if (tmpHome) rmSync(tmpHome, { recursive: true, force: true });
  tmpHome = "";
});

describe("trace credit subprocess boundary", () => {
  test("the gate and terminal writer join through one ZO_TRACE_ID", () => {
    tmpHome = mkdtempSync(join(tmpdir(), "zou-714-trace-"));
    const traceId = "factory:integration-exec";
    const env = sandboxEnv(traceId);
    writeFileSync(env.CONSENSUS_ATTESTATION_KEY_PATH, Buffer.alloc(32, 0x61));

    const gate = Bun.spawnSync([
      "bun",
      join(REPO_ROOT, "packages/consensus-gate/scripts/consensus-gate.ts"),
      "validate",
      "--code",
      "export const joinedTrace = true;",
      "--criteria",
      "correctness",
      "--label",
      "zou-714-integration",
      "--json",
    ], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
    expect(gate.exitCode, gate.stderr.toString()).toBe(0);
    expect(gate.stdout.toString()).toContain("__CG_JSON__");

    const outcome = Bun.spawnSync([
      "bun",
      join(REPO_ROOT, "packages/zo-swarm-orchestrator/src/standalone/trace-outcome.ts"),
      "capture",
      "--trace-id",
      traceId,
      "--outcome",
      "success",
      "--source",
      "factory-integration",
    ], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
    expect(outcome.exitCode, outcome.stderr.toString()).toBe(0);

    const rebuild = Bun.spawnSync([
      "bun",
      join(REPO_ROOT, "packages/consensus-gate/scripts/reputation.ts"),
      "--rebuild",
    ], { cwd: REPO_ROOT, env, stdout: "pipe", stderr: "pipe" });
    expect(rebuild.exitCode, rebuild.stderr.toString()).toBe(0);
    expect(rebuild.stdout.toString()).toContain("matched unique trace IDs:");

    const reputation = JSON.parse(readFileSync(join(tmpHome, ".zouroboros", "reputation.json"), "utf-8"));
    expect(reputation.join_health.matched_unique_trace_ids).toBe(1);
    expect(reputation.join_health.unmatched_gate_ids).toEqual([]);
    expect(reputation.join_health.unmatched_outcome_ids).toEqual([]);
    expect(reputation.join_health.source_counts).toEqual({ "factory-integration": 1 });
    expect(Object.values(reputation.voters).some((stats: any) => stats.outcome_votes > 0)).toBe(true);
  });
});
