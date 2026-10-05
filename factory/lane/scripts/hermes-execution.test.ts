import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { OperationJournal } from "./run-operation-journal";
import { canonicalize } from "./run-receipt-contract";
import { factoryClaimStorageKeyV2 } from "./factory-claim-identity";
import { runHermesExecutionFixture, type ExecutionPacket } from "./hermes-execution";

const hash = (s: string) => createHash("sha256").update(s).digest("hex");
let root: string;
const oldMode = process.env.FACTORY_STATE_MODE, oldRoot = process.env.FACTORY_STATE_DIR;
beforeAll(() => { const base = resolve(import.meta.dir, "../state"); mkdirSync(base, { recursive: true });
  root = mkdtempSync(join(base, "hermes-execution-test-")); process.env.FACTORY_STATE_MODE = "test"; delete process.env.FACTORY_STATE_DIR; });
afterAll(() => { rmSync(root, { recursive: true, force: true });
  if (oldMode === undefined) delete process.env.FACTORY_STATE_MODE; else process.env.FACTORY_STATE_MODE = oldMode;
  if (oldRoot === undefined) delete process.env.FACTORY_STATE_DIR; else process.env.FACTORY_STATE_DIR = oldRoot; });
const NOW = Date.parse("2026-09-25T20:00:00Z");
function setup(name: string) {
  const path = join(root, name + ".sqlite"), journal = new OperationJournal(path); journal.close();
  const st = statSync(path), workId = "fw_" + hash("hermes\0software-factory\0task-one");
  const work = { schema: "factory-work/v1", factory_work_id: workId, source: "hermes",
    external_references: { hermes_board: "software-factory", hermes_task_id: "task-one" },
    title: "One Ω task", description: "exact body\nλ", source_status: "ready", dispatch_eligible: false };
  const receipt = { schema: "factory-claim-receipt/v2", transition: "acquire", request_id: "request-one",
    key: factoryClaimStorageKeyV2({ schema: "factory-claim-subject/v2", provider: "hermes", work_id: workId }),
    provider: "hermes", factory_work_id: workId, generation: 1, owner: "factory",
    reader_admission_proof: { schema: "factory-reader-admission-proof/v1", opaque_sha256: "b".repeat(64) },
    lease_started_ms: NOW, lease_expires_ms: NOW + 60_000, requested_lease_ms: 60_000, transition_sequence: 1, recorded_at_ms: NOW };
  const packet: ExecutionPacket = { schema: "hermes-contained-execution/v1", plan_sha256: "a".repeat(64), source_head: "c".repeat(40),
    execution_id: "exec-one", journal_path: path, journal_identity: [st.dev, st.ino], worker_uid: 1001, worker_gid: 1001,
    workdir: root, harness: "codex", model: "gpt-6-astra", timeout_ms: 1000, approved_at_ms: NOW - 1000, expires_at_ms: NOW + 60_000,
    claim: { receipt, retained_work: { schema: "held-claim-selected-work/v1", work, work_sha256: hash(canonicalize(work)),
      authority_artifact_sha256: "d".repeat(64), reader_proof_sha256: "b".repeat(64), claim_receipt_sha256: hash(canonicalize(receipt)),
      snapshot_sha256: "e".repeat(64), receipt_sha256: "f".repeat(64), board_identity_sha256: "1".repeat(64),
      high_water_sha256: "2".repeat(64), claim_eligible: false, dispatch_eligible: false } } };
  return packet;
}
const okay = async (id: string) => ({ executorId: id, success: true, output: "synthetic result", durationMs: 1 });
const healthy = async () => ({ healthy: true, message: "synthetic" });
function rows(packet: ExecutionPacket) { const journal = new OperationJournal(packet.journal_path, { create: false });
  try { return { operations: (journal.db.query("SELECT COUNT(*) n FROM operations").get() as { n: number }).n,
    dispatches: (journal.db.query("SELECT COUNT(*) n FROM effect_states WHERE state='dispatch_started'").get() as { n: number }).n }; }
  finally { journal.close(); } }

test("retained content → one journal reservation → runner → exact pending-review recovery", async () => {
  const p = setup("success"), fences: string[] = []; let calls = 0;
  const deps = { now: () => NOW, healthProbe: healthy, fence: (s: string) => fences.push(s),
    harnessRun: async (...args: Parameters<typeof okay>) => { calls++; return okay(...args); } };
  const first = await runHermesExecutionFixture(p, deps);
  expect(first.status).toBe("held"); expect(fences).toEqual(["reserve", "launch"]); expect(calls).toBe(1);
  const replay = await runHermesExecutionFixture(p, { ...deps, now: () => NOW + 70_000 });
  expect(replay).toEqual({ ...first, replay: true }); expect(calls).toBe(1); expect(rows(p)).toEqual({ operations: 1, dispatches: 1 });
});
test("uncertain executor effect and observer loss cannot launch a replacement", async () => {
  const p = setup("uncertain"); let calls = 0;
  const deps = { now: () => NOW, healthProbe: healthy, fence() {}, harnessRun: async () => { calls++; throw new Error("sensitive failure"); } };
  expect((await runHermesExecutionFixture(p, deps)).status).toBe("held");
  expect((await runHermesExecutionFixture(p, deps)).replay).toBe(true); expect(calls).toBe(1);
});
for (const cut of ["reservation", "effect_intent", "dispatch_start", "adapter_result", "receipt_publish"] as const) {
  test(`crash at ${cut} recovers same pending operation without retry`, async () => {
    const p = setup(cut); let calls = 0;
    const deps = { now: () => NOW, healthProbe: healthy, fence() {}, harnessRun: async (id: string) => { calls++; if (cut === "receipt_publish") throw new Error("uncertain"); return okay(id); } };
    await expect(runHermesExecutionFixture(p, { ...deps, crashInjector(stage) { if (stage === cut) throw new Error("cut"); } })).rejects.toThrow("cut");
    const launched = calls, recovered = await runHermesExecutionFixture(p, deps);
    expect(recovered.replay).toBe(true); expect(recovered.status).toBe("held"); expect(calls).toBe(launched);
    expect(rows(p).operations).toBe(1);
  });
}
test("fresh root fence rejection after durable dispatch reservation has zero harness calls", async () => {
  const p = setup("revoked"); let calls = 0;
  const result = await runHermesExecutionFixture(p, { now: () => NOW, healthProbe: healthy,
    fence(stage) { if (stage === "launch") throw new Error("revoked"); }, harnessRun: async id => { calls++; return okay(id); } });
  expect(result.status).toBe("held"); expect(calls).toBe(0); expect(rows(p).dispatches).toBe(1);
});
test("expiry during final supervisor check blocks launch", async () => {
  const p = setup("expires"); let tick = NOW, calls = 0;
  const result = await runHermesExecutionFixture(p, { now: () => tick, healthProbe: healthy,
    fence(stage) { if (stage === "launch") tick = p.expires_at_ms; }, harnessRun: async id => { calls++; return okay(id); } });
  expect(result.status).toBe("held"); expect(calls).toBe(0);
});
test("content changed after authenticated projection fails before journal reservation", async () => {
  const p = setup("content"); (p.claim.retained_work.work as { description: string }).description = "injected";
  await expect(runHermesExecutionFixture(p, { fence() { throw new Error("must not reach"); }, now: () => NOW })).rejects.toThrow("HELD");
  expect(rows(p).operations).toBe(0);
});
test("different work or execution cannot consume the one permanent slot", async () => {
  const p = setup("collision"), deps = { now: () => NOW, healthProbe: healthy, fence() {}, harnessRun: okay };
  await runHermesExecutionFixture(p, deps); p.execution_id = "exec-replacement";
  await expect(runHermesExecutionFixture(p, deps)).rejects.toThrow("HELD"); expect(rows(p).dispatches).toBe(1);
});
test("three concurrent processes reserve one permanent slot and launch once", async () => {
  const p = setup("process-race"), worker = join(root, "race-worker.ts"), start = join(root, "race-start"), launches = join(root, "race-launches");
  writeFileSync(worker, `import {existsSync,writeFileSync,appendFileSync} from 'node:fs';
    import {runHermesExecutionFixture} from ${JSON.stringify(join(import.meta.dir, "hermes-execution.ts"))};
    const ready=process.argv[2];writeFileSync(ready,'ready');
    while(!existsSync(${JSON.stringify(start)}))await new Promise(r=>setTimeout(r,5));
    const r=await runHermesExecutionFixture(${JSON.stringify(p)},{now:()=>${NOW},fence(){},
      healthProbe:async()=>({healthy:true,message:'synthetic'}),harnessRun:async id=>{
        appendFileSync(${JSON.stringify(launches)},'launch\\n');
        return {executorId:id,success:true,output:'synthetic',durationMs:1};}});
    console.log(JSON.stringify(r));`);
  const children: ReturnType<typeof Bun.spawn>[] = [];
  try {
    for (let n = 0; n < 3; n++) children.push(Bun.spawn([process.execPath, worker, join(root, `ready-${n}`)],
      { env: { ...process.env, FACTORY_STATE_MODE: "test" }, stdout: "pipe", stderr: "pipe" }));
    const deadline = Date.now() + 10_000;
    while (![0, 1, 2].every(n => existsSync(join(root, `ready-${n}`)))) {
      if (Date.now() >= deadline) throw new Error("fixture process startup deadline");
      await Bun.sleep(10);
    }
    writeFileSync(start, "go");
    const exitCodes = await Promise.all(children.map(child => child.exited));
    const errors = await Promise.all(children.map(child => {
      if (!(child.stderr instanceof ReadableStream)) throw new Error("fixture stderr pipe missing");
      return new Response(child.stderr).text();
    }));
    expect(errors).toEqual(["", "", ""]);
    expect(exitCodes).toEqual([0, 0, 0]); expect(readFileSync(launches, "utf8")).toBe("launch\n");
    expect(rows(p)).toEqual({ operations: 1, dispatches: 1 });
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill(); await child.exited; }
  }
});
