/**
 * F4 — an executor whose registry entry carries no resolvable bridge must
 * degrade, never kill the swarm (root cause of `No bridge found for executor:
 * opencode`, exit 4, on two tenants).
 *
 *   - registry audit: every executor in the canonical registry and its
 *     generated copy names a bridge that exists in this repo (opencode did not);
 *   - auditRegistryBridges(): no bridge / bridge not on disk → excluded with a
 *     plain-language reason and fix; a persona-registry bridge still resolves;
 *   - end to end against the real orchestrate-v5 (fixture registry + bridge,
 *     fake SWARM_WORKSPACE, isolated SWARM_DIR): a bridgeless entry next to
 *     a working one — the campaign runs its other tasks, the exclusion is in
 *     the console and the results file, and pre-flight no longer stops the swarm.
 *
 * F4_ORCH_SCRIPT overrides the orchestrator path (to show these fail on main).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { EXECUTOR_REGISTRY_RELATIVE } from "../registry/loader";
import { auditRegistryBridges, describeExclusion, notRegisteredExclusion } from "../executor/bridge-resolution";

const REPO_ROOT = resolve(import.meta.dir, "../../../..");
const SCRIPT = process.env.F4_ORCH_SCRIPT || join(REPO_ROOT, "packages/zo-swarm-orchestrator/scripts/orchestrate-v5.ts");
const BRIDGE = "packages/zo-swarm-orchestrator/src/executor/bridges/f4-fixture-bridge.sh";
const roots: string[] = [];
const campaigns: string[] = [];

afterEach(() => {
  for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true });
  for (const id of campaigns.splice(0)) {
    for (const s of [".lock", "-progress.json", "-complete.json"]) rmSync(`/dev/shm/${id}${s}`, { force: true });
  }
});

function write(path: string, content: string, mode?: number) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  if (mode) chmodSync(path, mode);
}

describe("F4: registry audit — every executor's bridge resolves", () => {
  for (const rel of [
    "packages/zo-swarm-orchestrator/src/executor/registry/executor-registry.json",
    "packages/zo-swarm-executors/registry/executor-registry.json",
  ]) {
    test(`${rel}: every local executor names an existing bridge (opencode included)`, () => {
      const reg = JSON.parse(readFileSync(join(REPO_ROOT, rel), "utf8"));
      const bad = (reg.executors as any[])
        .filter(e => e.executor === "local")
        .filter(e => typeof e.bridge !== "string" || !existsSync(join(REPO_ROOT, e.bridge)))
        .map(e => `${e.id}: ${e.bridge ?? "(no bridge)"}`);
      expect(bad).toEqual([]);
      const opencode = (reg.executors as any[]).find(e => e.id === "opencode");
      expect(opencode.bridge).toBe("packages/zo-swarm-orchestrator/src/executor/bridges/opencode-bridge.sh");
    });
  }

  test("auditRegistryBridges over the real repo: nothing excluded", () => {
    const audit = auditRegistryBridges({
      orchestratorHome: REPO_ROOT,
      registryPath: join(REPO_ROOT, EXECUTOR_REGISTRY_RELATIVE),
      personaRegistryPath: join(REPO_ROOT, "packages/zo-swarm-orchestrator/assets/persona-registry.json"),
    });
    expect(audit.excluded).toEqual([]);
    expect(audit.resolvable.has("opencode")).toBe(true);
  });
});

describe("F4: auditRegistryBridges", () => {
  function home() {
    const root = mkdtempSync(join(tmpdir(), "f4-audit-"));
    roots.push(root);
    write(join(root, BRIDGE), "#!/usr/bin/env bash\necho ok\n", 0o755);
    write(join(root, "packages/zo-swarm-orchestrator/src/executor/bridges/ghost-bridge.sh"), "#!/usr/bin/env bash\n", 0o755);
    return root;
  }

  test("no bridge / bridge not on disk → excluded with reason + fix; resolvable ones listed", () => {
    const root = home();
    const reg = join(root, EXECUTOR_REGISTRY_RELATIVE);
    write(reg, JSON.stringify({ executors: [
      { id: "ok", executor: "local", bridge: BRIDGE },
      { id: "ghost", executor: "local", acp: { adapterBin: "ghost" } },
      { id: "gone", executor: "local", bridge: "packages/nowhere/gone-bridge.sh" },
    ] }));
    const audit = auditRegistryBridges({ orchestratorHome: root, registryPath: reg });
    expect([...audit.resolvable.keys()]).toEqual(["ok"]);
    const byId = Object.fromEntries(audit.excluded.map(x => [x.executor, x]));
    expect(byId.ghost.cause).toBe("no_bridge");
    expect(byId.ghost.reason).toContain("names no bridge script");
    // The conventional script exists on this host → the fix names it.
    expect(byId.ghost.action).toContain('"bridge": "packages/zo-swarm-orchestrator/src/executor/bridges/ghost-bridge.sh"');
    expect(byId.gone.cause).toBe("bridge_missing");
    expect(byId.gone.reason).toContain("packages/nowhere/gone-bridge.sh is not on this server");
    expect(describeExclusion({ ...byId.ghost, tasks: ["t1"] })).toMatch(/^ghost is left out of this swarm \(asked for by t1\): .+\. To fix: .+\.$/);
  });

  test("a persona-registry bridge resolves an executor whose registry entry has none", () => {
    const root = home();
    const reg = join(root, EXECUTOR_REGISTRY_RELATIVE);
    const personas = join(root, "packages/zo-swarm-orchestrator/assets/persona-registry.json");
    write(reg, JSON.stringify({ executors: [{ id: "ghost", executor: "local" }] }));
    write(personas, JSON.stringify({ personas: [{ id: "ghost", executor: "local", bridge: BRIDGE }] }));
    const audit = auditRegistryBridges({ orchestratorHome: root, registryPath: reg, personaRegistryPath: personas });
    expect(audit.excluded).toEqual([]);
    expect(audit.resolvable.get("ghost")).toBe(join(root, BRIDGE));
  });

  test("a pin to an unregistered id names what this server can run", () => {
    const x = notRegisteredExclusion("nope", "/h/reg.json", "/h", ["fx-a", "fx-b"]);
    expect(x.cause).toBe("not_registered");
    expect(x.action).toContain("fx-a, fx-b");
  });
});

// --------------------------------------------------------------------------
// End to end: the real orchestrator
// --------------------------------------------------------------------------

const MODEL_ROUTER = {
  defaultModel: "fx-mid", fallbackModel: "fx-light-fallback", acceptedPrefixes: ["fx-"],
  tierMap: { trivial: "fx-trivial", simple: "fx-simple", moderate: "fx-mid", complex: "fx-heavy" },
};
const entry = (id: string, bridge: string | undefined) => ({
  id, name: id, executor: "local", ...(bridge ? { bridge } : {}), expertise: ["notes"], best_for: ["notes"],
  healthCheck: { command: "true", description: "installed" }, modelRouter: MODEL_ROUTER,
  // the opencode shape: an ACP entry whose bridge fallback has no bridge
  ...(bridge ? {} : { transport: "acp", acp: { adapterBin: "true" }, transportFallback: { envVar: "X", equals: "0", transport: "bridge" } }),
});

function fixture(executors: Array<[string, string | undefined]>) {
  const root = mkdtempSync(join(tmpdir(), "f4-orch-"));
  roots.push(root);
  const f = { root, home: join(root, "home"), state: join(root, "state"), memory: join(root, "memory.db") };
  for (const d of [f.home, f.state]) mkdirSync(d, { recursive: true });
  new Database(f.memory).close();
  write(join(f.home, BRIDGE), `#!/usr/bin/env bash
echo "fixture bridge finished the task"
exit 0
`, 0o755);
  write(join(f.home, EXECUTOR_REGISTRY_RELATIVE), JSON.stringify({ executors: executors.map(([id, b]) => entry(id, b)) }));
  write(join(f.home, "packages/zo-swarm-orchestrator/assets/persona-registry.json"), '{"personas":[]}');
  return f;
}

async function runCampaign(f: ReturnType<typeof fixture>, tasks: Array<Record<string, unknown>>) {
  const id = `f4-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  campaigns.push(id);
  const tasksFile = join(f.root, "tasks.json");
  write(tasksFile, JSON.stringify(tasks.map(t => ({ persona: "auto", task: "Write a one-line note.", priority: "medium", ...t }))));
  const proc = Bun.spawn([process.execPath, SCRIPT, tasksFile, "--swarm-id", id, "--max-retries", "0", "--concurrency", "1", "--plan-gate-mode", "disabled"], {
    cwd: f.root,
    env: {
      ...process.env,
      HOME: join(f.state, "home"), SWARM_DIR: f.state, ZO_MEMORY_DB: f.memory, ZOUROBOROS_MEMORY_DB: f.memory,
      SWARM_SPECIALIST_MODE: "off", ZO_TRACE_ID: undefined,
      SWARM_WORKSPACE: f.home, ZOUROBOROS_WORKSPACE_ROOT: undefined, ZOUROBOROS_WORKSPACE: undefined, ZO_WORKSPACE: undefined,
      SWARM_EXECUTOR_REGISTRY: undefined, SWARM_PERSONA_REGISTRY: undefined,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  const rp = join(f.state, "results", `${id}.json`);
  return { id, stdout, stderr, exitCode, results: existsSync(rp) ? JSON.parse(readFileSync(rp, "utf8")) : null };
}
const diag = (run: { stdout: string; stderr: string }) => run.stdout.slice(-3000) + run.stderr.slice(-1500);
const byTask = (results: any) => Object.fromEntries((results?.results ?? []).map((r: any) => [r.task.id, r]));

describe("F4 e2e: a bridgeless executor degrades, the swarm runs", () => {
  test("multi-executor campaign with a bridgeless entry: other tasks complete, the exclusion is reported in plain language", async () => {
    const f = fixture([["fx-a", BRIDGE], ["fx-ghost", undefined]]);
    const run = await runCampaign(f, [
      { id: "t-a", executor: "fx-a" },
      { id: "t-auto" },
    ]);
    expect({ code: run.exitCode, diag: run.exitCode ? diag(run) : "" }).toEqual({ code: 0, diag: "" });
    expect(run.stdout).not.toContain("No bridge found");
    expect(run.stdout).toContain("fx-ghost is left out of this swarm: its registry entry names no bridge script");
    expect(run.stdout).toContain("To fix:");
    const r = byTask(run.results);
    expect(r["t-a"].success).toBe(true);
    expect(r["t-auto"].success).toBe(true);
    // the router never picked the bridgeless executor
    expect(Object.values(r).map((x: any) => x.effectiveExecutor)).not.toContain("fx-ghost");
    expect(run.results.excludedExecutors).toEqual([expect.objectContaining({ executor: "fx-ghost", cause: "no_bridge" })]);
    expect(run.results.exclusionNotes[0]).toContain("fx-ghost is left out of this swarm");
  }, 60_000);

  test("a task pinned to the bridgeless executor is routed to a working one — the swarm is not stopped", async () => {
    const f = fixture([["fx-a", BRIDGE], ["fx-ghost", undefined]]);
    const run = await runCampaign(f, [
      { id: "t-ghost", executor: "fx-ghost" },
      { id: "t-a", executor: "fx-a" },
    ]);
    expect({ code: run.exitCode, diag: run.exitCode ? diag(run) : "" }).toEqual({ code: 0, diag: "" });
    expect(run.stdout).not.toContain("Pre-flight failed");
    expect(run.stdout).toContain("fx-ghost is left out of this swarm (asked for by t-ghost)");
    expect(run.stdout).toContain("Pinned executor fx-ghost is left out of this swarm");
    const r = byTask(run.results);
    expect(r["t-ghost"].success).toBe(true);
    expect(r["t-ghost"].effectiveExecutor).toBe("fx-a");
    expect(r["t-a"].success).toBe(true);
    expect(run.results.excludedExecutors[0]).toMatchObject({ executor: "fx-ghost", tasks: ["t-ghost"] });
  }, 60_000);

  test("a pin to an unregistered executor degrades the same way", async () => {
    const f = fixture([["fx-a", BRIDGE]]);
    const run = await runCampaign(f, [{ id: "t-nope", executor: "nope" }]);
    expect({ code: run.exitCode, diag: run.exitCode ? diag(run) : "" }).toEqual({ code: 0, diag: "" });
    expect(run.stdout).toContain("nope is left out of this swarm (asked for by t-nope): no executor named 'nope' is registered");
    expect(byTask(run.results)["t-nope"].success).toBe(true);
  }, 60_000);

  test("only bridgeless executors: pre-flight stops with the exclusion named, not 'No bridge found'", async () => {
    const f = fixture([["fx-ghost", undefined]]);
    const run = await runCampaign(f, [{ id: "t-ghost", executor: "fx-ghost" }]);
    expect(run.stdout).toContain("No runnable executors: fx-ghost is left out of this swarm");
    expect(run.stdout).not.toContain("No bridge found");
  }, 60_000);
});
