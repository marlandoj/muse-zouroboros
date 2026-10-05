import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, existsSync, linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { FactoryClaimsV2FixtureStore, type ClaimCommand } from "./factory-claims-v2";
import { heldHermesClaimSubject } from "./factory-claim-identity";
import { admitHeldHermesWork } from "./factory-work-contract";
import { ticketClaimKey } from "./ticket-claim";

const roots: string[] = [];
const stores: FactoryClaimsV2FixtureStore[] = [];
const subject = { schema: "factory-claim-subject/v2" as const, provider: "hermes", work_id: `fw_${"a".repeat(64)}` };
const proof = { schema: "factory-reader-admission-proof/v1" as const, opaque_sha256: "b".repeat(64) };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "factory-claims-v2-fixture-"));
  roots.push(root);
  let tick = 10_000;
  const options = { clock: () => tick, verifyProof: (candidate: typeof proof) => candidate.opaque_sha256 === proof.opaque_sha256 };
  const store = new FactoryClaimsV2FixtureStore(root, options);
  stores.push(store);
  return { root, store, options, setTime: (value: number) => { tick = value; } };
}

function command(request_id: string, owner = "worker-a"): ClaimCommand {
  return { subject, owner, admission_proof: proof, request_id, lease_ms: 10_000 };
}

afterEach(() => {
  while (stores.length) { try { stores.pop()!.close(); } catch { /* already closed for crash fixture */ } }
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("fixture-only v2 claims and receipts", () => {
  test("held Hermes work reaches only the isolated fixture claim namespace", async () => {
    const raw = { schema: "factory-work/v1", source: "hermes",
      factory_work_id: "fw_827ce197981d1904313d3b67adb6f60cfb616694938a714e509b0a81d4549a64",
      external_references: { hermes_board: "software-factory", hermes_task_id: "task-1" },
      title: "Task one", description: "Synthetic work", source_status: "ready",
      dispatch_eligible: false };
    const [held] = await admitHeldHermesWork([raw]);
    const claimSubject = heldHermesClaimSubject(held!);
    const { store } = fixture();
    const receipt = store.acquire({ ...command("hermes-bridge"), subject: claimSubject });
    expect(receipt.provider).toBe("hermes");
    expect(receipt.factory_work_id).toBe(raw.factory_work_id);
    expect(receipt.key).toMatch(/^fc2_[0-9a-f]{64}$/);
    expect(receipt.key).not.toBe(ticketClaimKey("task-1"));
    expect(held!.admission).toBe("held_untrusted_snapshot");
    expect(held!.dispatch_eligible).toBe(false);
  });

  test("production mode refuses before creating a claim database", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-claims-v2-fixture-"));
    roots.push(root);
    const prior = process.env.FACTORY_STATE_MODE;
    process.env.FACTORY_STATE_MODE = "production";
    try {
      expect(() => new FactoryClaimsV2FixtureStore(root, {
        verifyProof: () => true,
      })).toThrow("FACTORY_CLAIMS_V2_FIXTURE_ONLY");
      expect(existsSync(join(root, "factory-claims-v2.sqlite"))).toBe(false);
    } finally {
      if (prior === undefined) delete process.env.FACTORY_STATE_MODE;
      else process.env.FACTORY_STATE_MODE = prior;
    }
  });

  test("one winner across independent connections; replay is exact and sequence is monotonic", () => {
    const { root, store: first, options, setTime } = fixture();
    const second = new FactoryClaimsV2FixtureStore(root, options); stores.push(second);
    const acquired = first.acquire(command("request-a"));
    expect(acquired).toMatchObject({ generation: 1, transition_sequence: 1,
      provider: "hermes", factory_work_id: subject.work_id, owner: "worker-a",
      reader_admission_proof: proof });
    setTime(10_001);
    expect(second.acquire(command("request-a", "worker-a"))).toEqual(acquired);
    expect(() => second.acquire(command("request-b", "worker-b"))).toThrow("FACTORY_CLAIM_HELD");
    setTime(12_000);
    const renewed = second.renew({ ...command("request-c", "worker-a"), generation: 1 });
    expect(renewed).toMatchObject({ generation: 1, transition_sequence: 2, lease_expires_ms: 22_000 });
    setTime(12_001);
    expect(() => first.release({ ...command("request-d", "worker-b"), generation: 1 }))
      .toThrow("FACTORY_CLAIM_STALE_LEASE");
    setTime(13_000);
    const released = first.release({ ...command("request-e", "worker-a"), generation: 1 });
    expect(released).toMatchObject({ transition_sequence: 3, lease_expires_ms: 13_000 });
    setTime(13_001);
    expect(first.release({ ...command("request-e", "worker-a"), generation: 1 })).toEqual(released);
    const next = second.acquire(command("request-f", "worker-b"));
    expect(next).toMatchObject({ generation: 2, transition_sequence: 4, owner: "worker-b" });
    setTime(13_002);
    expect(() => first.renew({ ...command("request-g", "worker-a"), generation: 1 }))
      .toThrow("FACTORY_CLAIM_STALE_LEASE");
  });

  test("independent processes obtain exactly one lease", async () => {
    const { root, store } = fixture();
    const moduleUrl = pathToFileURL(join(import.meta.dir, "factory-claims-v2.ts")).href;
    const children = Array.from({ length: 6 }, (_, i) => {
      const script = `import {FactoryClaimsV2FixtureStore} from ${JSON.stringify(moduleUrl)};
        const store = new FactoryClaimsV2FixtureStore(${JSON.stringify(root)},
          {clock:()=>10000, verifyProof:proof=>proof.opaque_sha256===${JSON.stringify(proof.opaque_sha256)}});
        try { const receipt = store.acquire({subject:${JSON.stringify(subject)},
          owner:${JSON.stringify(`worker-${i}`)}, admission_proof:${JSON.stringify(proof)},
          request_id:${JSON.stringify(`race-${i}`)}, lease_ms:10000});
          console.log(JSON.stringify({status:"WIN", receipt})); }
        catch (error) { if(String(error).includes("FACTORY_CLAIM_HELD")) console.log(JSON.stringify({status:"HELD"}));
          else { console.error(error); process.exitCode=2; } }
        finally { store.close(); }`;
      return Bun.spawn([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
    });
    const outcomes = await Promise.all(children.map(async child => {
      const [exit, stdout, stderr] = await Promise.all([child.exited,
        new Response(child.stdout).text(), new Response(child.stderr).text()]);
      const result = stdout.trim() ? JSON.parse(stdout.trim()) as { status: string; receipt?: ReturnType<typeof store.acquire> } : null;
      return { exit, stderr, result };
    }));
    expect(outcomes.map(row => ({ exit: row.exit, stderr: row.stderr })))
      .toEqual(Array.from({ length: 6 }, () => ({ exit: 0, stderr: "" })));
    expect(outcomes.filter(row => row.result?.status === "WIN")).toHaveLength(1);
    expect(outcomes.filter(row => row.result?.status === "HELD")).toHaveLength(5);
    const winner = outcomes.find(row => row.result?.status === "WIN")!.result!.receipt!;
    expect(store.acquire(command(winner.request_id, winner.owner))).toEqual(winner);
  });

  test("expiry and process restart recover with a new generation while old owner stays fenced", () => {
    const { root, store, options, setTime } = fixture();
    store.acquire(command("first"));
    store.close();
    const restarted = new FactoryClaimsV2FixtureStore(root, options); stores.push(restarted);
    setTime(19_999);
    expect(() => restarted.acquire(command("too-early", "worker-b")))
      .toThrow("FACTORY_CLAIM_HELD");
    setTime(20_000);
    const recovered = restarted.acquire(command("recovered", "worker-b"));
    expect(recovered).toMatchObject({ generation: 2, transition_sequence: 2, lease_started_ms: 20_000 });
    setTime(20_001);
    expect(() => restarted.renew({ ...command("old-owner", "worker-a"), generation: 1 }))
      .toThrow("FACTORY_CLAIM_STALE_LEASE");
  });

  test("a torn receipt fails closed and a duplicate request cannot be repurposed", () => {
    const { store, setTime } = fixture();
    store.acquire(command("one"));
    expect(() => store.acquire(command("one", "different-owner"))).toThrow("FACTORY_CLAIM_REPLAY_MISMATCH");
    const db = new Database(store.path);
    db.query("DELETE FROM receipts WHERE request_id=?").run("one");
    db.close();
    setTime(20_000);
    expect(() => store.acquire(command("two", "worker-b"))).toThrow("FACTORY_CLAIM_TORN_HISTORY");
  });

  test("historical payload, request binding, transition, and fingerprint mutations fail closed", () => {
    for (const mutation of ["owner", "transition", "proof", "fingerprint", "request_id", "rebind_request", "sequence"]) {
      const { store, setTime } = fixture();
      store.acquire(command("one"));
      setTime(12_000);
      store.renew({ ...command("two"), generation: 1 });
      const db = new Database(store.path);
      if (mutation === "fingerprint") {
        db.query("UPDATE receipts SET fingerprint=? WHERE request_id=?").run("0".repeat(64), "one");
      } else if (mutation === "request_id") {
        db.query("UPDATE receipts SET request_id=? WHERE request_id=?").run("forged", "one");
      } else if (mutation === "rebind_request") {
        const row = db.query("SELECT payload FROM receipts WHERE request_id=?").get("one") as { payload: string };
        const payload = JSON.parse(row.payload) as Record<string, any>;
        payload.request_id = "forged";
        db.query("UPDATE receipts SET request_id=?, payload=? WHERE request_id=?")
          .run("forged", JSON.stringify(payload), "one");
      } else if (mutation === "sequence") {
        db.query("UPDATE receipts SET sequence=? WHERE request_id=?").run(7, "one");
      } else {
        const row = db.query("SELECT payload FROM receipts WHERE request_id=?").get("one") as { payload: string };
        const payload = JSON.parse(row.payload) as Record<string, any>;
        if (mutation === "owner") payload.owner = "forged-owner";
        if (mutation === "transition") payload.transition = "release";
        if (mutation === "proof") payload.reader_admission_proof.opaque_sha256 = "0".repeat(64);
        db.query("UPDATE receipts SET payload=? WHERE request_id=?").run(JSON.stringify(payload), "one");
      }
      db.close();
      setTime(22_000);
      expect(() => store.acquire(command(`after-${mutation}`, "worker-b"))).toThrow("FACTORY_CLAIM_TORN_HISTORY");
    }
  });

  test("an unwired store denies proofs and ignores caller-supplied clock fields", () => {
    const { root, setTime } = fixture();
    const denied = new FactoryClaimsV2FixtureStore(root); stores.push(denied);
    expect(() => denied.acquire(command("denied"))).toThrow("FACTORY_CLAIM_PROOF_UNVERIFIED");
    const asyncVerifier = new FactoryClaimsV2FixtureStore(root,
      { verifyProof: (() => Promise.resolve(true)) as unknown as () => boolean });
    stores.push(asyncVerifier);
    expect(() => asyncVerifier.acquire(command("async"))).toThrow("FACTORY_CLAIM_PROOF_UNVERIFIED");
    setTime(10_000);
    const { store } = fixture();
    const receipt = store.acquire({ ...command("clock"), now_ms: 9_999_999 } as ClaimCommand);
    expect(receipt.recorded_at_ms).toBe(10_000);
  });

  test("rejects pre-existing fixture DB hardlinks and symlinks", () => {
    const root = mkdtempSync(join(tmpdir(), "factory-claims-v2-fixture-")); roots.push(root);
    const outside = mkdtempSync(join(tmpdir(), "factory-claims-v2-outside-")); roots.push(outside);
    const target = join(outside, "external.sqlite");
    writeFileSync(target, "external sentinel");
    const dbPath = join(root, "factory-claims-v2.sqlite");
    linkSync(target, dbPath);
    expect(() => new FactoryClaimsV2FixtureStore(root)).toThrow("FACTORY_CLAIM_FIXTURE_DB_PATH");
    rmSync(dbPath);
    try {
      symlinkSync(target, dbPath);
      expect(() => new FactoryClaimsV2FixtureStore(root)).toThrow("FACTORY_CLAIM_FIXTURE_DB_PATH");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }
  });

  test("rejects WAL mode without rewriting journal state on open", () => {
    const { root, store } = fixture();
    store.close();
    const db = new Database(join(root, "factory-claims-v2.sqlite"));
    db.exec("PRAGMA journal_mode=WAL");
    db.close();
    expect(() => new FactoryClaimsV2FixtureStore(root)).toThrow("FACTORY_CLAIM_FIXTURE_JOURNAL");
  });

  test("rejects a public fixture root on POSIX", () => {
    // Windows Node stat reports mode 0666 and no getuid(); ACLs need a separate design.
    if (typeof process.getuid !== "function") return;
    const root = mkdtempSync(join(tmpdir(), "factory-claims-v2-fixture-")); roots.push(root);
    chmodSync(root, 0o755);
    expect(() => new FactoryClaimsV2FixtureStore(root)).toThrow("FACTORY_CLAIM_FIXTURE_ROOT_PRIVATE");
    chmodSync(root, 0o700);
  });

  test("rejects self-reported readiness, Linear v2, oversized lease, and nonfixture roots", () => {
    const { store } = fixture();
    expect(() => store.acquire({ ...command("ready"), admission_proof: { ...proof, ready: true } } as ClaimCommand))
      .toThrow("FACTORY_CLAIM_PROOF_SHAPE");
    expect(() => store.acquire({ ...command("linear"), subject: { ...subject, provider: "linear" } }))
      .toThrow("FACTORY_CLAIM_SUBJECT");
    expect(() => store.acquire({ ...command("long"), lease_ms: 3_600_001 })).toThrow("FACTORY_CLAIM_TIME");
    expect(() => new FactoryClaimsV2FixtureStore(tmpdir())).toThrow("FACTORY_CLAIM_FIXTURE_ROOT");
    expect(ticketClaimKey("ZOU-123")).toBe("08559515b4d6b6614d4a793ed3023dcf34f1d3a4f5ec9ac595107078f95facdc");
  });
});
