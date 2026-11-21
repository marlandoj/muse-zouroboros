#!/usr/bin/env bun
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { finishCase, classifyFailure } from "./native-swarm-bench-support";
const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1] || fallback;
};
if (args.includes("--help")) {
  console.log(
    "bun native-swarm-bench.ts --workspace /opt/zouroboros/repo [--out NEW_DIR] [--only offline|models|executor|bridge|dag|fallback|subagents|campaign] [--harness ID] [--model MODEL] [--case ID] [--max-calls 36] [--budget 10]"
  );
  process.exit(0);
}
const runtime = resolve(option("--workspace", "/opt/zouroboros/repo"));
const out = resolve(
  option(
    "--out",
    "/var/lib/zouroboros/swarm-bench/" +
      new Date().toISOString().replace(/[:.]/g, "-")
  )
);
if (existsSync(out) && readdirSync(out).length)
  throw Error(
    "Output directory must be new or empty; stale artifacts cannot be accepted"
  );
mkdirSync(out, { recursive: true, mode: 0o750 });
const only = option("--only", "all"),
  filter = option("--harness", "all"),
  one = option("--case", "all");
const maxCalls = Number(option("--max-calls", "36")),
  budget = Number(option("--budget", "10"));
if (
  !Number.isInteger(maxCalls) ||
  maxCalls < 1 ||
  maxCalls > 40 ||
  !Number.isFinite(budget) ||
  budget <= 0 ||
  budget > 20
)
  throw Error("invalid bounded bench limits");
if (
  ![
    "all",
    "offline",
    "models",
    "executor",
    "bridge",
    "dag",
    "fallback",
    "subagents",
    "campaign",
  ].includes(only)
)
  throw Error("unknown --only mode");
const selectedModelOverride = option("--model", "");
if (selectedModelOverride && filter === "all") throw Error("--model requires an explicit --harness");
const registryPath = join(
  runtime,
  "packages/swarm/src/executor/registry/executor-registry.json"
);
const raw = readFileSync(registryPath, "utf8");
const registry = JSON.parse(raw);
if (filter !== "all" && !registry.executors.some((e: any) => e.id === filter))
  throw Error("unregistered --harness");
const results: any[] = [];
let reservedCalls = 0;
const sha = (p: string) =>
  createHash("sha256").update(readFileSync(p)).digest("hex");
const report: any = {
  version: 2,
  runtime,
  startedAt: new Date().toISOString(),
  registrySha256: createHash("sha256").update(raw).digest("hex"),
  runnerSha256: sha(import.meta.path),
  workerSha256: sha(join(import.meta.dir, "native-swarm-bench-worker.ts")),
  limits: {
    maxCalls,
    reservationBudgetUsd: budget,
    reservationPerCallUsd: 0.25,
    note: "Scheduling reservation only, not a provider billing cap. Agent turns and native children may each make multiple provider requests.",
  },
  results,
};
const save = () => {
  report.reservedCalls = reservedCalls;
  report.reservedUsd = reservedCalls * 0.25;
  report.summary = {
    passed: results.filter((r) => r.success === true).length,
    failed: results.filter((r) => r.success === false).length,
    blocked: results.filter((r) => r.blocked).length,
  };
  writeFileSync(
    join(out, "report.json"),
    JSON.stringify(report, null, 2) + "\n"
  );
};
save();
// Kill detached descendants as well as the worker on an outer timeout.
function descendants(root: number): number[] {
  const map = new Map<number, number[]>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync("/proc/" + name + "/stat", "utf8");
      const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      const parent = Number(parts[1]);
      map.set(parent, [...(map.get(parent) || []), Number(name)]);
    } catch {}
  }
  const all: number[] = [];
  const walk = (p: number) => {
    for (const child of map.get(p) || []) {
      walk(child);
      all.push(child);
    }
  };
  walk(root);
  return all;
}
async function runChild(
  cmd: string[],
  cwd: string,
  env: Record<string, string | undefined>,
  timeoutMs: number
): Promise<{ code: number | null; timedOut: boolean; output: string }> {
  return new Promise((resolve) => {
    const p = spawn(cmd[0]!, cmd.slice(1), {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "",
      timedOut = false;
    const capture = (b: Buffer) => {
      if (output.length < 250000) output += b.toString();
    };
    p.stdout.on("data", capture);
    p.stderr.on("data", capture);
    const timer = setTimeout(() => {
      timedOut = true;
      for (const pid of [...descendants(p.pid!), p.pid!])
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
    }, timeoutMs);
    p.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut: false, output: String(e) });
    });
    p.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, output });
    });
  });
}
const env = {
  ...process.env,
  SWARM_SYNTHETIC_CANARY: "1",
  SWARM_WORKSPACE: runtime,
  ZOUROBOROS_WORKSPACE_ROOT: runtime,
  SWARM_EXECUTOR_REGISTRY: registryPath,
};
if (only === "all" || only === "offline") {
  const testRoot = resolve(import.meta.dir, "..");
  const paths = [
    "scripts/native-swarm-bench.test.ts",
    "src/__tests__/model-router.test.ts",
    "src/__tests__/executor-selector.test.ts",
    "src/__tests__/acp-transport.test.ts",
    "src/__tests__/dag-integration.test.ts",
    "src/__tests__/hierarchical-regression.test.ts",
    "src/__tests__/hierarchical-history-report.test.ts",
    "src/__tests__/hierarchical-status-summary.test.ts",
    "src/__tests__/hierarchical-validation-fixture.test.ts",
    "src/__tests__/budget-governor.test.ts",
    "src/__tests__/orchestrator-fallback.test.ts",
    "src/__tests__/bridge-authority.test.ts",
    "src/__tests__/bridge-receipt.test.ts",
    "src/__tests__/postflight-trace-verify.test.ts",
  ];
  for (const path of paths)
    if (!existsSync(join(testRoot, path)))
      throw Error("Required regression suite missing: " + path);
  const testHome = join(out, "offline-home");
  mkdirSync(testHome, { recursive: true });
  // Existing tests own their fixture registries and databases. Inheriting native
  // production overrides can silently redirect mocked tasks and episode writes.
  const offlineEnv = {
    PATH: process.env.PATH,
    HOME: testHome,
    TMPDIR: process.env.TMPDIR,
    ZOUROBOROS_MODEL_CATALOG_PATH: join(out, "no-catalog/current.json"),
  };
  const r = await runChild(
    [process.execPath, "test", ...paths],
    testRoot,
    offlineEnv,
    120000
  );
  writeFileSync(join(out, "offline.log"), r.output);
  results.push({
    id: "offline",
    kind: "offline",
    success: r.code === 0 && !r.timedOut,
    ...r,
    output: r.output.slice(-1500),
  });
  save();
}
if (only === "all" || only === "models") {
  const { resolveModelForExecutor } = await import(
    join(runtime, "packages/swarm/src/routing/model-router.ts")
  );
  const { selectExecutor } = await import(
    join(runtime, "packages/swarm/src/selector/executor-selector.ts")
  );
  const { selectShared } = await import(
    join(runtime, "packages/swarm/src/routing/shared-catalog.ts")
  );
  for (const entry of registry.executors)
    for (const alias of ["swarm-light", "swarm-mid", "swarm-heavy"]) {
      const t = {
        id: "model",
        task: "Synthetic selection",
        executor: entry.id,
        model: alias,
      };
      const r = resolveModelForExecutor(t, entry.id, "simple", entry);
      results.push({
        id: `model-${entry.id}-${alias}`,
        kind: "models",
        success: !!r?.model && !/^(swarm-|light$|mid$|heavy$)/.test(r.model),
        route: r,
      });
    }
  let retired = false;
  try {
    selectExecutor(
      { id: "cursor", task: "synthetic", executor: "cursor" },
      null,
      {},
      registry.executors
    );
  } catch {
    retired = true;
  }
  results.push({ id: "cursor-rejected", kind: "models", success: retired });
  const health = Object.fromEntries(
    registry.executors.map((e: any) => [e.id, { state: "CLOSED", failures: 0 }])
  );
  const t = { id: "auto", task: "Implement UI", executor: "auto" };
  const s = selectExecutor(t, null, health, registry.executors);
  const m = resolveModelForExecutor(
    t,
    s.executorId,
    "simple",
    registry.executors.find((e: any) => e.id === s.executorId)
  );
  results.push({
    id: "automatic-qualified",
    kind: "models",
    success: selectShared("swarm").some(
      (r: any) => r.harness === s.executorId && r.model === m?.model
    ),
    selection: s,
    model: m?.model,
  });
  save();
}
const cases: any[] = [];
for (const kind of ["executor", "bridge"])
  for (const e of registry.executors) {
    if (kind === "bridge" && !e.bridge) continue;
    cases.push({
      id: kind + "-" + e.id,
      kind,
      harness: e.id,
      model: selectedModelOverride || (e.id === "pi" ? "synthetic/hf:zai-org/GLM-5.3-Flash" : "swarm-mid"),
      calls: 1,
      timeout: 130000,
    });
  }
report.unsupportedComparisons = registry.executors
  .filter((e: any) => !e.bridge)
  .map((e: any) => ({
    id: "bridge-" + e.id,
    reason: "No shell bridge declared; use its registered transport",
  }));
cases.push(
  { id: "dag", kind: "dag", calls: 9, timeout: 420000 },
  { id: "fallback", kind: "fallback", calls: 2, timeout: 220000 },
  {
    id: "subagents-claude-code",
    kind: "subagents",
    harness: "claude-code",
    model: "claude-opus-5",
    calls: 5,
    timeout: 260000,
  },
  {
    id: "subagents-hermes",
    kind: "subagents",
    harness: "hermes",
    model: "claude-opus-5",
    calls: 5,
    timeout: 260000,
  }
);
cases.push({
  id: "campaign-cli",
  kind: "campaign",
  harness: "claude-code",
  model: "claude-opus-5",
  calls: 2,
  timeout: 180000,
});
if (one !== "all" && !cases.some((c) => c.id === one))
  throw Error("unknown --case");
for (const c of cases) {
  if (
    (only !== "all" && only !== c.kind) ||
    (filter !== "all" && c.harness !== filter) ||
    (one !== "all" && c.id !== one)
  )
    continue;
  if (
    reservedCalls + c.calls > maxCalls ||
    (reservedCalls + c.calls) * 0.25 > budget
  ) {
    results.push({ ...c, blocked: "bench budget reservation exhausted" });
    save();
    continue;
  }
  reservedCalls += c.calls;
  const dir = join(out, c.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.json"), JSON.stringify(c, null, 2));
  save();
  console.log(JSON.stringify({ event: "start", id: c.id, reservedCalls }));
  const r = await runChild(
    [
      process.execPath,
      join(import.meta.dir, "native-swarm-bench-worker.ts"),
      runtime,
      dir,
      c.kind,
      c.harness || "",
      c.model || "",
    ],
    dir,
    env,
    c.timeout
  );
  writeFileSync(join(dir, "worker.log"), r.output);
  let result: any;
  try {
    result = JSON.parse(readFileSync(join(dir, "receipt.json"), "utf8"));
  } catch {
    result = {
      success: false,
      error: r.timedOut ? "outer timeout" : "worker exited without receipt",
      code: r.code,
      output: r.output.slice(-3000),
    };
  }
  const checked = finishCase(result, r);
  const error = String(checked.error || checked.result?.error || "");
  results.push({
    ...c,
    ...checked,
    failureCategory: checked.success ? undefined : classifyFailure(error),
  });
  save();
  console.log(
    JSON.stringify({
      event: "finish",
      id: c.id,
      success: checked.success,
      error: error.slice(0, 600),
    })
  );
}
if (!results.length) throw Error("No cases matched the requested filters");
report.finishedAt = new Date().toISOString();
save();
console.log(
  JSON.stringify({ report: join(out, "report.json"), summary: report.summary })
);
process.exitCode = report.summary.failed || report.summary.blocked ? 1 : 0;
