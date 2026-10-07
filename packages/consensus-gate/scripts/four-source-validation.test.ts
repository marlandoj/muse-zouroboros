import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const files: Record<string, Array<Record<string, unknown>>> = {
  "byok-catalog.json": [
    model("byok:11111111-1111-4111-8111-111111111111", "claude", "Claude Code Fable 5", true),
    model("byok:22222222-2222-4222-8222-222222222222", "gpt", "Codex GPT 5.6 Sol", true),
  ],
  "synthetic-catalog.json": [
    model("hf:zai-org/GLM-5.2", "glm"),
    model("hf:MiniMaxAI/MiniMax-M3", "minimax"),
  ],
  "opencode-catalog.json": [
    model("oc:claude-fable-5", "claude"),
    model("oc:gpt-5.6-sol", "gpt"),
    model("oc:glm-5.2", "glm"),
    model("oc:minimax-m3", "minimax"),
  ],
  "openrouter-catalog.json": [
    model("anthropic/claude-fable-5", "claude", undefined, false, 1),
    model("openai/gpt-5.6-sol", "gpt", undefined, false, 1),
    model("z-ai/glm-5.2", "glm", undefined, false, 1),
    model("minimax/minimax-m3", "minimax", undefined, false, 1),
  ],
  "kimi-catalog.json": [
    model("kimi:kimi-k3", "kimi", "Kimi K3"),
    model("kimi:kimi-k2.6", "kimi", "Kimi K2.6"),
  ],
};

function model(id: string, family: string, label?: string, subscription = false, cost = 0) {
  return {
    id,
    label,
    subscription,
    family,
    tier: "flagship",
    context_length: 128_000,
    pricing: { prompt: String(cost), completion: String(cost) },
    promptCost: cost,
    completionCost: cost,
  };
}

describe("five-source lineup validation", () => {
  let home = "";

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "four-source-lineup-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  test("validates with all five catalogs and each catalog independently absent", () => {
    for (const omitted of [null, ...Object.keys(files)]) {
      const state = join(home, omitted ?? "all", ".zouroboros");
      mkdirSync(state, { recursive: true });
      for (const [name, models] of Object.entries(files)) {
        if (name === omitted) continue;
        writeFileSync(join(state, name), JSON.stringify({
          fetched_at: new Date().toISOString(),
          source: `fixture:${name}`,
          models,
          chains: {},
        }));
      }
      const observedAt = new Date().toISOString();
      const routes = Object.entries(files).flatMap(([name, models]) => {
        if (name === omitted) return [];
        const provider = name.replace("-catalog.json", "").replace("byok", "zo-byok");
        return models.map((entry) => {
          const rawId = String(entry.id);
          const id = name === "openrouter-catalog.json" ? `or:${rawId}` : rawId;
          return [id, { ok: true, provider, latencyMs: 1, observedAt }];
        });
      });
      writeFileSync(join(state, "provider-resilience-health.json"), JSON.stringify({
        observedAt,
        routes: Object.fromEntries(routes),
      }));
      const result = Bun.spawnSync([
        "bun",
        "packages/consensus-gate/scripts/lineup-picker.ts",
        "--json",
        "--validate",
      ], {
        cwd: REPO_ROOT,
        env: { ...process.env, HOME: join(home, omitted ?? "all") },
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      const output = JSON.parse(result.stdout.toString());
      expect(output.valid).toBe(true);
      expect(output.lineup.catalogSnapshot).toHaveLength(5);
      if (omitted) {
        expect(output.lineup.catalogSnapshot.find((entry: { provider: string }) =>
          entry.provider === omitted.replace("-catalog.json", "").replace("byok", "zo-byok")
        )?.count).toBe(0);
      }
    }
  });

  test("the automation's cold-start --all command is a valid no-op with no provisional candidates", () => {
    const result = Bun.spawnSync([
      "bun",
      "packages/consensus-gate/scripts/cold-start-probe.ts",
      "probe",
      "--all",
      "--json",
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ total: 0, artifacts: [] });
  });

  test("the producer-owned sync updates the tier-resolver advisory consumer", () => {
    const sourceHome = join(home, "sync-home");
    const state = join(sourceHome, ".zouroboros");
    const output = join(home, "tier-data");
    mkdirSync(state, { recursive: true });
    for (const name of ["synthetic-catalog.json", "openrouter-catalog.json", "kimi-catalog.json"]) {
      writeFileSync(join(state, name), JSON.stringify({
        fetched_at: new Date().toISOString(),
        source: `fixture:${name}`,
        models: files[name],
        chains: {},
      }));
    }
    const result = Bun.spawnSync([
      "bun",
      "packages/consensus-gate/scripts/tier-resolver-sync.ts",
      "sync",
    ], {
      cwd: REPO_ROOT,
      env: { ...process.env, HOME: sourceHome, TIER_RESOLVER_DATA_DIR: output },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(existsSync(join(output, "external-models.json"))).toBe(true);
  });
});
