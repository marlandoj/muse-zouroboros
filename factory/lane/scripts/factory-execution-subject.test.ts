import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { FactoryClaimsV2FixtureStore } from "./factory-claims-v2";
import { heldHermesClaimSubject } from "./factory-claim-identity";
import { admitHeldHermesWork } from "./factory-work-contract";
import { fixtureHermesDispatch, validateFixtureHermesDispatch } from "./factory-execution-subject";
import { HermesExecutionFixture } from "./hermes-execution-fixture";

const roots: string[] = [];
const handles: { close(): void }[] = [];
let priorMode: string | undefined;
beforeEach(() => { priorMode = process.env.FACTORY_STATE_MODE; process.env.FACTORY_STATE_MODE = "test"; });
afterEach(() => {
  while (handles.length) { try { handles.pop()!.close(); } catch { /* restarted fixture */ } }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
  if (priorMode === undefined) delete process.env.FACTORY_STATE_MODE;
  else process.env.FACTORY_STATE_MODE = priorMode;
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-claims-v2-fixture-")); roots.push(root);
  let tick = 10_000, admitted = true;
  const [work] = await admitHeldHermesWork([{
    schema: "factory-work/v1", source: "hermes",
    factory_work_id: "fw_827ce197981d1904313d3b67adb6f60cfb616694938a714e509b0a81d4549a64",
    external_references: { hermes_board: "software-factory", hermes_task_id: "task-1" },
    title: "Contained task", description: "Synthetic executor only", source_status: "ready", dispatch_eligible: false,
  }]);
  const store = new FactoryClaimsV2FixtureStore(root, { clock: () => tick, verifyProof: () => admitted }); handles.push(store);
  const command = { subject: heldHermesClaimSubject(work!), owner: "fixture-worker",
    admission_proof: { schema: "factory-reader-admission-proof/v1" as const, opaque_sha256: "a".repeat(64) },
    request_id: "fixture-acquire", lease_ms: 10_000 };
  const receipt = store.acquire(command);
  const envelope = fixtureHermesDispatch(work!, receipt, "exec-contained-1");
  const options = { clock: () => tick,
    verifyAuthority: (candidate: typeof envelope) => admitted && JSON.stringify(candidate.claim_receipt) === JSON.stringify(receipt) };
  const caller = new HermesExecutionFixture(root, options); handles.push(caller);
  return { root, caller, options, store, work: work!, receipt, envelope, command,
    setTime: (value: number) => { tick = value; }, revoke: () => { admitted = false; } };
}

describe("connected Hermes execution identity and recovery fixture", () => {
  test("v2 claim identity survives envelope, execution, terminal evidence and reopened recovery", async () => {
    const f = await fixture();
    let launches = 0;
    const result = await f.caller.run(f.envelope, async subject => {
      launches++;
      expect(subject).toEqual(f.envelope.subject);
      return { result_sha256: "b".repeat(64) };
    });
    expect(result.subject).toMatchObject({ provider: "hermes", factory_work_id: f.work.factory_work_id,
      claim_generation: f.receipt.generation, reader_proof_sha256: f.receipt.reader_admission_proof.opaque_sha256,
      execution_id: "exec-contained-1" });
    expect(result.lifecycle).toMatchObject({ state: "implementation_complete", target_reached: true });
    expect(result.lifecycle.evidence.implementation_complete?.[0]?.reference).toBe("b".repeat(64));
    expect(result.dispatch_eligible).toBe(false);
    expect(result.envelope.work.dispatch_eligible).toBe(false);
    f.caller.close();
    const restarted = new HermesExecutionFixture(f.root, f.options); handles.push(restarted);
    expect(restarted.recover(f.envelope.subject)).toEqual(result);
    expect(await restarted.run(f.envelope, async () => { launches++; return { result_sha256: "c".repeat(64) }; })).toEqual(result);
    expect(launches).toBe(1);
    expect(existsSync(join(f.root, "ticket-claims"))).toBe(false);
    expect(readdirSync(f.root).sort()).toEqual(["factory-claims-v2.sqlite", "factory-execution-fixture.sqlite"]);
  });

  test("held proof, expired lease and revoked proof prevent an execution reservation", async () => {
    for (const denial of ["held", "expired", "revoked"] as const) {
      const f = await fixture();
      const caller = denial === "held" ? new HermesExecutionFixture(f.root, { clock: () => 10_000 }) : f.caller;
      if (caller !== f.caller) handles.push(caller);
      if (denial === "expired") f.setTime(20_000);
      if (denial === "revoked") f.revoke();
      let calls = 0;
      await expect(caller.run(f.envelope, async () => { calls++; return { result_sha256: "b".repeat(64) }; }))
        .rejects.toThrow(denial === "expired" ? "FACTORY_EXECUTION_LEASE_EXPIRED" : "FACTORY_EXECUTION_AUTHORITY_HELD");
      expect(calls).toBe(0);
      expect(caller.recover(f.envelope.subject)).toBeNull();
    }
  });

  test("production mode refuses before creating execution storage even with a permissive verifier", async () => {
    const f = await fixture();
    f.caller.close();
    const root = mkdtempSync(join(tmpdir(), "factory-claims-v2-fixture-")); roots.push(root);
    process.env.FACTORY_STATE_MODE = "production";
    expect(() => new HermesExecutionFixture(root, { verifyAuthority: () => true }))
      .toThrow("FACTORY_EXECUTION_FIXTURE_ONLY");
    expect(readdirSync(root)).toEqual([]);
  });

  test("forged work, claim generation, proof or execution ID cannot cross the envelope boundary", async () => {
    const f = await fixture();
    for (const mutate of [
      (value: typeof f.envelope) => { value.subject.claim_generation++; },
      (value: typeof f.envelope) => { value.subject.reader_proof_sha256 = "c".repeat(64); },
      (value: typeof f.envelope) => { value.subject.factory_work_id = `fw_${"c".repeat(64)}`; },
      (value: typeof f.envelope) => { value.work.description = "Different input"; },
      (value: typeof f.envelope) => { value.subject.execution_id = "../../legacy"; },
    ]) {
      const candidate = structuredClone(f.envelope); mutate(candidate);
      expect(() => validateFixtureHermesDispatch(candidate)).toThrow();
    }
    expect(() => fixtureHermesDispatch(f.work, { ...f.receipt, provider: "linear" }, "exec-contained-1")).toThrow();
    for (const malformed of [
      { ...f.receipt, owner: 123 },
      { ...f.receipt, request_id: 456 },
      { ...f.receipt, reader_admission_proof: { ...f.receipt.reader_admission_proof,
        opaque_sha256: { toString: () => "a".repeat(64) } } },
    ]) {
      expect(() => fixtureHermesDispatch(f.work, malformed as typeof f.receipt, "exec-contained-1"))
        .toThrow("FACTORY_EXECUTION_CLAIM_BINDING");
    }
    expect(() => fixtureHermesDispatch({ ...f.work, source_status: "triage" }, f.receipt, "exec-contained-1")).toThrow("FACTORY_EXECUTION_NOT_READY");
    const changedClaim = fixtureHermesDispatch(f.work, { ...f.receipt, generation: 2 }, "exec-contained-1");
    await expect(f.caller.run(changedClaim, async () => ({ result_sha256: "b".repeat(64) })))
      .rejects.toThrow("FACTORY_EXECUTION_AUTHORITY_HELD");
  });

  test("effect failure stays held across restart and a new execution ID cannot launch it again", async () => {
    const f = await fixture(); let calls = 0;
    const uncertain = await f.caller.run(f.envelope, async () => { calls++; throw new Error("connection lost after effect"); });
    expect(uncertain).toMatchObject({ effect_state: "uncertain", lifecycle: { state: "held" }, subject: f.envelope.subject });
    f.caller.close();
    const restarted = new HermesExecutionFixture(f.root, f.options); handles.push(restarted);
    expect(restarted.recover(f.envelope.subject)).toEqual(uncertain);
    expect(await restarted.run(f.envelope, async () => { calls++; return { result_sha256: "b".repeat(64) }; })).toEqual(uncertain);
    const differentExecution = fixtureHermesDispatch(f.work, f.receipt, "exec-contained-2");
    await expect(restarted.run(differentExecution, async () => { calls++; return { result_sha256: "b".repeat(64) }; }))
      .rejects.toThrow("FACTORY_EXECUTION_RECORD_BINDING");
    expect(calls).toBe(1);
  });

  test("process exit after the injected effect leaves a recoverable hold without a duplicate launch", async () => {
    const f = await fixture(); f.caller.close();
    const effectPath = join(f.root, "effect-count.txt");
    const script = `import {writeFileSync} from 'node:fs';
      import {HermesExecutionFixture} from ${JSON.stringify(pathToFileURL(join(import.meta.dir, "hermes-execution-fixture.ts")).href)};
      const engine=new HermesExecutionFixture(${JSON.stringify(f.root)}, {clock:()=>10000,verifyAuthority:()=>true});
      await engine.run(${JSON.stringify(f.envelope)},async()=>{writeFileSync(${JSON.stringify(effectPath)},'one');process.exit(0)});`;
    const child = Bun.spawn([process.execPath, "-e", script], { env: { ...process.env, FACTORY_STATE_MODE: "test" }, stdout: "pipe", stderr: "pipe" });
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect({ code, error }).toEqual({ code: 0, error: "" });
    expect(existsSync(effectPath)).toBe(true);
    const restarted = new HermesExecutionFixture(f.root, f.options); handles.push(restarted);
    const recovered = restarted.recover(f.envelope.subject);
    expect(recovered).toMatchObject({ subject: f.envelope.subject, effect_state: "uncertain", lifecycle: { state: "held" } });
    let duplicate = false;
    await restarted.run(f.envelope, async () => { duplicate = true; return { result_sha256: "b".repeat(64) }; });
    expect(duplicate).toBe(false);
  });

  test("revocation while an effect is running prevents a success receipt and retains the subject", async () => {
    const f = await fixture();
    const result = await f.caller.run(f.envelope, async () => { f.revoke(); return { result_sha256: "b".repeat(64) }; });
    expect(result).toMatchObject({ subject: f.envelope.subject, effect_state: "uncertain", result_sha256: null,
      lifecycle: { state: "held", target_reached: false } });
  });

  test("expiry or clock rollback during the final admission verifier cannot launch an effect", async () => {
    for (const tick of [20_000, 9_999]) {
      const f = await fixture(); let checks = 0, calls = 0;
      const caller = new HermesExecutionFixture(f.root, {
        clock: f.options.clock,
        verifyAuthority: () => { if (++checks === 2) f.setTime(tick); return true; },
      }); handles.push(caller);
      const result = await caller.run(f.envelope, async () => { calls++; return { result_sha256: "b".repeat(64) }; });
      expect(result).toMatchObject({ effect_state: "uncertain", lifecycle: { state: "held" } });
      expect(calls).toBe(0);
      expect(result.lifecycle.state_updated_at >= new Date(10_000).toISOString()).toBe(true);
      expect(caller.recover(f.envelope.subject)).toEqual(result);
    }
  });

  test("settlement retains the validated result snapshot when its verifier mutates the executor object", async () => {
    const f = await fixture(); let checks = 0;
    const response = { result_sha256: "b".repeat(64) };
    const caller = new HermesExecutionFixture(f.root, {
      clock: f.options.clock,
      verifyAuthority: () => { if (++checks === 3) response.result_sha256 = "invalid"; return true; },
    }); handles.push(caller);
    const result = await caller.run(f.envelope, async () => response);
    expect(response.result_sha256).toBe("invalid");
    expect(result).toMatchObject({ effect_state: "settled", result_sha256: "b".repeat(64) });
    expect(result.lifecycle.evidence.implementation_complete?.[0]?.reference).toBe("b".repeat(64));
    expect(caller.recover(f.envelope.subject)).toEqual(result);
  });

  test("a coercible digest object cannot become terminal evidence", async () => {
    const f = await fixture();
    const result = await f.caller.run(f.envelope, async () => ({
      result_sha256: { toString: () => "b".repeat(64) } as unknown as string,
    }));
    expect(result).toMatchObject({ effect_state: "uncertain", result_sha256: null, lifecycle: { state: "held" } });
  });

  test("lease expiry during settlement verification holds the completed effect", async () => {
    const f = await fixture(); let checks = 0, calls = 0;
    const caller = new HermesExecutionFixture(f.root, {
      clock: f.options.clock,
      verifyAuthority: () => { if (++checks === 3) f.setTime(20_000); return true; },
    }); handles.push(caller);
    const result = await caller.run(f.envelope, async () => { calls++; return { result_sha256: "b".repeat(64) }; });
    expect(calls).toBe(1);
    expect(result).toMatchObject({ effect_state: "uncertain", result_sha256: null, lifecycle: { state: "held" } });
  });

  test("two connected callers sharing storage invoke the effect at most once", async () => {
    const f = await fixture(); const other = new HermesExecutionFixture(f.root, f.options); handles.push(other);
    let calls = 0, release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const first = f.caller.run(f.envelope, async () => { calls++; await pending; return { result_sha256: "b".repeat(64) }; });
    const second = await other.run(f.envelope, async () => { calls++; return { result_sha256: "c".repeat(64) }; });
    release();
    expect((await first).effect_state).toBe("uncertain");
    expect(second.effect_state).toBe("uncertain");
    expect(calls).toBe(1);
  });

  test("recovery refuses a persisted success whose lifecycle evidence was lost", async () => {
    const f = await fixture();
    const result = await f.caller.run(f.envelope, async () => ({ result_sha256: "b".repeat(64) }));
    result.lifecycle.evidence = {};
    const damaged = new Database(f.caller.path);
    try { damaged.query("UPDATE executions SET record=? WHERE work_key=?").run(JSON.stringify(result), result.subject.claim_key); }
    finally { damaged.close(); }
    expect(() => f.caller.recover(f.envelope.subject)).toThrow("FACTORY_EXECUTION_RECORD_BINDING");
    let calls = 0;
    await expect(f.caller.run(f.envelope, async () => { calls++; return { result_sha256: "b".repeat(64) }; }))
      .rejects.toThrow("FACTORY_EXECUTION_RECORD_BINDING");
    expect(calls).toBe(0);
  });
});
