import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createNativeReviewerCaller, type NativeCommand, type NativeCommandResult,
  type NativeReviewPlan, type NativeReviewReceipt,
} from "./native-review-adapter";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const flags = "--safe-mode --print --output-format --model --tools --disable-slash-commands --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --system-prompt --max-budget-usd";
function plan(): NativeReviewPlan {
  return {
    schema: "native-review-plan/v1", harness: "claude-code", executable: "/opt/qualified/claude",
    executableSha256: "a".repeat(64), version: "2.1.263", profileHome: "/var/lib/reviewer/auth-only",
    profileSha256: "b".repeat(64), emptyWorkdir: "/var/lib/reviewer/empty", implementerModel: "gpt-6-astra",
    implementerVendor: "openai", maxCalls: 2, maxTimeoutMs: 60_000, maxInputBytes: 8192,
    maxOutputBytes: 65_536, maxReportedCostUsd: 2,
    reviewers: [{ id: "native:factory:tester:v1", name: "Testing Reality Checker", model: "claude-opus-5",
      vendor: "anthropic", prompt: "Review evidence honestly. Preserve dissent.",
      promptSha256: hash("Review evidence honestly. Preserve dissent.") }],
  };
}
const request = { input: "Frozen synthetic evidence. All tests passed.", persona_id: "native:factory:tester:v1", model_name: "claude-opus-5", timeout_ms: 30_000 };
const success = (stdout: string): NativeCommandResult => ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, overflow: false });
function envelope(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: false, num_turns: 1,
    session_id: "fixture-session", permission_denials: [], modelUsage: { "claude-opus-5": {} },
    total_cost_usd: 0.25, result: JSON.stringify({ verdict: "pass", summary: "Fixtures support the claim." }), ...overrides });
}
function fixture(options: {
  configuredPlan?: NativeReviewPlan;
  mode?: "shadow" | "qualification";
  result?: NativeCommandResult;
  help?: string;
  auth?: Record<string, unknown>;
  verify?: (plan: Readonly<NativeReviewPlan>) => Promise<void>;
  reserve?: () => Promise<void>;
  complete?: (receipt: NativeReviewReceipt) => Promise<void>;
} = {}) {
  const configuredPlan = options.configuredPlan ?? plan();
  const commands: NativeCommand[] = [];
  const receipts: NativeReviewReceipt[] = [];
  let inspections = 0;
  const caller = createNativeReviewerCaller({
    plan: configuredPlan, expectedPlanSha256: hash(JSON.stringify(configuredPlan)), mode: options.mode,
    dependencies: {
      async verifyInstallation(measured) { inspections++; await options.verify?.(measured); },
      async reserve(receipt) { await options.reserve?.(); receipts.push(receipt); },
      async complete(receipt) { await options.complete?.(receipt); receipts.push(receipt); },
      async invoke(command) {
        commands.push(command);
        if (command.args[0] === "--help") return success(options.help ?? flags);
        if (command.args[0] === "--version") return success("2.1.263 (Claude Code)\n");
        if (command.args[0] === "auth") return success(JSON.stringify(options.auth ?? {
          loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty",
        }));
        return options.result ?? success(envelope());
      },
    },
  });
  return { caller, commands, receipts, inspections: () => inspections };
}

describe("native subscription reviewer qualification", () => {
  test("default shadow performs no model, CLI, installation or ledger operation", async () => {
    const f = fixture();
    await expect(f.caller(request)).rejects.toThrow("SHADOW_NO_CALL");
    expect(f.commands).toEqual([]); expect(f.receipts).toEqual([]); expect(f.inspections()).toBe(0);
  });

  test("uses fixed no-tools argv, minimal environment and existing subscription preflight", async () => {
    const f = fixture({ mode: "qualification" });
    const result = await f.caller(request);
    expect(JSON.parse(result.output).verdict).toBe("pass");
    expect(result.cost_usd).toBe(0.25); expect(result.model_name).toBe(request.model_name);
    expect(f.commands.map((item) => item.args[0])).toEqual(["--help", "--version", "auth", "--safe-mode"]);
    const command = f.commands[3]!;
    expect(command.args[command.args.indexOf("--tools") + 1]).toBe("");
    expect(command.args[command.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    expect(command.args[command.args.indexOf("--setting-sources") + 1]).toBe("");
    expect(command.args).toContain("--disable-slash-commands");
    expect(command.args).toContain("--strict-mcp-config");
    expect(command.args).not.toContain("--bare");
    expect(Object.keys(command.env).sort()).toEqual(["HOME", "LANG", "PATH", "TZ"]);
    expect(f.receipts.map((item) => item.status)).toEqual(["started", "completed"]);
  });

  test("retains a failing review as durable dissent, not transport success approval", async () => {
    const f = fixture({ mode: "qualification", result: success(envelope({
      result: JSON.stringify({ verdict: "fail", summary: "A required revocation check is absent." }),
    })) });
    const result = await f.caller(request);
    expect(JSON.parse(result.output).verdict).toBe("fail");
    expect(f.receipts[1]!.verdict).toBe("fail");
    expect(f.receipts[1]!.summary).toContain("revocation");
  });

  test("does not invoke when installation or durable reservation fails", async () => {
    for (const failure of ["verify", "reserve"] as const) {
      const f = fixture({ mode: "qualification", [failure]: async () => { throw new Error("secret fixture failure"); } });
      await expect(f.caller(request)).rejects.toThrow();
      expect(f.commands).toEqual([]);
      expect(JSON.stringify(f.receipts)).not.toContain("secret fixture failure");
    }
  });

  test("missing tool controls and API-key auth cannot reach review invocation", async () => {
    for (const config of [
      { help: flags.replace("--tools", "") },
      { auth: { loggedIn: true, authMethod: "api-key", apiProvider: "firstParty" } },
      { auth: { loggedIn: false, authMethod: "claude.ai", apiProvider: "firstParty" } },
    ]) {
      const f = fixture({ mode: "qualification", ...config });
      await expect(f.caller(request)).rejects.toThrow("NATIVE_REVIEW_");
      expect(f.commands.some((item) => item.args[0] === "--safe-mode")).toBe(false);
      expect(f.receipts.at(-1)!.status).toBe("failed");
    }
  });

  test("rejects malformed, nonterminal, tool-denied, multi-turn and model-drift envelopes", async () => {
    for (const raw of ["not JSON", envelope({ subtype: "error" }), envelope({ num_turns: 2 }),
      envelope({ permission_denials: [{ tool_name: "Bash" }] }), envelope({ modelUsage: { "claude-sonnet-5": {} } }),
      envelope({ result: JSON.stringify({ verdict: "pass", summary: "ok", another: true }) }),
      envelope({ result: "Here is a result: {\"verdict\":\"pass\",\"summary\":\"ok\"}" }),
      envelope({ total_cost_usd: 3 }), envelope({ total_cost_usd: null }),
    ]) {
      const f = fixture({ mode: "qualification", result: success(raw) });
      await expect(f.caller(request)).rejects.toThrow("NATIVE_REVIEW_");
      expect(f.receipts.at(-1)!.status).toBe("failed");
    }
  });

  test("timeout, oversized output and uncertain process completion fail without retry", async () => {
    for (const override of [{ timedOut: true }, { overflow: true }, { exitCode: null }, { signal: "SIGKILL" },
      { stdout: "a".repeat(65_537) }, { stderr: "secret transport error" }]) {
      const f = fixture({ mode: "qualification", result: { ...success(envelope()), ...override } });
      await expect(f.caller(request)).rejects.toThrow("NATIVE_REVIEW_");
      expect(f.commands.filter((item) => item.args[0] === "--safe-mode")).toHaveLength(1);
      expect(JSON.stringify(f.receipts)).not.toContain("secret transport error");
    }
  });

  test("redacts supplied secrets before transport and before durable dissent", async () => {
    const secret = "sk-fixtureSensitiveToken123456";
    const f = fixture({ mode: "qualification", result: success(envelope({
      result: JSON.stringify({ verdict: "fail", summary: `Found ${secret}; password=fixture-password` }),
    })) });
    const result = await f.caller({ ...request, input: `api_key=${secret}; Authorization: Bearer fixture-auth` });
    expect(JSON.stringify(f.commands)).not.toContain(secret);
    expect(JSON.stringify(f.commands)).not.toContain("fixture-auth");
    expect(result.output).not.toContain(secret);
    expect(JSON.stringify(f.receipts)).not.toContain("fixture-password");
  });

  test("bounds requests before calls and consumes failed attempt capacity", async () => {
    const p = plan(); p.maxCalls = 1;
    const f = fixture({ configuredPlan: p, mode: "qualification", result: success("bad") });
    await expect(f.caller({ ...request, persona_id: "missing" })).rejects.toThrow("IDENTITY_MISMATCH");
    await expect(f.caller({ ...request, timeout_ms: 60_001 })).rejects.toThrow("INPUT_LIMIT");
    expect(f.commands).toEqual([]);
    await expect(f.caller(request)).rejects.toThrow("MALFORMED");
    await expect(f.caller(request)).rejects.toThrow("CALL_CAP");
    expect(f.receipts.filter((item) => item.status === "started")).toHaveLength(1);
  });

  test("redacts prefixed secret environment names and quoted JSON keys in both directions", async () => {
    const values = ["LINEAR_API_KEY=lin_api_fixture123", '{"OPENAI_API_KEY":"fixture-openai-value"}',
      "CLAUDE_CODE_OAUTH_TOKEN='fixture-oauth-value'", '{"client_secret":"fixture-client-value"}',
      "GITHUB_TOKEN=fixture-github-value", "a bare lin_api_fixture456 token"];
    const f = fixture({ mode: "qualification", result: success(envelope({
      result: JSON.stringify({ verdict: "fail", summary: values.join("\n") }),
    })) });
    await f.caller({ ...request, input: values.join("\n") });
    const retained = JSON.stringify({ commands: f.commands, receipts: f.receipts });
    for (const value of ["lin_api_fixture123", "fixture-openai-value", "fixture-oauth-value",
      "fixture-client-value", "fixture-github-value", "lin_api_fixture456"]) expect(retained).not.toContain(value);
  });

  test("requires pinned exact native identity and distinct provider", () => {
    for (const change of [
      (p: NativeReviewPlan) => { p.reviewers[0]!.prompt = "mutated"; },
      (p: NativeReviewPlan) => { p.reviewers.push({ ...p.reviewers[0]! }); },
      (p: NativeReviewPlan) => { (p as unknown as { implementerVendor: string }).implementerVendor = "anthropic"; },
      (p: NativeReviewPlan) => { p.implementerModel = "claude-sonnet-5"; },
      (p: NativeReviewPlan) => { (p as unknown as { harness: string }).harness = "codex"; },
    ]) {
      const p = plan(); change(p);
      expect(() => fixture({ configuredPlan: p })).toThrow("NATIVE_REVIEW_");
    }
  });

  test("caller mutation cannot change snapshotted policy", async () => {
    const p = plan(); const f = fixture({ configuredPlan: p, mode: "qualification" });
    p.reviewers[0]!.model = "claude-injected"; p.executable = "/tmp/evil";
    await f.caller(request);
    expect(f.commands[3]!.executable).toBe("/opt/qualified/claude");
    expect(f.commands[3]!.args).not.toContain("claude-injected");
  });

  test("validated request cannot change while installation awaits", async () => {
    const mutableRequest = { ...request };
    const f = fixture({ mode: "qualification", verify: async () => {
      mutableRequest.timeout_ms = 900_000; mutableRequest.model_name = "claude-injected";
      mutableRequest.input = "changed after validation";
    } });
    await f.caller(mutableRequest);
    expect(f.commands[3]!.timeoutMs).toBe(30_000);
    expect(f.commands[3]!.args).not.toContain("claude-injected");
    expect(f.commands[3]!.stdin).not.toContain("changed after validation");
  });

  test("installation callback cannot mutate nested pinned policy", async () => {
    const f = fixture({ mode: "qualification", verify: async (measured) => {
      measured.reviewers[0]!.model = "claude-injected";
    } });
    await expect(f.caller(request)).rejects.toThrow("DEPENDENCY_FAILURE");
    expect(f.commands).toEqual([]);
  });

  test("receipt persistence failure cannot become a passing caller result", async () => {
    const f = fixture({ mode: "qualification", complete: async () => { throw new Error("unavailable"); } });
    await expect(f.caller(request)).rejects.toThrow();
    expect(f.receipts).toHaveLength(1); expect(f.receipts[0]!.status).toBe("started");
  });

  test("completion callback cannot clear a malformed-provider failure", async () => {
    const f = fixture({ mode: "qualification", result: success("malformed"), complete: async (receipt) => {
      expect(Object.isFrozen(receipt)).toBe(true);
      expect(() => { receipt.failureCode = null; }).toThrow();
      expect(Reflect.set(receipt, "status", "completed")).toBe(false);
    } });
    await expect(f.caller(request)).rejects.toThrow("NATIVE_REVIEW_MALFORMED");
    expect(f.receipts[1]!.status).toBe("failed");
    expect(f.receipts[1]!.failureCode).toBe("NATIVE_REVIEW_MALFORMED");
  });

  test("completion callback cannot change retained dissent or the returned review", async () => {
    const summary = "A required revocation check is absent.";
    const f = fixture({ mode: "qualification", result: success(envelope({
      result: JSON.stringify({ verdict: "fail", summary }),
    })), complete: async (receipt) => {
      expect(Reflect.set(receipt, "verdict", "pass")).toBe(false);
      expect(Reflect.set(receipt, "summary", "Forged approval.")).toBe(false);
    } });
    const result = await f.caller(request);
    expect(JSON.parse(result.output)).toEqual({ verdict: "fail", summary });
    expect(f.receipts[1]!.verdict).toBe("fail"); expect(f.receipts[1]!.summary).toBe(summary);
  });
});
