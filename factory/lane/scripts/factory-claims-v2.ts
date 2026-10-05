/** Fixture-only v2 claim journal. It has no production caller or admission authority. */
import { Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { factoryClaimStorageKeyV2, type FactoryClaimSubjectV2 } from "./factory-claim-identity";

export interface FixtureAdmissionProof {
  schema: "factory-reader-admission-proof/v1";
  opaque_sha256: string;
}

export interface ClaimCommand {
  subject: FactoryClaimSubjectV2;
  owner: string;
  admission_proof: FixtureAdmissionProof;
  request_id: string;
  lease_ms: number;
}

export interface LeaseCommand extends ClaimCommand {
  generation: number;
}

export interface ClaimReceiptV2 {
  schema: "factory-claim-receipt/v2";
  transition: "acquire" | "renew" | "release";
  request_id: string;
  key: string;
  provider: string;
  factory_work_id: string;
  generation: number;
  owner: string;
  reader_admission_proof: FixtureAdmissionProof;
  lease_started_ms: number;
  lease_expires_ms: number;
  requested_lease_ms: number;
  transition_sequence: number;
  recorded_at_ms: number;
}

interface ClaimRow {
  key: string;
  provider: string;
  work_id: string;
  generation: number;
  owner: string;
  proof: string;
  lease_started: number;
  lease_expires: number;
  sequence: number;
  released: number;
  updated_at: number;
}

interface ReceiptRow { request_id: string; fingerprint: string; payload: string }

const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const MIN_LEASE_MS = 1_000;
const MAX_LEASE_MS = 3_600_000;

function requireCommand(input: ClaimCommand): string {
  const key = factoryClaimStorageKeyV2(input.subject);
  if (!IDENTIFIER.test(input.owner) || !IDENTIFIER.test(input.request_id)) throw new Error("FACTORY_CLAIM_IDENTITY");
  const proof = input.admission_proof as unknown as Record<string, unknown>;
  if (!proof || typeof proof !== "object" || Array.isArray(proof)
    || Object.keys(proof).length !== 2 || proof.schema !== "factory-reader-admission-proof/v1"
    || typeof proof.opaque_sha256 !== "string" || !DIGEST.test(proof.opaque_sha256)) {
    throw new Error("FACTORY_CLAIM_PROOF_SHAPE");
  }
  if (!Number.isSafeInteger(input.lease_ms) || input.lease_ms < MIN_LEASE_MS
    || input.lease_ms > MAX_LEASE_MS) {
    throw new Error("FACTORY_CLAIM_TIME");
  }
  return key;
}

function fingerprint(transition: ClaimReceiptV2["transition"], input: ClaimCommand, generation?: number): string {
  const canonical = JSON.stringify([transition, input.request_id, input.subject.provider, input.subject.work_id,
    input.owner, input.admission_proof.opaque_sha256, input.lease_ms, generation ?? null]);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Opens only a synthetic root made with `mkdtemp(...factory-claims-v2-fixture-...)`.
 * Proof verification defaults to deny. Only an explicit fixture verifier can permit
 * transitions; the trusted reader boundary must issue and authenticate real proofs.
 * Injected clocks and verifiers are test seams, not production authority. On POSIX
 * the fixture root must belong to the current UID and have mode 0700. Windows does
 * not expose equivalent owner/mode through Node stat; its ACL and same-UID path-swap
 * threat are outside this fixture. SQLite reopens the path after exclusive creation,
 * so this is not a hostile-local-filesystem or production storage boundary.
 */
export class FactoryClaimsV2FixtureStore {
  readonly path: string;
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly verifyProof: (proof: FixtureAdmissionProof, subject: FactoryClaimSubjectV2) => boolean;

  constructor(fixtureRoot: string, options: {
    clock?: () => number;
    verifyProof?: (proof: FixtureAdmissionProof, subject: FactoryClaimSubjectV2) => boolean;
  } = {}) {
    if (process.env.FACTORY_STATE_MODE !== "test") throw new Error("FACTORY_CLAIMS_V2_FIXTURE_ONLY");
    const root = resolve(fixtureRoot);
    const temp = realpathSync(tmpdir());
    const rel = relative(temp, root);
    if (!rel || isAbsolute(rel) || rel.startsWith("..") || rel.includes(`${sep}..${sep}`)
      || !basename(root).startsWith("factory-claims-v2-fixture-")) throw new Error("FACTORY_CLAIM_FIXTURE_ROOT");
    const rootStat = lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory() || realpathSync(root) !== root)
      throw new Error("FACTORY_CLAIM_FIXTURE_ROOT");
    if (typeof process.getuid === "function"
      && (rootStat.uid !== process.getuid() || (rootStat.mode & 0o777) !== 0o700))
      throw new Error("FACTORY_CLAIM_FIXTURE_ROOT_PRIVATE");
    this.path = join(root, "factory-claims-v2.sqlite");
    this.clock = options.clock ?? Date.now;
    this.verifyProof = options.verifyProof ?? (() => false);
    // SQLite creates and removes its rollback journal during legitimate peer
    // transactions. Inspecting that sidecar here races the engine itself;
    // the private fixture root and DELETE-mode check are the fixture bounds.
    for (const candidate of [this.path]) {
      let stat;
      try { stat = lstatSync(candidate); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || realpathSync(candidate) !== candidate)
        throw new Error("FACTORY_CLAIM_FIXTURE_DB_PATH");
    }
    try { const fd = openSync(this.path, "wx", 0o600); closeSync(fd); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const identity = lstatSync(this.path);
    if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1)
      throw new Error("FACTORY_CLAIM_FIXTURE_DB_PATH");
    this.db = new Database(this.path, { create: true, strict: true });
    const openedPath = this.db.query("PRAGMA database_list").all() as { name: string; file: string }[];
    const after = lstatSync(this.path);
    if (openedPath.find(row => row.name === "main")?.file !== this.path || after.dev !== identity.dev
      || after.ino !== identity.ino || after.nlink !== 1 || after.isSymbolicLink()) {
      this.db.close();
      throw new Error("FACTORY_CLAIM_FIXTURE_DB_PATH");
    }
    // Set the wait policy before any operation that can contend with another
    // fixture process. Reasserting journal_mode=DELETE on every opener takes
    // a write lock and can fail while a peer is claiming the same work.
    this.db.exec("PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON");
    if ((this.db.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode !== "delete") {
      this.db.close();
      throw new Error("FACTORY_CLAIM_FIXTURE_JOURNAL");
    }
    this.db.exec(`CREATE TABLE IF NOT EXISTS claims (
      key TEXT PRIMARY KEY, provider TEXT NOT NULL, work_id TEXT NOT NULL,
      generation INTEGER NOT NULL, owner TEXT NOT NULL, proof TEXT NOT NULL,
      lease_started INTEGER NOT NULL, lease_expires INTEGER NOT NULL,
      sequence INTEGER NOT NULL, released INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS receipts (
      request_id TEXT PRIMARY KEY, claim_key TEXT NOT NULL, sequence INTEGER NOT NULL,
      fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
      UNIQUE(claim_key, sequence), FOREIGN KEY(claim_key) REFERENCES claims(key)
    );`);
  }

  close(): void { this.db.close(); }

  private transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private state(key: string): ClaimRow | null {
    return this.db.query("SELECT * FROM claims WHERE key=?").get(key) as ClaimRow | null;
  }

  private admittedTime(input: ClaimCommand): number {
    if (this.verifyProof(input.admission_proof, input.subject) !== true)
      throw new Error("FACTORY_CLAIM_PROOF_UNVERIFIED");
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(now + input.lease_ms))
      throw new Error("FACTORY_CLAIM_TIME");
    return now;
  }

  private verifyHistory(state: ClaimRow | null): void {
    if (!state) return;
    const rows = this.db.query("SELECT request_id, sequence, fingerprint, payload FROM receipts WHERE claim_key=? ORDER BY sequence").all(state.key) as (ReceiptRow & { sequence: number })[];
    if (rows.length !== state.sequence) throw new Error("FACTORY_CLAIM_TORN_HISTORY");
    let previous: ClaimReceiptV2 | null = null;
    for (let i = 0; i < rows.length; i++) {
      let receipt: ClaimReceiptV2;
      try { receipt = JSON.parse(rows[i]!.payload) as ClaimReceiptV2; }
      catch { throw new Error("FACTORY_CLAIM_TORN_HISTORY"); }
      try {
        if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
          || Object.keys(receipt).length !== 14 || JSON.stringify(receipt) !== rows[i]!.payload
          || receipt.schema !== "factory-claim-receipt/v2"
          || !["acquire", "renew", "release"].includes(receipt.transition)
          || receipt.request_id !== rows[i]!.request_id || !IDENTIFIER.test(receipt.request_id)
          || receipt.key !== state.key || receipt.provider !== state.provider
          || receipt.factory_work_id !== state.work_id
          || factoryClaimStorageKeyV2({ schema: "factory-claim-subject/v2",
            provider: receipt.provider, work_id: receipt.factory_work_id }) !== state.key
          || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1
          || !IDENTIFIER.test(receipt.owner)
          || receipt.reader_admission_proof?.schema !== "factory-reader-admission-proof/v1"
          || !DIGEST.test(receipt.reader_admission_proof.opaque_sha256)
          || Object.keys(receipt.reader_admission_proof).length !== 2
          || !Number.isSafeInteger(receipt.lease_started_ms)
          || !Number.isSafeInteger(receipt.lease_expires_ms)
          || !Number.isSafeInteger(receipt.recorded_at_ms) || receipt.recorded_at_ms < 0
          || !Number.isSafeInteger(receipt.requested_lease_ms)
          || receipt.requested_lease_ms < MIN_LEASE_MS || receipt.requested_lease_ms > MAX_LEASE_MS
          || rows[i]!.sequence !== i + 1 || receipt.transition_sequence !== i + 1) throw new Error();
        const reconstructed: ClaimCommand = { subject: { schema: "factory-claim-subject/v2",
          provider: receipt.provider, work_id: receipt.factory_work_id }, owner: receipt.owner,
          admission_proof: receipt.reader_admission_proof, request_id: receipt.request_id,
          lease_ms: receipt.requested_lease_ms };
        if (fingerprint(receipt.transition, reconstructed,
          receipt.transition === "acquire" ? undefined : receipt.generation) !== rows[i]!.fingerprint) throw new Error();
        if (!previous) {
          if (receipt.transition !== "acquire" || receipt.generation !== 1
            || receipt.lease_started_ms !== receipt.recorded_at_ms
            || receipt.lease_expires_ms !== receipt.recorded_at_ms + receipt.requested_lease_ms) throw new Error();
        } else if (receipt.transition === "acquire") {
          if (receipt.generation !== previous.generation + 1
            || receipt.recorded_at_ms < previous.recorded_at_ms
            || (previous.transition !== "release" && receipt.recorded_at_ms < previous.lease_expires_ms)
            || receipt.lease_started_ms !== receipt.recorded_at_ms
            || receipt.lease_expires_ms !== receipt.recorded_at_ms + receipt.requested_lease_ms) throw new Error();
        } else {
          if (previous.transition === "release" || receipt.generation !== previous.generation
            || receipt.owner !== previous.owner
            || receipt.reader_admission_proof.opaque_sha256 !== previous.reader_admission_proof.opaque_sha256
            || receipt.recorded_at_ms < previous.recorded_at_ms
            || receipt.recorded_at_ms >= previous.lease_expires_ms
            || receipt.lease_started_ms !== previous.lease_started_ms
            || receipt.lease_expires_ms !== (receipt.transition === "renew"
              ? receipt.recorded_at_ms + receipt.requested_lease_ms : receipt.recorded_at_ms)) throw new Error();
        }
      } catch { throw new Error("FACTORY_CLAIM_TORN_HISTORY"); }
      previous = receipt;
    }
    if (!previous || previous.generation !== state.generation || previous.owner !== state.owner
      || previous.reader_admission_proof.opaque_sha256 !== state.proof
      || previous.lease_started_ms !== state.lease_started || previous.lease_expires_ms !== state.lease_expires
      || previous.recorded_at_ms !== state.updated_at || (previous.transition === "release") !== Boolean(state.released))
      throw new Error("FACTORY_CLAIM_TORN_HISTORY");
  }

  private replay(requestId: string, expectedFingerprint: string): ClaimReceiptV2 | null {
    const row = this.db.query("SELECT request_id, fingerprint, payload FROM receipts WHERE request_id=?").get(requestId) as ReceiptRow | null;
    if (!row) return null;
    if (row.fingerprint !== expectedFingerprint) throw new Error("FACTORY_CLAIM_REPLAY_MISMATCH");
    try { return JSON.parse(row.payload) as ClaimReceiptV2; }
    catch { throw new Error("FACTORY_CLAIM_TORN_HISTORY"); }
  }

  private append(transition: ClaimReceiptV2["transition"], input: ClaimCommand, key: string,
    state: ClaimRow, fp: string, now: number): ClaimReceiptV2 {
    const receipt: ClaimReceiptV2 = {
      schema: "factory-claim-receipt/v2", transition, request_id: input.request_id, key,
      provider: input.subject.provider, factory_work_id: input.subject.work_id,
      generation: state.generation, owner: state.owner,
      reader_admission_proof: { schema: "factory-reader-admission-proof/v1", opaque_sha256: state.proof },
      lease_started_ms: state.lease_started, lease_expires_ms: state.lease_expires,
      requested_lease_ms: input.lease_ms,
      transition_sequence: state.sequence, recorded_at_ms: now,
    };
    this.db.query("INSERT INTO receipts(request_id, claim_key, sequence, fingerprint, payload) VALUES (?,?,?,?,?)")
      .run(input.request_id, key, state.sequence, fp, JSON.stringify(receipt));
    return receipt;
  }

  acquire(input: ClaimCommand): ClaimReceiptV2 {
    const key = requireCommand(input), fp = fingerprint("acquire", input);
    const now = this.admittedTime(input);
    return this.transaction(() => {
      const before = this.state(key); this.verifyHistory(before);
      const replay = this.replay(input.request_id, fp); if (replay) return replay;
      if (before && !before.released && before.lease_expires > now) throw new Error("FACTORY_CLAIM_HELD");
      if (before && now < before.updated_at) throw new Error("FACTORY_CLAIM_CLOCK_ROLLBACK");
      const next: ClaimRow = { key, provider: input.subject.provider, work_id: input.subject.work_id,
        generation: (before?.generation ?? 0) + 1, owner: input.owner,
        proof: input.admission_proof.opaque_sha256, lease_started: now,
        lease_expires: now + input.lease_ms, sequence: (before?.sequence ?? 0) + 1,
        released: 0, updated_at: now };
      if (before) {
        const changed = this.db.query(`UPDATE claims SET generation=?, owner=?, proof=?, lease_started=?,
          lease_expires=?, sequence=?, released=0, updated_at=? WHERE key=? AND sequence=?`)
          .run(next.generation, next.owner, next.proof, next.lease_started, next.lease_expires,
            next.sequence, next.updated_at, key, before.sequence).changes;
        if (changed !== 1) throw new Error("FACTORY_CLAIM_CAS");
      } else {
        this.db.query("INSERT INTO claims VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
          key, next.provider, next.work_id, next.generation, next.owner, next.proof,
          next.lease_started, next.lease_expires, next.sequence, next.released, next.updated_at);
      }
      return this.append("acquire", input, key, next, fp, now);
    });
  }

  renew(input: LeaseCommand): ClaimReceiptV2 { return this.advance("renew", input); }
  release(input: LeaseCommand): ClaimReceiptV2 { return this.advance("release", input); }

  private advance(transition: "renew" | "release", input: LeaseCommand): ClaimReceiptV2 {
    const key = requireCommand(input);
    if (!Number.isSafeInteger(input.generation) || input.generation < 1) throw new Error("FACTORY_CLAIM_GENERATION");
    const fp = fingerprint(transition, input, input.generation);
    const now = this.admittedTime(input);
    return this.transaction(() => {
      const before = this.state(key); this.verifyHistory(before);
      const replay = this.replay(input.request_id, fp); if (replay) return replay;
      if (!before || before.generation !== input.generation || before.released
        || now >= before.lease_expires || now < before.updated_at
        || before.owner !== input.owner || before.proof !== input.admission_proof.opaque_sha256)
        throw new Error("FACTORY_CLAIM_STALE_LEASE");
      const next = { ...before, sequence: before.sequence + 1, updated_at: now,
        lease_expires: transition === "renew" ? now + input.lease_ms : now,
        released: transition === "release" ? 1 : 0 };
      const changed = this.db.query(`UPDATE claims SET sequence=?, updated_at=?, lease_expires=?, released=?
        WHERE key=? AND generation=? AND sequence=? AND owner=? AND proof=? AND released=0 AND lease_expires>?`)
        .run(next.sequence, next.updated_at, next.lease_expires, next.released,
          key, before.generation, before.sequence, before.owner, before.proof, now).changes;
      if (changed !== 1) throw new Error("FACTORY_CLAIM_CAS");
      return this.append(transition, input, key, next, fp, now);
    });
  }
}
