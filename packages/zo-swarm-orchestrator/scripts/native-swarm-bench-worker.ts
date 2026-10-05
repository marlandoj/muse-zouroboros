import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { spawnSync } from "node:child_process";
import {
  nativeChildCalls,
  nativeDelegationRequests,
} from "./native-swarm-bench-support";
const [runtime, dir, kind, harness, model] = process.argv.slice(2) as string[];
const emit = (x: unknown) =>
  writeFileSync(join(dir, "receipt.json"), JSON.stringify(x, null, 2) + "\n");
const mod = (path: string) => import(join(runtime, "packages/swarm/src", path));
const events: any[] = [];
const env = {
  ...process.env,
  SWARM_SYNTHETIC_CANARY: "1",
  SWARM_WORKSPACE: dir,
  ZOUROBOROS_WORKSPACE_ROOT: dir,
  SWARM_DIR: join(dir, "state"),
  SWARM_DB_PATH: join(dir, "state/swarm.db"),
  ZOUROBOROS_MEMORY_DB: join(dir, "state/memory.db"),
  ZO_MEMORY_DB: join(dir, "state/memory.db"),
  SWARM_HARNESS_SMOKE: "0",
  SWARM_TRACE_VERIFY: "1",
  SWARM_TRACE_VERIFY_ENFORCE: "1",
};
Object.assign(process.env, env);
process.chdir(dir);
spawnSync("git", ["init", "--quiet"], { cwd: dir });
mkdirSync(join(dir, "src"), { recursive: true });
mkdirSync(join(dir, "state"), { recursive: true });
writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: {} }));
const registry = JSON.parse(
  readFileSync(
    join(
      runtime,
      "packages/swarm/src/executor/registry/executor-registry.json"
    ),
    "utf8"
  )
);
for (const entry of registry.executors)
  if (entry.bridge) entry.bridge = join(runtime, entry.bridge);
for (const entry of registry.executors) {
  if (entry.acp?.adapterArgs) entry.acp.adapterArgs = entry.acp.adapterArgs.map((arg: string) =>
    !isAbsolute(arg) && arg.includes('/') && existsSync(join(runtime, arg)) ? join(runtime, arg) : arg);
}
const registryPath = join(dir, "registry.json");
writeFileSync(registryPath, JSON.stringify(registry));
process.env.SWARM_EXECUTOR_REGISTRY = registryPath;
const { resolveModelForExecutor } = await mod("routing/model-router.ts");
const { createTransport, resolveTransportType } = await mod(
  "transport/factory.ts"
);
const { CircuitBreaker } = await mod("circuit/breaker.ts");
const { SwarmOrchestrator } = await mod("orchestrator.ts");
const { closeDb } = await mod("db/schema.ts");
const { stripDelegationReport } = await mod("hierarchical.ts");
const task = (id: string, prompt: string, executor?: string) => ({
  id,
  task: prompt,
  executor,
  priority: "medium",
  timeoutSeconds: 100,
});
const bounded =
  "Synthetic benchmark. Only read or edit files inside " +
  dir +
  ". Do not access memory, networks, or other repositories. Do not install dependencies. ";
const prompt =
  bounded +
  `Read input.json. Create src/ledger.ts exporting totalCents(rows), accepting an array of {kind:"charge"|"refund",cents:number}, adding charges and subtracting refunds. Throw on unknown kind, negative/noninteger cents, or a non-array input. Create src/summary.ts that imports totalCents from ./ledger and exports summarize(rows) returning {count:rows.length,cents:totalCents(rows)}. Write summary.json for input.json. Use filesystem tools. Do not edit input.json. Then reply BENCH_DONE.`;
const input = [
  { kind: "charge", cents: 1200 },
  { kind: "refund", cents: 250 },
  { kind: "charge", cents: 500 },
  { kind: "refund", cents: 100 },
];
writeFileSync(join(dir, "input.json"), JSON.stringify(input));
const oracle = () => {
  const code = `import {totalCents} from ${JSON.stringify(
    join(dir, "src/ledger.ts")
  )};import {summarize} from ${JSON.stringify(
    join(dir, "src/summary.ts")
  )};import{readFileSync}from'node:fs';const eq=(a,b)=>{if(typeof b==='object'&&b!==null?Object.keys(b).some(k=>a?.[k]!==b[k]):a!==b)throw Error('assertion mismatch '+JSON.stringify(a))};const rows=${JSON.stringify(
    input
  )};eq(totalCents(rows),1350);eq(totalCents([]),0);eq(summarize(rows),{count:4,cents:1350});eq(JSON.parse(readFileSync(${JSON.stringify(
    join(dir, "summary.json")
  )},'utf8')),{count:4,cents:1350});for(const x of [[{kind:'other',cents:1}],[{kind:'charge',cents:-1}],[{kind:'charge',cents:1.2}],null]){let threw=false;try{totalCents(x)}catch{threw=true}if(!threw)throw Error('invalid input accepted')}console.log('8 artifact/import assertions passed')`;
  const p = spawnSync(process.execPath, ["-e", code], {
    encoding: "utf8",
    timeout: 15000,
    cwd: dir,
  });
  return { passed: p.status === 0, output: (p.stdout + p.stderr).slice(-3000) };
};
// Do not persist streamed model thoughts or unrelated command inventories.
const capture = (event: any) => {
  if (!["tool_call", "tool_result", "error", "usage"].includes(event.type))
    return;
  events.push(event);
  writeFileSync(join(dir, "events.json"), JSON.stringify(events, null, 2));
};
let orch: any, transport: any;
try {
  if (kind === "executor" || kind === "bridge") {
    const entry = registry.executors.find((e: any) => e.id === harness);
    if (!entry) throw Error("unregistered harness");
    const t = task("executor-" + harness, prompt, harness);
    (t as any).model = model || "swarm-mid";
    const route = resolveModelForExecutor(t, harness, "moderate", entry);
    if (!route?.model) throw Error("model resolution failed");
    transport = createTransport(
      kind === "bridge"
        ? { ...entry, transport: "bridge", transportFallback: undefined }
        : entry,
      new CircuitBreaker()
    );
    const started = Date.now();
    const result = await transport.execute(t, {
      timeoutMs: 100000,
      idleTimeoutMs: 65000,
      workdir: dir,
      env: { SWARM_RESOLVED_MODEL: route.model, SWARM_SYNTHETIC_CANARY: "1" },
      onUpdate: capture,
    });
    const acceptance = oracle();
    const applied = result.modelUsed?.trim();
    const modelVerified = applied === route.model;
    emit({
      kind,
      harness,
      transport: kind === "bridge" ? "bridge" : resolveTransportType(entry),
      requested: (t as any).model,
      resolved: route.model,
      appliedModel: applied,
      modelProvenance: result.modelProvenance,
      modelEvidence:
        "Harness metadata; not independent provider billing attestation",
      modelVerified,
      executionPass: result.success && acceptance.passed,
      success: result.success && acceptance.passed && modelVerified,
      error:
        result.error ||
        (!modelVerified
          ? applied
            ? "Model selection mismatch"
            : "Harness did not return model evidence"
          : !acceptance.passed
          ? "Artifact assertions failed"
          : undefined),
      durationMs: Date.now() - started,
      result,
      acceptance,
      events: events.length,
    });
  } else if (kind === "campaign") {
    const taskPath = join(dir, "tasks.json");
    writeFileSync(
      taskPath,
      JSON.stringify([
        {
          ...task("campaign-ledger", prompt, "claude-code"),
          persona: "claude-code",
          model: "claude-opus-5",
          maxRetries: 0,
        },
      ])
    );
    const p = spawnSync(
      process.execPath,
      [
        join(runtime, "packages/swarm/scripts/orchestrate-v5.ts"),
        taskPath,
        "--swarm-id",
        "native-bench-campaign",
        "--timeout",
        "100",
      ],
      { cwd: dir, env: process.env, encoding: "utf8", timeout: 155000 }
    );
    writeFileSync(join(dir, "campaign.log"), p.stdout + p.stderr);
    const saved = JSON.parse(
      readFileSync(
        join(dir, "state/results/native-bench-campaign.json"),
        "utf8"
      )
    );
    const acceptance = oracle();
    const result = saved.results?.[0];
    emit({
      kind,
      success:
        p.status === 0 &&
        result?.success &&
        acceptance.passed &&
        result?.modelUsed?.trim() === "claude-opus-5",
      result,
      acceptance,
      cliCode: p.status,
    });
  } else {
    orch = new SwarmOrchestrator({
      localConcurrency: 2,
      timeoutSeconds: 100,
      maxRetries: 0,
      enableMemory: false,
      dbPath: join(dir, ".swarm/swarm.db"),

      specialistConsult: { mode: "off" },
      hierarchicalDelegation: {
        enabled: true,
        maxDepth: 1,
        defaultMode: "auto",
        claudeCodeMaxChildren: 2,
        hermesMaxChildren: 2,
      },
    });
    // Production seed validation reads WORKSPACE/.swarm/swarm.db. Seed only the
    // isolated fixture through its public API instead of disabling that gate.
    for (const entry of registry.executors)
      orch
        .getRoleRegistry()
        .create({
          id: "bench-" + entry.id,
          name: "Bench " + entry.id,
          executorId: entry.id,
          tags: [],
          description: "Synthetic benchmark role",
        });
    orch.initBudget({
      totalBudgetUSD: 3,
      alertThresholdPct: 80,
      hardCapAction: "abort",
    });
    // Observe production transports without replacing their behavior.
    for (const [id, tr] of orch.transports) {
      const execute = tr.execute.bind(tr);
      tr.execute = (t: any, o: any) =>
        execute(t, {
          ...o,
          onUpdate: (e: any) => capture({ ...e, executor: id, task: t.id }),
        });
    }
    if (kind === "dag") {
      const a = {
        ...task(
          "left",
          bounded +
            "Create src/left.ts exporting const left = 17. Reply LEFT_DONE.",
          "gemini"
        ),
        model: "gemini-3.8-flash",
        expectedMutations: [{ file: join(dir, "src/left.ts"), contains: "17" }],
      };
      const b = {
        ...task(
          "right",
          bounded +
            "Create src/right.ts exporting const right = 25. Reply RIGHT_DONE.",
          "pi"
        ),
        model: "synthetic/hf:zai-org/GLM-5.3-Flash",
        expectedMutations: [
          { file: join(dir, "src/right.ts"), contains: "25" },
        ],
      };
      const c = {
        ...task(
          "join",
          bounded +
            "Read src/left.ts and src/right.ts. Create src/join.ts importing both and exporting const answer=left+right. Reply DAG_DONE.",
          "auto"
        ),
        dependsOn: ["left", "right"],
        expectedMutations: [
          { file: join(dir, "src/join.ts"), contains: "answer" },
        ],
      };
      const results = await orch.run([a, b, c]);
      const p = spawnSync(
        process.execPath,
        [
          "-e",
          `import{answer}from'./src/join.ts';if(answer!==42)throw Error('wrong answer');console.log(answer)`,
        ],
        { cwd: dir, encoding: "utf8", timeout: 10000 }
      );
      emit({
        kind,
        success: results.every((r: any) => r.success) && p.status === 0,
        results,
        acceptance: { passed: p.status === 0, output: p.stdout + p.stderr },
        events: events.length,
      });
    } else if (kind === "fallback") {
      const primary = orch.transports.get("gemini");
      const execute = primary.execute.bind(primary);
      primary.execute = (t: any, o: any) =>
        t.id === "fault-injected-fallback"
          ? Promise.resolve({
              task: t,
              success: false,
              error: "BENCH_INJECTED_PRIMARY_OUTAGE",
              durationMs: 0,
              retries: 0,
            })
          : execute(t, o);
      const t = {
        ...task("fault-injected-fallback", prompt, "gemini"),
        model: "swarm-light",
      };
      const results = await orch.run([t]);
      const acceptance = oracle();
      emit({
        kind,
        faultInjection:
          "primary transport fails before provider call; fallback uses real provider",
        success:
          results[0]?.success &&
          results[0]?.effectiveExecutor === "pi" &&
          results[0]?.fallbacksAttempted > 0 &&
          acceptance.passed,
        results,
        acceptance,
      });
    } else if (kind === "subagents") {
      const p =
        bounded +
        "You MUST invoke two real native subagents using your Agent/Task/delegation tool. Child alpha writes only src/alpha.ts exporting const alpha=17. Child beta writes only src/beta.ts exporting const beta=25. Do not perform their work yourself or simulate delegation. Wait for both and then create src/combined.ts importing both and exporting answer=alpha+beta. Include the required delegation_report with actual child IDs and outcomes. If no delegation tool exists, report that failure honestly.";
      const t = {
        ...task("native-children", p, harness),
        model: model || "swarm-mid",
        timeoutSeconds: 180,
        delegation: {
          mode: "auto",
          maxChildren: 2,
          writeScopes: [
            { childId: "alpha", paths: ["src/alpha.ts"] },
            { childId: "beta", paths: ["src/beta.ts"] },
          ],
        },
        expectedMutations: [
          { file: join(dir, "src/alpha.ts"), contains: "17" },
          { file: join(dir, "src/beta.ts"), contains: "25" },
          { file: join(dir, "src/combined.ts"), contains: "answer" },
        ],
      };
      const results = await orch.run([t]);
      const p2 = spawnSync(
        process.execPath,
        [
          "-e",
          `import{answer}from'./src/combined.ts';if(answer!==42)throw Error('wrong answer')`,
        ],
        { cwd: dir, encoding: "utf8", timeout: 10000 }
      );
      const parsed = stripDelegationReport(results[0]?.output || "");
      const nativeIds = nativeChildCalls(events);
      const childRequests = nativeDelegationRequests(events);
      emit({
        kind,
        harness,
        success: results[0]?.success && p2.status === 0 && childRequests >= 2,
        artifactPass: p2.status === 0,
        nativeChildToolCalls: nativeIds.length,
        nativeChildRequests: childRequests,
        nativeChildToolCallIds: nativeIds,
        productionChildRecords: results[0]?.childRecords || [],
        parentReportedChildren: parsed.childRecords,
        results,
        acceptanceOutput: p2.stderr,
      });
    } else throw Error("unknown case kind");
  }
} catch (error) {
  emit({
    kind,
    harness,
    success: false,
    error: String(error),
    events: events.length,
  });
} finally {
  if (transport) await transport.shutdown();
  if (orch) await orch.shutdown();
  closeDb();
}
