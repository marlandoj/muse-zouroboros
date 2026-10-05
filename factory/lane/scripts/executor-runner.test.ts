import { describe, expect, test } from "bun:test";
import { runExecutorChain, type ExecutorLifecycleEvent, type ExecutorChainOptions } from "./executor-runner";
import { classifyHarnessFailureDetail, type HarnessRunResult } from "./harness-router";
import { factoryClaimStorageKeyV2 } from "./factory-claim-identity";
import type { FactoryExecutionSubject } from "./factory-execution-subject";

function result(executorId: string, success: boolean, output = "ok"): HarnessRunResult {
  return { executorId, success, output, durationMs: 1000 };
}

describe("executor runner", () => {
  test("classifies transport evidence without treating arbitrary 5xx prose as transport", () => {
    expect(classifyHarnessFailureDetail("API error: 503 Service Unavailable")).toBe("transport");
    expect(classifyHarnessFailureDetail("ACP session timed out after 30000ms")).toBe("transport");
    expect(classifyHarnessFailureDetail("unit test expected status 500 but got 200")).toBe("execution");
  });

  test("emits the complete lifecycle in contract order", async () => {
    const events: ExecutorLifecycleEvent[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      idleTimeoutMs: 250,
      env: { ZO_TRACE_ID: "factory:exec-test" },
      chain: ["claude-code"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (_id, _prompt, options) => {
        if (!options) throw new Error("executor options missing");
        expect(options.env).toEqual({ ZO_TRACE_ID: "factory:exec-test" });
        expect(options.idleTimeoutMs).toBe(250);
        options.onOutput?.("chunk");
        return {
          ...result("claude-code", true),
          modelUsed: "synthetic-new/hf:zai-org/GLM-5.2",
          tokensUsed: 30,
          inputTokens: 20,
          outputTokens: 10,
          costUsd: 0.004,
        };
      },
      onEvent: (event) => events.push(event),
    });

    expect(run.success).toBe(true);
    expect(run.modelUsed).toBe("synthetic-new/hf:zai-org/GLM-5.2");
    expect(run.tokensUsed).toBe(30);
    expect(run.inputTokens).toBe(20);
    expect(run.outputTokens).toBe(10);
    expect(run.costUsd).toBe(0.004);
    expect(events.map((event) => event.kind)).toEqual([
      "exec.start",
      "probe.ok",
      "executor.start",
      "executor.ok",
      "exec.implementation_complete",
    ]);
  });

  test("propagates the idle budget to every failover rung", async () => {
    const idleBudgets: Array<number | undefined> = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      idleTimeoutMs: 80,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (id, _prompt, options) => {
        idleBudgets.push(options?.idleTimeoutMs);
        return result(id, id === "codex");
      },
    });

    expect(run.executorId).toBe("codex");
    expect(idleBudgets).toEqual([80, 80]);
  });

  test("fails over without dispatching an unhealthy executor", async () => {
    const calls: string[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async (id) => ({ healthy: id === "codex", message: id }),
      harnessRun: async (id) => {
        calls.push(id);
        return result(id, true);
      },
    });

    expect(run.executorId).toBe("codex");
    expect(calls).toEqual(["codex"]);
  });

  test("fails over after an executor returns an unsuccessful result", async () => {
    const calls: string[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (id) => {
        calls.push(id);
        return result(id, id === "codex", id === "codex" ? "ok" : "failed");
      },
    });

    expect(run.success).toBe(true);
    expect(run.executorId).toBe("codex");
    expect(calls).toEqual(["claude-code", "codex"]);
    expect(run.trail[0]).toContain("claude-code=fail");
  });

  test("walks the full six-harness chain before selecting Kimi", async () => {
    const chain = ["claude-code", "opencode", "codex", "gemini", "pi", "kimi"];
    const calls: string[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain,
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (id) => {
        calls.push(id);
        return result(id, id === "kimi", id === "kimi" ? "ok" : "failed");
      },
    });

    expect(run.success).toBe(true);
    expect(run.executorId).toBe("kimi");
    expect(calls).toEqual(chain);
    expect(run.trail).toHaveLength(6);
    expect(run.trail.at(-1)).toContain("kimi=ok");
  });

  test("never infers transport from failed agent output", async () => {
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async () => result("codex", false, "API error: 503 Service Unavailable"),
    });

    expect(run.trail[0]).toContain("codex=fail(1s):execution:API error: 503 Service Unavailable");
  });

  test("fails over after an executor throws", async () => {
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: true, message: "ok" }),
      harnessRun: async (id) => {
        if (id === "claude-code") throw new Error("socket hang up: ECONNRESET");
        return result(id, true);
      },
    });

    expect(run.executorId).toBe("codex");
    expect(run.trail[0]).toContain("claude-code=throw:transport:socket hang up: ECONNRESET");
  });

  test("treats a throwing health probe as unhealthy and continues", async () => {
    const calls: string[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async (id) => {
        if (id === "claude-code") throw new Error("probe unavailable");
        return { healthy: true, message: "ok" };
      },
      harnessRun: async (id) => {
        calls.push(id);
        return result(id, true);
      },
    });

    expect(run.executorId).toBe("codex");
    expect(calls).toEqual(["codex"]);
    expect(run.trail[0]).toBe("executor:claude-code=unhealthy");
  });

  test("records a terminal failure after the chain is exhausted", async () => {
    const events: ExecutorLifecycleEvent[] = [];
    const run = await runExecutorChain({
      prompt: "test",
      workdir: "/tmp",
      timeoutMs: 1000,
      chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: false, message: "down" }),
      harnessRun: async (id) => result(id, true),
      onEvent: (event) => events.push(event),
    });

    expect(run.success).toBe(false);
    expect(run.error).toContain("chain exhausted");
    expect(events.at(-1)?.kind).toBe("exec.failed");
    expect(run.trail).toEqual([
      "executor:claude-code=unhealthy",
      "executor:codex=unhealthy",
    ]);
  });
});

function factorySubject(): FactoryExecutionSubject {
  const workId = `fw_${"a".repeat(64)}`;
  return { schema: "factory-execution-subject/v1", provider: "hermes", factory_work_id: workId,
    claim_key: factoryClaimStorageKeyV2({ schema: "factory-claim-subject/v2", provider: "hermes", work_id: workId }),
    claim_generation: 1, claim_owner: "factory-cap-one", reader_proof_sha256: "b".repeat(64), execution_id: "exec-hermes-one" };
}

describe("single-launch Factory runner", () => {
  test.each(["unsuccessful", "throw", "malformed", "output-observer-throw"])("holds %s without a second launch", async failure => {
    const calls: string[] = [], events: ExecutorLifecycleEvent[] = [];
    const subject = factorySubject();
    const run = await runExecutorChain({ prompt: "synthetic", workdir: "/tmp", timeoutMs: 1000,
      launchPolicy: "single_launch", factorySubject: subject, chain: ["claude-code", "codex"],
      healthProbe: async () => ({ healthy: true, message: "fixture" }),
      harnessRun: async (id, _prompt, options) => {
        calls.push(id);
        if (failure === "throw") throw new Error("lost connection after effect");
        if (failure === "output-observer-throw") options?.onOutput?.("partial effect");
        if (failure === "malformed") return { ...result(id, true), durationMs: NaN };
        return result(id, false);
      },
      onOutput: () => { if (failure === "output-observer-throw") throw new Error("observer failed"); },
      onEvent: event => events.push(event) });
    expect(calls).toEqual(["claude-code"]);
    expect(run.success).toBe(false);
    expect(run.error).toBe("FACTORY_EXECUTOR_EFFECT_UNCERTAIN");
    expect(run.launch).toEqual({ policy: "single_launch", count: 1, effect: "uncertain" });
    expect(run.factorySubject).toEqual(subject);
    expect(events.at(-1)?.kind).toBe("exec.held");
    expect(events.at(-1)?.data?.retry_eligible).toBe(false);
    expect(events.every(event => event.data?.factory_subject === run.factorySubject)).toBe(true);
  });

  test("skips unhealthy candidates before exactly one launch and retains subject through success", async () => {
    const calls: string[] = [], events: ExecutorLifecycleEvent[] = [];
    const subject = factorySubject();
    const run = await runExecutorChain({ prompt: "synthetic", workdir: "/tmp", timeoutMs: 1000,
      launchPolicy: "single_launch", factorySubject: subject, chain: ["unavailable", "codex", "claude-code"],
      healthProbe: async id => ({ healthy: id !== "unavailable", message: "fixture" }),
      harnessRun: async id => { calls.push(id); return result(id, true); },
      onEvent: event => events.push(event) });
    expect(calls).toEqual(["codex"]);
    expect(run.success).toBe(true);
    expect(run.launch).toEqual({ policy: "single_launch", count: 1, effect: "completed" });
    expect(run.factorySubject).toEqual(subject);
    expect(Object.isFrozen(run.factorySubject)).toBe(true);
    expect(events.at(-1)?.kind).toBe("exec.implementation_complete");
    expect(events.every(event => event.data?.factory_subject === run.factorySubject)).toBe(true);
  });

  test("snapshots policy, subject and call inputs before async observers can mutate them", async () => {
    const subject = factorySubject(), original = { ...subject }, calls: string[] = [];
    const options: ExecutorChainOptions = { prompt: "bound", workdir: "/tmp/original", timeoutMs: 1000,
      env: { FACTORY_EXECUTION: "original" }, launchPolicy: "single_launch", factorySubject: subject,
      chain: ["codex", "claude-code"],
      healthProbe: async () => {
        options.launchPolicy = "fallback"; subject.claim_generation = 999;
        options.prompt = "changed"; options.workdir = "/changed"; options.env!.FACTORY_EXECUTION = "changed";
        return { healthy: true, message: "fixture" };
      },
      harnessRun: async (id, prompt, call) => {
        calls.push(id); expect(prompt).toBe("bound"); expect(call?.workdir).toBe("/tmp/original");
        expect(call?.env).toEqual({ FACTORY_EXECUTION: "original" }); return result(id, false);
      } };
    const run = await runExecutorChain(options);
    expect(calls).toEqual(["codex"]);
    expect(run.factorySubject).toEqual(original);
    expect(run.launch?.effect).toBe("uncertain");
  });

  test("snapshots successful output before lifecycle observers can rewrite it", async () => {
    const supplied = result("codex", true, "original"), subject = factorySubject();
    const run = await runExecutorChain({ prompt: "synthetic", workdir: "/tmp", timeoutMs: 1000,
      launchPolicy: "single_launch", factorySubject: subject, chain: ["codex"],
      healthProbe: async () => ({ healthy: true, message: "fixture" }), harnessRun: async () => supplied,
      onEvent: event => { if (event.kind === "executor.ok") { supplied.success = false; supplied.output = "rewritten"; } } });
    expect(run.success).toBe(true); expect(run.output).toBe("original");
    expect(run.launch?.effect).toBe("completed");
  });

  test("reports zero launches after health failures without claiming an uncertain effect", async () => {
    let calls = 0;
    const run = await runExecutorChain({ prompt: "synthetic", workdir: "/tmp", timeoutMs: 1000,
      launchPolicy: "single_launch", factorySubject: factorySubject(), chain: ["codex"],
      healthProbe: async () => { throw new Error("unavailable"); }, harnessRun: async id => { calls++; return result(id, true); } });
    expect(calls).toBe(0);
    expect(run.launch).toEqual({ policy: "single_launch", count: 0, effect: "not_started" });
    expect(run.factorySubject?.execution_id).toBe("exec-hermes-one");
  });

  test.each(["executor.fail", "executor.throw", "exec.held", "executor.ok", "exec.implementation_complete"])(
    "retains uncertain evidence when the %s observer throws after launch", async boundary => {
      let launches = 0;
      const run = await runExecutorChain({ prompt: "synthetic", workdir: "/tmp", timeoutMs: 1000,
        launchPolicy: "single_launch", factorySubject: factorySubject(), chain: ["codex", "claude-code"],
        healthProbe: async () => ({ healthy: true, message: "fixture" }),
        harnessRun: async id => {
          launches++;
          if (boundary === "executor.throw") throw new Error("lost response");
          return result(id, boundary === "executor.ok" || boundary === "exec.implementation_complete");
        },
        onEvent: event => { if (event.kind === boundary) throw new Error("observer lost its durable output"); } });
      expect(launches).toBe(1);
      expect(run.success).toBe(false);
      expect(run.error).toBe("FACTORY_EXECUTOR_EFFECT_UNCERTAIN");
      expect(run.launch).toEqual({ policy: "single_launch", count: 1, effect: "uncertain" });
      expect(run.factorySubject?.execution_id).toBe("exec-hermes-one");
    });

  test("unrenderable thrown values cannot erase the post-launch uncertainty result", async () => {
    const badMessage = new Error();
    Object.defineProperty(badMessage, "message", { get: () => { throw new Error("message getter"); } });
    const badString = { toString() { throw new Error("toString hook"); } };
    const nullMessage = new Error(); Object.defineProperty(nullMessage, "message", { value: null });
    for (const thrown of [badMessage, badString, nullMessage]) {
      let launches = 0;
      const run = await runExecutorChain({ prompt: "synthetic", workdir: "/tmp", timeoutMs: 1000,
        launchPolicy: "single_launch", factorySubject: factorySubject(), chain: ["codex", "claude-code"],
        healthProbe: async () => ({ healthy: true, message: "fixture" }),
        harnessRun: async () => { launches++; throw thrown; } });
      expect(launches).toBe(1);
      expect(run.error).toBe("FACTORY_EXECUTOR_EFFECT_UNCERTAIN");
      expect(run.launch?.effect).toBe("uncertain");
      expect(run.trail[0]).toContain("unrenderable executor failure");
    }
  });

  test("refuses malformed identity or policy before health and dispatch", async () => {
    let calls = 0;
    const base: ExecutorChainOptions = { prompt: "synthetic", workdir: "/tmp", timeoutMs: 1000,
      launchPolicy: "single_launch", chain: ["codex"], healthProbe: async () => { calls++; return { healthy: true, message: "fixture" }; },
      harnessRun: async id => { calls++; return result(id, true); } };
    for (const change of [{ provider: "linear" }, { claim_key: "fc2_" + "0".repeat(64) }, { claim_generation: 0 },
      { claim_owner: 123 }, { reader_proof_sha256: {} }, { execution_id: "bad" }, { unexpected: true }]) {
      await expect(runExecutorChain({ ...base, factorySubject: { ...factorySubject(), ...change } as FactoryExecutionSubject })).rejects.toThrow("FACTORY_EXECUTOR_SUBJECT");
    }
    await expect(runExecutorChain({ ...base, factorySubject: factorySubject(), launchPolicy: "fallback" })).rejects.toThrow("REQUIRES_SINGLE_LAUNCH");
    await expect(runExecutorChain({ ...base, launchPolicy: "unknown" as "fallback" })).rejects.toThrow("LAUNCH_POLICY");
    expect(calls).toBe(0);
  });
});
