import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  runHetznerExecutor,
  type HetznerExecutorTicket,
} from "./hetzner-executor-adapter";
import { CODING_CASCADE_MODELS, CascadeDispatchError } from "./coding-cascade";
import { resolveHetznerExecutionRoute } from "./hetzner-executor-policy";
import type { EphemeralWorkerEvidence } from "../../../packages/hetzner-exec/src/ephemeral-worker";

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}`);
  return result.stdout;
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "hetzner-adapter-test-"));
  run("git", ["init", "-q"], root);
  run("git", ["config", "user.email", "factory@example.invalid"], root);
  run("git", ["config", "user.name", "Factory Test"], root);
  mkdirSync(join(root, ".factory"), { recursive: true });
  writeFileSync(join(root, ".factory", "external-compute.json"), `${JSON.stringify({
    version: 1,
    commands: ["bun test"],
    verification: "remote-required",
  }, null, 2)}\n`);
  writeFileSync(join(root, "value.txt"), "old\n");
  run("git", ["add", "."], root);
  run("git", ["commit", "-qm", "baseline"], root);
  return root;
}

const TICKET: HetznerExecutorTicket = {
  identifier: "ZOU-TEST",
  title: "Change the value",
  description: "Use Hetzner for this build. Change value.txt from old to new.",
};

const BASE_ENV = {
  FACTORY_CODING_CASCADE: "enforce",
  SF_HETZNER_EXECUTOR: "1",
  ZO_CLIENT_IDENTITY_TOKEN: "test-zo-token",
};

function fakeEvidence(input: {
  evidenceDir: string;
  status?: "passed" | "failed";
  serverType?: string;
  failedCommand?: string;
  teardown?: boolean;
}): EphemeralWorkerEvidence {
  const status = input.status ?? "passed";
  const command = input.failedCommand ?? "bun test";
  const evidence: EphemeralWorkerEvidence = {
    version: 1,
    run_id: `factory-test-${Math.random().toString(36).slice(2, 8)}`,
    status,
    server: { id: 42, name: "zbr-test", type: input.serverType ?? "ccx23", image: "ubuntu-24.04", location: "hel1" },
    limits: { ttl_minutes: 60, max_cost_usd: 0.25, hourly_cost_usd: 0.1626 },
    started_at: "2026-08-05T00:00:00.000Z",
    completed_at: "2026-08-05T00:05:00.000Z",
    elapsed_ms: 300_000,
    estimated_cost_usd: 0.01355,
    commands: [{
      command,
      exit_code: status === "passed" ? 0 : 1,
      stdout: "",
      stderr: status === "passed" ? "" : "test failed",
      elapsed_ms: 1_000,
      timed_out: false,
    }],
    artifact_archive: null,
    remote_environment: { keys: [] },
    teardown: {
      server_deleted: input.teardown ?? true,
      ssh_key_deleted: input.teardown ?? true,
    },
    error: status === "passed" ? null : `command failed (1): ${command}`,
  };
  mkdirSync(input.evidenceDir, { recursive: true });
  writeFileSync(join(input.evidenceDir, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`);
  return evidence;
}

function dirs() {
  return {
    stateDir: mkdtempSync(join(tmpdir(), "hetzner-adapter-state-")),
    evidenceDir: mkdtempSync(join(tmpdir(), "hetzner-adapter-evidence-")),
  };
}

describe("Hetzner BYOK cascade executor adapter", () => {
  test("uses Opus through Zo BYOK, sends no model credential to Hetzner, and preserves verified changes", async () => {
    const root = repo();
    const { stateDir, evidenceDir } = dirs();
    let receivedServerType = "";
    const result = await runHetznerExecutor({
      executionId: "exec-primary",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      stateDir,
      evidenceDir,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      byokRun: async (input) => {
        expect(input.model).toBe(CODING_CASCADE_MODELS[0].id);
        expect(input.token).toBe("test-zo-token");
        writeFileSync(join(root, "value.txt"), "new\n");
        return { output: "implemented", model: input.model };
      },
      workerRun: async (input) => {
        receivedServerType = input.manifest.server_type ?? "";
        expect(input.remoteEnv).toEqual({});
        expect(input.manifest.commands.some((command) => command.includes("OPENAI_API_KEY"))).toBe(false);
        expect(input.manifest.commands.some((command) => command.includes("@openai/codex"))).toBe(false);
        expect(input.manifest.commands).toContain("bun test");
        return fakeEvidence({ evidenceDir: input.evidenceDir, serverType: input.manifest.server_type });
      },
    });

    expect(result.pass).toBe(true);
    expect(result.implementation_provider).toBe("zo-byok");
    expect(result.implementation_model).toBe(CODING_CASCADE_MODELS[0].id);
    expect(result.implementation_trail).toContain("Claude Code - Opus=ok");
    expect(result.patch_applied).toBe(false);
    expect(receivedServerType).toBe("ccx23");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("new\n");
    expect(await Bun.file(join(stateDir, "active.lock", "owner.json")).exists()).toBe(false);
  });

  test("captures structured author answers and preserves the exact off-path prompt", async () => {
    const answerRecord = 'CHANGE_QUIZ_ANSWERS_JSON: {"files_modified":["value.txt"],"primary_change":"Changes old to new.","scope_not_changed":"The verification manifest is unchanged.","side_effects":"Consumers expecting old may fail.","control_flags":[]}';
    const prompts: string[] = [];
    const runOnce = async (mode: "advisory" | "off") => {
      const root = repo();
      const { stateDir, evidenceDir } = dirs();
      return runHetznerExecutor({
        executionId: `exec-quiz-${mode}`,
        ticket: TICKET,
        decision: "DIRECT",
        workdir: root,
        stateDir,
        evidenceDir,
        env: { ...BASE_ENV, FACTORY_CHANGE_QUIZ: mode },
        activeWorkerProbe: () => false,
        byokRun: async (input) => {
          prompts.push(input.prompt);
          writeFileSync(join(root, "value.txt"), "new\n");
          return { output: answerRecord, model: input.model };
        },
        workerRun: async (input) => fakeEvidence({ evidenceDir: input.evidenceDir, serverType: input.manifest.server_type }),
      });
    };

    const advisory = await runOnce("advisory");
    const off = await runOnce("off");

    expect(prompts[0]).toContain("CHANGE_QUIZ_ANSWERS_JSON:");
    expect(advisory.change_quiz_answers?.files_modified).toEqual(["value.txt"]);
    expect(prompts[1]).not.toContain("CHANGE_QUIZ_ANSWERS_JSON:");
    expect("change_quiz_answers" in off).toBe(false);
  });

  test("runs the BYOK cascade inside a linked factory worktree", async () => {
    const root = repo();
    const worktree = mkdtempSync(join(tmpdir(), "hetzner-adapter-linked-"));
    run("git", ["worktree", "add", "-q", "-b", `factory-test-${Date.now()}`, worktree], root);
    const { stateDir, evidenceDir } = dirs();

    const result = await runHetznerExecutor({
      executionId: "exec-linked-worktree",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: worktree,
      stateDir,
      evidenceDir,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      byokRun: async (input) => {
        writeFileSync(join(worktree, "value.txt"), "new\n");
        return { output: "implemented", model: input.model };
      },
      workerRun: async (input) => {
        expect(input.workdir).toBe(worktree);
        expect(input.remoteEnv).toEqual({});
        return fakeEvidence({ evidenceDir: input.evidenceDir, serverType: input.manifest.server_type });
      },
    });

    expect(result.pass).toBe(true);
    expect(readFileSync(join(worktree, "value.txt"), "utf8")).toBe("new\n");
    expect(run("git", ["rev-parse", "--git-dir"], worktree).trim()).not.toBe(".git");
  });

  test("restores the clean base and falls back to Sol after remote mechanical validation fails", async () => {
    const root = repo();
    const { stateDir, evidenceDir } = dirs();
    const requested: string[] = [];
    let workerCalls = 0;
    const result = await runHetznerExecutor({
      executionId: "exec-validation-fallback",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      stateDir,
      evidenceDir,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      byokRun: async (input) => {
        requested.push(input.model);
        if (requested.length === 2) expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("old\n");
        writeFileSync(join(root, "value.txt"), requested.length === 1 ? "bad\n" : "new\n");
        return { output: "implemented", model: input.model };
      },
      workerRun: async (input) => {
        workerCalls++;
        expect(input.remoteEnv).toEqual({});
        return fakeEvidence({
          evidenceDir: input.evidenceDir,
          status: workerCalls === 1 ? "failed" : "passed",
          serverType: input.manifest.server_type,
        });
      },
    });

    expect(result.pass).toBe(true);
    expect(requested).toEqual(CODING_CASCADE_MODELS.slice(0, 2).map((model) => model.id));
    expect(result.implementation_model).toBe(CODING_CASCADE_MODELS[1].id);
    expect(result.cascade_attempts[0].failure?.kind).toBe("mechanical_validation");
    expect(result.cascade_attempts[0].decision?.action).toBe("retry");
    expect(result.implementation_trail).toContain("Claude Code - Opus=mechanical_validation");
    expect(result.implementation_trail).toContain("Codex GPT 5.6 Sol=ok");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("new\n");
  });

  test("falls back to Sol after a BYOK transport failure", async () => {
    const root = repo();
    const { stateDir, evidenceDir } = dirs();
    let calls = 0;
    const result = await runHetznerExecutor({
      executionId: "exec-transport-fallback",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      stateDir,
      evidenceDir,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      byokRun: async (input) => {
        calls++;
        if (calls === 1) throw new CascadeDispatchError("provider unavailable", "transport");
        expect(input.model).toBe(CODING_CASCADE_MODELS[1].id);
        expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("old\n");
        writeFileSync(join(root, "value.txt"), "new\n");
        return { output: "implemented", model: input.model };
      },
      workerRun: async (input) => fakeEvidence({ evidenceDir: input.evidenceDir, serverType: input.manifest.server_type }),
    });

    expect(result.pass).toBe(true);
    expect(result.cascade_attempts[0].failure?.kind).toBe("transport");
    expect(result.implementation_model).toBe(CODING_CASCADE_MODELS[1].id);
  });

  test("fails closed and leaves no rejected changes when all cascade models fail validation", async () => {
    const root = repo();
    const { stateDir, evidenceDir } = dirs();
    const result = await runHetznerExecutor({
      executionId: "exec-exhausted",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      stateDir,
      evidenceDir,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      byokRun: async (input) => {
        writeFileSync(join(root, "value.txt"), `${input.model}\n`);
        return { output: "implemented", model: input.model };
      },
      workerRun: async (input) => fakeEvidence({
        evidenceDir: input.evidenceDir,
        status: "failed",
        serverType: input.manifest.server_type,
      }),
    });

    expect(result.pass).toBe(false);
    expect(result.cascade_attempts).toHaveLength(CODING_CASCADE_MODELS.length);
    expect(result.cascade_attempts.at(-1)?.decision?.action).toBe("exhausted");
    expect(readFileSync(join(root, "value.txt"), "utf8")).toBe("old\n");
    expect(run("git", ["status", "--porcelain"], root).trim()).toBe("");
  });

  test("requires cascade enforcement and a Zo credential before any worker is provisioned", async () => {
    const root = repo();
    const { stateDir, evidenceDir } = dirs();
    let workerCalls = 0;
    const workerRun = async () => {
      workerCalls++;
      throw new Error("must not run");
    };
    const off = await runHetznerExecutor({
      executionId: "exec-off",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      stateDir,
      evidenceDir,
      env: {
        SF_HETZNER_EXECUTOR: "1",
        FACTORY_CODING_CASCADE: "off",
        ZO_CLIENT_IDENTITY_TOKEN: "test",
      },
      workerRun,
    });
    const noToken = await runHetznerExecutor({
      executionId: "exec-no-token",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      stateDir,
      evidenceDir,
      env: {
        SF_HETZNER_EXECUTOR: "1",
        FACTORY_CODING_CASCADE: "enforce",
        ZO_CLIENT_IDENTITY_TOKEN: undefined,
        ZO_TOKEN: undefined,
      },
      workerRun,
    });

    expect(off.pass).toBe(false);
    expect(off.summary).toContain("FACTORY_CODING_CASCADE=enforce");
    expect(noToken.pass).toBe(false);
    expect(noToken.summary).toContain("ZO_CLIENT_IDENTITY_TOKEN / ZO_TOKEN");
    expect(workerCalls).toBe(0);
  });

  test("refuses a non-BYOK ticket model override", async () => {
    const root = repo();
    const result = await runHetznerExecutor({
      executionId: "exec-metered-override",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      env: BASE_ENV,
      executionPolicy: {
        tier: "Routine",
        pin_proposers: [],
        pin_aggregator: null,
        model_chain: ["openrouter:some-metered-model"],
        review_level: "deterministic",
      },
      workerRun: async () => { throw new Error("must not run"); },
    });

    expect(result.pass).toBe(false);
    expect(result.summary).toContain("refuses non-BYOK model route");
  });

  test("fails closed when the target is unsupported or lacks verification commands", async () => {
    const unsupportedRoot = repo();
    const unsupportedTicket = { ...TICKET, description: "Use Hetzner with an NVIDIA GPU for CUDA." };
    const unsupported = await runHetznerExecutor({
      executionId: "exec-gpu",
      ticket: unsupportedTicket,
      decision: "DIRECT",
      workdir: unsupportedRoot,
      env: BASE_ENV,
      route: resolveHetznerExecutionRoute(unsupportedTicket, BASE_ENV),
      workerRun: async () => { throw new Error("must not run"); },
    });

    const noManifest = mkdtempSync(join(tmpdir(), "hetzner-no-manifest-"));
    run("git", ["init", "-q"], noManifest);
    run("git", ["config", "user.email", "factory@example.invalid"], noManifest);
    run("git", ["config", "user.name", "Factory Test"], noManifest);
    writeFileSync(join(noManifest, "value.txt"), "old\n");
    run("git", ["add", "."], noManifest);
    run("git", ["commit", "-qm", "baseline"], noManifest);
    const missingVerification = await runHetznerExecutor({
      executionId: "exec-no-verification",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: noManifest,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      workerRun: async () => { throw new Error("must not run"); },
    });

    expect(unsupported.pass).toBe(false);
    expect(unsupported.summary).toContain("CPU-only");
    expect(missingVerification.pass).toBe(false);
    expect(missingVerification.summary).toContain(".factory/external-compute.json");
  });

  test("refuses a dirty worktree and enforces one global in-flight lease", async () => {
    const dirtyRoot = repo();
    writeFileSync(join(dirtyRoot, "value.txt"), "dirty\n");
    const dirty = await runHetznerExecutor({
      executionId: "exec-dirty",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: dirtyRoot,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      workerRun: async () => { throw new Error("must not run"); },
    });
    expect(dirty.pass).toBe(false);
    expect(dirty.summary).toContain("clean isolated worktree");

    const root = repo();
    const { stateDir, evidenceDir } = dirs();
    const lockDir = join(stateDir, "active.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify({
      version: 1,
      execution_id: "exec-other",
      ticket: "ZOU-OTHER",
      pid: 1,
      acquired_at: "2026-08-05T00:00:00.000Z",
      expires_at: "2099-01-01T00:00:00.000Z",
    }));
    const blocked = await runHetznerExecutor({
      executionId: "exec-blocked",
      ticket: TICKET,
      decision: "DIRECT",
      workdir: root,
      stateDir,
      evidenceDir,
      env: BASE_ENV,
      activeWorkerProbe: () => false,
      workerRun: async () => { throw new Error("must not run"); },
    });
    expect(blocked.pass).toBe(false);
    expect(blocked.summary).toContain("exec-other/ZOU-OTHER");
  });
});
