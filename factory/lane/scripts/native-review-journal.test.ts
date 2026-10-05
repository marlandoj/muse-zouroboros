import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OperationJournal, type JournalAuthority } from "./run-operation-journal";
import { canonicalize, computeReceiptHash } from "./run-receipt-contract";
import { createJournaledNativeReviewer, type JournaledNativeReviewOptions, type NativeReviewBinding } from "./native-review-journal";
import { type NativeCommand, type NativeCommandResult, type NativeReviewPlan } from "./native-review-adapter";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const flags = "--safe-mode --print --output-format --model --tools --disable-slash-commands --strict-mcp-config --mcp-config --setting-sources --no-session-persistence --system-prompt --max-budget-usd";
const STATE_DIR = resolve(import.meta.dir, "../state");
let root: string;
const previousMode = process.env.FACTORY_STATE_MODE, previousRoot = process.env.FACTORY_STATE_DIR;
beforeAll(() => {
  mkdirSync(STATE_DIR, { recursive: true }); root = mkdtempSync(join(STATE_DIR, "native-review-journal-test-"));
  process.env.FACTORY_STATE_MODE = "test"; delete process.env.FACTORY_STATE_DIR;
});
afterAll(() => {
  if (dirname(resolve(root)) !== STATE_DIR) throw new Error("unexpected fixture root");
  rmSync(root, { recursive: true, force: true });
  if (previousMode === undefined) delete process.env.FACTORY_STATE_MODE; else process.env.FACTORY_STATE_MODE = previousMode;
  if (previousRoot === undefined) delete process.env.FACTORY_STATE_DIR; else process.env.FACTORY_STATE_DIR = previousRoot;
});
function plan(): NativeReviewPlan {
  return {
    schema: "native-review-plan/v1", harness: "claude-code", executable: "/opt/qualified/claude", executableSha256: "a".repeat(64),
    version: "2.1.263", profileHome: "/var/lib/reviewer/auth-only", profileSha256: "b".repeat(64), emptyWorkdir: "/var/lib/reviewer/empty",
    implementerModel: "gpt-6-astra", implementerVendor: "openai", maxCalls: 2, maxTimeoutMs: 60_000,
    maxInputBytes: 8192, maxOutputBytes: 65_536, maxReportedCostUsd: 2,
    reviewers: [{ id: "native:factory:tester:v1", name: "Testing Reality Checker", model: "claude-opus-5", vendor: "anthropic",
      prompt: "Review evidence honestly. Preserve dissent.", promptSha256: hash("Review evidence honestly. Preserve dissent.") }],
  };
}
function authority(): JournalAuthority {
  return { envelopeKind: "operator_approval", approvingAuthority: "fixture-operator", approvalTs: "2026-09-25T00:00:00.000Z",
    approvalRef: "fixture:approval", autonomyTier: "T0", authorizationEvidenceRef: "fixture:authority",
    scopes: ["operation.reserve", "native-review.invoke"], expiresAt: "2026-09-25T02:00:00.000Z" };
}
const request = { input: "Frozen synthetic evidence.", persona_id: "native:factory:tester:v1", model_name: "claude-opus-5", timeout_ms: 30_000 };
function binding(workId = "fixture-work"): NativeReviewBinding {
  return { workId, sourceRevision: "c".repeat(40), roleId: request.persona_id, round: 1 };
}
const success = (stdout: string): NativeCommandResult => ({ exitCode: 0, signal: null, stdout, stderr: "", timedOut: false, overflow: false });
const envelope = (verdict = "pass", summary = "Synthetic fixture evidence.") => JSON.stringify({ type: "result", subtype: "success", is_error: false,
  num_turns: 1, session_id: "synthetic", permission_denials: [], modelUsage: { "claude-opus-5": {} }, total_cost_usd: .25,
  result: JSON.stringify({ verdict, summary }) });
function fixture(name: string, overrides: Partial<JournaledNativeReviewOptions> = {}, transport?: (c: NativeCommand) => Promise<NativeCommandResult>) {
  const configuredPlan = overrides.plan ?? plan();
  const commands: NativeCommand[] = [];
  let inspections = 0;
  const options: JournaledNativeReviewOptions = {
    plan: configuredPlan, expectedPlanSha256: hash(JSON.stringify(configuredPlan)), mode: "qualification",
    campaign: { id: "fixture-campaign", directorySha256: "d".repeat(64), authority: authority() },
    journalPath: join(root, `${name}.sqlite`), now: () => "2026-09-25T01:00:00.000Z",
    verifier: { identity: "fixture:independent-verifier", organizationSeparate: true,
      async verify(review) { if (review.status !== "completed") throw new Error("fixture verifier expected completed evidence"); } },
    dependencies: {
      async verifyInstallation() { inspections++; },
      async invoke(c) {
        commands.push(c);
        if (transport) return transport(c);
        if (c.args[0] === "--help") return success(flags);
        if (c.args[0] === "--version") return success("2.1.263 (Claude Code)");
        if (c.args[0] === "auth") return success(JSON.stringify({ loggedIn: true, authMethod: "claude.ai", apiProvider: "firstParty" }));
        return success(envelope());
      },
    }, ...overrides,
  };
  return { options, call: createJournaledNativeReviewer(options), commands, inspections: () => inspections };
}
function inspect<T>(path: string, fn: (journal: OperationJournal) => T): T {
  const journal = new OperationJournal(path, { create: false });
  try { return fn(journal); } finally { journal.close(); }
}
function counts(path: string) {
  return inspect(path, (journal) => ({
    slots: (journal.db.query("SELECT count(*) AS n FROM operations WHERE scope LIKE 'factory.native-review.budget/v1:%'").get() as { n: number }).n,
    dispatches: (journal.db.query("SELECT count(*) AS n FROM effect_states WHERE state = 'dispatch_started'").get() as { n: number }).n,
  }));
}

describe("OperationJournal native review qualification", () => {
  test("shadow has zero database, verifier, CLI and provider effects", async () => {
    const f = fixture("shadow", { mode: "shadow" });
    await expect(f.call(request, binding())).rejects.toThrow("SHADOW_NO_CALL");
    expect(existsSync(f.options.journalPath)).toBe(false);
    expect(f.inspections()).toBe(0); expect(f.commands).toEqual([]);
  });
  test("reserves before any CLI call and retains exact model, dissent and sanitized evidence", async () => {
    let f: ReturnType<typeof fixture>;
    f = fixture("dissent", {}, async (c) => {
      expect(counts(f.options.journalPath)).toEqual({ slots: 1, dispatches: 1 });
      if (c.args[0] === "--help") return success(flags);
      if (c.args[0] === "--version") return success("2.1.263 (Claude Code)");
      if (c.args[0] === "auth") return success('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}');
      expect(c.stdin).not.toContain("lin_api_fixture123");
      return success(envelope("fail", "Missing expiry check. LINEAR_API_KEY=lin_api_fixture123"));
    });
    const result = await f.call({ ...request, input: 'Review evidence. "LINEAR_API_KEY":"lin_api_fixture123"' }, binding());
    expect(result.status).toBe("completed"); expect(result.review!.verdict).toBe("fail");
    expect(result.review!.summary).toContain("Missing expiry"); expect(f.inspections()).toBe(2);
    inspect(f.options.journalPath, (journal) => {
      const receipt = journal.receipt(result.operationId)!;
      expect(receipt.terminal.outcome).toBe("failure");
      const rows = journal.db.query("SELECT canonical_evidence FROM effect_states").all();
      expect(JSON.stringify(rows)).toContain("Missing expiry");
      expect(JSON.stringify(rows)).not.toContain("lin_api_fixture123");
      expect(JSON.stringify(receipt)).not.toContain("lin_api_fixture123");
    });
  });
  test("restart reuses committed result only for identical logical intent and authority", async () => {
    const first = fixture("replay"), original = await first.call(request, binding());
    const second = fixture("replay"), replay = await second.call(request, binding());
    expect(replay.reused).toBe(true); expect(replay.review).toEqual(original.review);
    expect(replay.receiptHash).toBe(original.receiptHash); expect(second.commands).toEqual([]);
    await expect(second.call({ ...request, input: "Changed evidence" }, binding())).rejects.toThrow("BINDING_CONFLICT");
    const different = fixture("replay", { campaign: { ...first.options.campaign, authority: { ...authority(), approvalRef: "fixture:different" } } });
    await expect(different.call(request, binding())).rejects.toThrow("BINDING_CONFLICT");
    expect(different.commands).toEqual([]);
  });
  test("concurrent logical duplicates across connections dispatch only once", async () => {
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = fixture("same-race");
    const original = first.options.dependencies.verifyInstallation;
    const a = createJournaledNativeReviewer({ ...first.options, dependencies: { ...first.options.dependencies,
      async verifyInstallation(p) { await original(p); entered(); await blocked; } } });
    const pending = a(request, binding()); await started;
    const second = fixture("same-race"), held = await second.call(request, binding());
    expect(held.status).toBe("held"); expect(held.reasonCode).toBe("NATIVE_REVIEW_ACTIVE_OR_UNCERTAIN");
    expect(second.commands).toEqual([]); release();
    expect((await pending).status).toBe("completed");
    expect(counts(first.options.journalPath)).toEqual({ slots: 1, dispatches: 1 });
  });
  test("finite campaign slots bound independent racing operations and survive restart", async () => {
    const p = plan(); p.maxCalls = 1;
    let release!: () => void, entered!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const first = fixture("cap-race", { plan: p });
    const a = createJournaledNativeReviewer({ ...first.options, dependencies: { ...first.options.dependencies,
      async verifyInstallation() { entered(); await blocked; } } });
    const pending = a(request, binding("one")); await started;
    const second = fixture("cap-race", { plan: p }), held = await second.call(request, binding("two"));
    expect(held.status).toBe("held"); expect(held.reasonCode).toBe("NATIVE_REVIEW_CALL_CAP");
    expect(second.commands).toEqual([]); release(); await pending;
    const restart = fixture("cap-race", { plan: p });
    expect((await restart.call(request, binding("three"))).reasonCode).toBe("NATIVE_REVIEW_CALL_CAP");
    expect(counts(first.options.journalPath)).toEqual({ slots: 1, dispatches: 1 });
    const enlarged = fixture("cap-race");
    await expect(enlarged.call(request, binding("four"))).rejects.toThrow("BINDING_CONFLICT");
    expect(enlarged.commands).toEqual([]);
  });
  test("provider uncertainty holds, retains consumed budget, and never retries after restart", async () => {
    const f = fixture("uncertain");
    const invoke = f.options.dependencies.invoke;
    const caller = createJournaledNativeReviewer({ ...f.options, dependencies: { ...f.options.dependencies,
      async invoke(c) { if (c.args[0] === "--safe-mode") return { ...success(""), timedOut: true }; return invoke(c); } } });
    const held = await caller(request, binding());
    expect(held.status).toBe("held"); expect(held.review!.failureCode).toBe("NATIVE_REVIEW_TIMEOUT");
    const restart = fixture("uncertain");
    expect((await restart.call(request, binding())).receiptHash).toBe(held.receiptHash);
    expect(restart.commands).toEqual([]); expect(counts(f.options.journalPath)).toEqual({ slots: 1, dispatches: 1 });
  });
  test("known preflight failure consumes its slot without automatic retry or raw exception leakage", async () => {
    const p = plan(); p.maxCalls = 1;
    const f = fixture("preflight", { plan: p });
    let verifierCalls = 0;
    const caller = createJournaledNativeReviewer({ ...f.options, dependencies: { ...f.options.dependencies,
      async verifyInstallation() { verifierCalls++; throw new Error("LINEAR_API_KEY=lin_api_fixture123"); } } });
    const failed = await caller(request, binding());
    expect(failed.status).toBe("failed"); expect(verifierCalls).toBe(1); expect(f.commands).toEqual([]);
    expect(JSON.stringify(failed)).not.toContain("lin_api_fixture123");
    expect((await f.call(request, binding("second"))).reasonCode).toBe("NATIVE_REVIEW_CALL_CAP");
    expect(counts(f.options.journalPath)).toEqual({ slots: 1, dispatches: 1 });
  });
  test("authority expiry and installation drift after auth prevent provider invocation", async () => {
    for (const fault of ["expiry", "installation"] as const) {
      let clock = "2026-09-25T01:00:00.000Z", changed = false;
      const f = fixture(fault, { now: () => clock });
      const invoke = f.options.dependencies.invoke;
      const caller = createJournaledNativeReviewer({ ...f.options, dependencies: { ...f.options.dependencies,
        async verifyInstallation() { if (fault === "installation" && changed) throw new Error("installation drift"); },
        async invoke(c) { const output = await invoke(c); if (c.args[0] === "auth") { changed = true; if (fault === "expiry") clock = "2026-09-25T01:59:45.000Z"; } return output; },
      } });
      const result = await caller(request, binding());
      expect(result.status).toBe("failed");
      expect(f.commands.some((c) => c.args[0] === "--safe-mode")).toBe(false);
    }
  });
  test("captures caller identity and authority before async callbacks", async () => {
    const f = fixture("mutation"), mutableRequest = { ...request }, mutableBinding = binding();
    const original = f.options.dependencies.verifyInstallation;
    const caller = createJournaledNativeReviewer({ ...f.options, dependencies: { ...f.options.dependencies,
      async verifyInstallation(p) { mutableRequest.timeout_ms = 600_000; mutableBinding.sourceRevision = "e".repeat(40);
        f.options.campaign.authority.expiresAt = "2020-01-01T00:00:00.000Z"; await original(p); } } });
    const result = await caller(mutableRequest, mutableBinding);
    expect(result.status).toBe("completed");
    expect(f.commands.at(-1)!.timeoutMs).toBe(30_000);
    const receipt = inspect(f.options.journalPath, (journal) => journal.receipt(result.operationId)!);
    expect(receipt.lineage.inherited_state_refs).toContain(`git:${"c".repeat(40)}`);
  });
  test("independent verifier failure retains committed provider evidence and holds replay", async () => {
    const f = fixture("verification-failure");
    let verifications = 0;
    const caller = createJournaledNativeReviewer({ ...f.options, verifier: { ...f.options.verifier,
      async verify(review) {
        verifications++;
        expect(Object.isFrozen(review)).toBe(true);
        expect(() => { (review as { verdict: string }).verdict = "fail"; }).toThrow();
        throw new Error("LINEAR_API_KEY=lin_api_fixture123");
      } } });
    const held = await caller(request, binding());
    expect(held.status).toBe("held"); expect(held.result).toBe(null); expect(held.receiptHash).toBe(null);
    expect(held.reasonCode).toBe("NATIVE_REVIEW_VERIFICATION_REQUIRED"); expect(verifications).toBe(1);
    inspect(f.options.journalPath, (journal) => {
      expect(journal.receipt(held.operationId)).toBe(null);
      const rows = journal.db.query("SELECT state, canonical_evidence FROM effect_states WHERE state = 'committed'").all();
      expect(rows.length).toBe(1); expect(JSON.stringify(rows)).toContain("Synthetic fixture evidence");
      expect(JSON.stringify(rows)).not.toContain("lin_api_fixture123");
    });
    const restarted = fixture("verification-failure"), replay = await restarted.call(request, binding());
    expect(replay.status).toBe("held"); expect(replay.result).toBe(null); expect(restarted.commands).toEqual([]);
  });
  test("independent verifier identity rejects token-shaped references before opening state", () => {
    const f = fixture("bad-verifier");
    expect(() => createJournaledNativeReviewer({ ...f.options,
      verifier: { ...f.options.verifier, identity: "lin_api_fixture123" } })).toThrow("INDEPENDENT_VERIFIER_REQUIRED");
    expect(existsSync(f.options.journalPath)).toBe(false);
  });
  test("replay checks receipt, artifact, source observation and independent verifier bindings", async () => {
    for (const fault of ["receipt-hash", "artifact-hash", "observation-mismatch", "verifier-identity"] as const) {
      const f = fixture(`tamper-${fault}`), original = await f.call(request, binding());
      inspect(f.options.journalPath, (journal) => {
        const receipt = journal.receipt(original.operationId)!;
        const artifact = receipt.terminal.artifacts[0]!;
        const altered = JSON.parse(artifact.description);
        altered.summary = "A forged passing summary.";
        altered.outputSha256 = hash(JSON.stringify({ verdict: altered.verdict, summary: altered.summary }));
        if (fault === "verifier-identity") receipt.verification.verifier_identity = "fixture:another-verifier";
        else artifact.description = canonicalize(altered);
        if (fault === "observation-mismatch") artifact.hash = hash(artifact.description);
        if (fault !== "receipt-hash") receipt.receipt_hash = computeReceiptHash(receipt);
        // Deliberate isolated fixture corruption; production never drops guards.
        journal.db.exec("DROP TRIGGER receipts_no_update");
        journal.db.query("UPDATE receipts SET canonical_receipt = ?, receipt_hash = ? WHERE operation_id = ?")
          .run(canonicalize(receipt), receipt.receipt_hash, original.operationId);
        journal.db.exec("CREATE TRIGGER receipts_no_update BEFORE UPDATE ON receipts BEGIN SELECT RAISE(ABORT, 'receipts_is_insert_only'); END;");
      });
      const restart = fixture(`tamper-${fault}`);
      await expect(restart.call(request, binding())).rejects.toThrow("NATIVE_REVIEW_");
      expect(restart.commands).toEqual([]);
    }
  });
  test("simultaneous processes share one finite campaign slot and reconcile every child", async () => {
    const p = plan(); p.maxCalls = 1;
    const f = fixture("process-cap-race", { plan: p });
    // Provision the synthetic schema before the race; this tests invocation
    // ownership, not the separate installed-journal provisioning lifecycle.
    new OperationJournal(f.options.journalPath).close();
    const release = join(root, "race.release"), marker = join(root, "race.launches");
    const serialized = { ...f.options, dependencies: undefined, now: undefined };
    const children: Bun.Subprocess<"ignore", "pipe", "pipe">[] = [];
    const readyFiles: string[] = [];
    try {
      for (let index = 0; index < 3; index++) {
        const ready = join(root, `race-${index}.ready`); readyFiles.push(ready);
        const source = `import { appendFileSync, existsSync, writeFileSync } from "node:fs";
          import { createJournaledNativeReviewer } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "native-review-journal.ts")).href)};
          const call = createJournaledNativeReviewer({ ...${JSON.stringify(serialized)}, now: () => "2026-09-25T01:00:00.000Z",
            verifier: { identity: "fixture:independent-verifier", organizationSeparate: true, async verify() {} },
            dependencies: { async verifyInstallation() {}, async invoke(c) {
              const result = (stdout) => ({exitCode:0,signal:null,stdout,stderr:"",timedOut:false,overflow:false});
              if(c.args[0] === "--help") return result(${JSON.stringify(flags)});
              if(c.args[0] === "--version") return result("2.1.263 (Claude Code)");
              if(c.args[0] === "auth") return result('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}');
              appendFileSync(${JSON.stringify(marker)}, "synthetic-call\\n"); await Bun.sleep(100);
              return result(${JSON.stringify(envelope())});
            }} });
          writeFileSync(${JSON.stringify(ready)}, "ready");
          const deadline = Date.now() + 5000;
          while(!existsSync(${JSON.stringify(release)})) { if(Date.now() > deadline) process.exit(92); await Bun.sleep(5); }
          const answer = await call(${JSON.stringify(request)}, ${JSON.stringify(binding(`process-${index}`))});
          process.stdout.write(JSON.stringify({status:answer.status,reasonCode:answer.reasonCode}));`;
        children.push(Bun.spawn([process.execPath, "-e", source], { cwd: import.meta.dir,
          env: { ...process.env, FACTORY_STATE_MODE: "test" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" }));
      }
      const deadline = Date.now() + 5000;
      while (!readyFiles.every((path) => existsSync(path))) {
        if (Date.now() > deadline) throw new Error("fixture process readiness deadline");
        await Bun.sleep(5);
      }
      writeFileSync(release, "release");
      const results = await Promise.all(children.map(async (child) => {
        const [exit, stdout, stderr] = await Promise.all([child.exited,
          new Response(child.stdout).text(), new Response(child.stderr).text()]);
        expect(exit).toBe(0); expect(stderr).toBe("");
        return JSON.parse(stdout) as { status: string; reasonCode: string | null };
      }));
      expect(results.filter((r) => r.status === "completed")).toHaveLength(1);
      expect(results.filter((r) => r.status === "held" && r.reasonCode === "NATIVE_REVIEW_CALL_CAP")).toHaveLength(2);
      expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
      expect(counts(f.options.journalPath)).toEqual({ slots: 1, dispatches: 1 });
    } finally {
      for (const child of children) if (child.exitCode === null) child.kill();
      await Promise.all(children.map((child) => child.exited));
    }
  }, 15_000);
  test("real subprocess crashes do not repeat uncertain effects or lose committed receipt replay", async () => {
    const boundaries = ["logical_reservation", "slot_reservation", "effect_intent", "dispatch_start", "adapter_result", "terminal_event", "receipt_publish", "after_terminal"];
    for (const boundary of boundaries) {
      const f = fixture(`crash-${boundary}`), marker = join(root, `${boundary}.launches`);
      const serialized = { ...f.options, dependencies: undefined, now: undefined };
      const source = `import { appendFileSync } from "node:fs";
        import { createJournaledNativeReviewer } from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "native-review-journal.ts")).href)};
        let reservations = 0;
        const call = createJournaledNativeReviewer({ ...${JSON.stringify(serialized)}, now: () => "2026-09-25T01:00:00.000Z",
          verifier: { identity: "fixture:independent-verifier", organizationSeparate: true, async verify() {} },
          crashInjector(b) { if(b === "reservation") reservations++; if (b === ${JSON.stringify(boundary)} ||
            (${JSON.stringify(boundary)} === "logical_reservation" && b === "reservation" && reservations === 2) ||
            (${JSON.stringify(boundary)} === "slot_reservation" && b === "reservation" && reservations === 3)) process.exit(91); },
          dependencies: { async verifyInstallation() {}, async invoke(c) {
            const result = (stdout) => ({exitCode:0,signal:null,stdout,stderr:"",timedOut:false,overflow:false});
            if(c.args[0] === "--help") return result(${JSON.stringify(flags)});
            if(c.args[0] === "--version") return result("2.1.263 (Claude Code)");
            if(c.args[0] === "auth") return result('{"loggedIn":true,"authMethod":"claude.ai","apiProvider":"firstParty"}');
            appendFileSync(${JSON.stringify(marker)}, "synthetic-call\\n"); return result(${JSON.stringify(envelope())});
          }} }); await call(${JSON.stringify(request)}, ${JSON.stringify(binding())});
          if(${JSON.stringify(boundary)} === "after_terminal") process.exit(91);`;
      const child = Bun.spawn([process.execPath, "-e", source], { cwd: import.meta.dir,
        env: { ...process.env, FACTORY_STATE_MODE: "test" }, stdout: "pipe", stderr: "pipe" });
      const [exit, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect(stderr).toBe(""); expect(exit).toBe(91);
      const providerCalls = existsSync(marker) ? readFileSync(marker, "utf8").trim().split("\n").length : 0;
      expect(providerCalls).toBe(["adapter_result", "terminal_event", "receipt_publish", "after_terminal"].includes(boundary) ? 1 : 0);
      const result = await f.call(request, binding());
      expect(result.status).toBe(boundary === "after_terminal" ? "completed" : "held");
      expect(f.commands).toEqual([]);
      expect(result.reused).toBe(true);
    }
  }, 30_000);
});
