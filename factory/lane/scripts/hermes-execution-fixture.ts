/** Connected synthetic execution/recovery caller. No production or model adapter.
 * Uses existing v2 claim receipts and execution lifecycle; one persisted record
 * reserves each work identity before the injected effect can run. Unknown effects
 * remain held on restart. This does NOT supply the separate issuer/claim fence.
 */
import { Database } from "bun:sqlite";
import { closeSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { createExecutionLifecycle, normalizeExecutionLifecycle, transitionExecutionLifecycle, type ExecutionLifecycle } from "./execution-lifecycle";
import { validateFixtureHermesDispatch, type FactoryExecutionSubject, type FixtureHermesDispatch } from "./factory-execution-subject";

export interface FixtureExecutionRecord {
  schema: "factory-hermes-execution-fixture/v1";
  scope: "synthetic_only";
  dispatch_eligible: false;
  subject: FactoryExecutionSubject;
  envelope: FixtureHermesDispatch;
  effect_state: "started" | "settled" | "uncertain";
  lifecycle: ExecutionLifecycle;
  result_sha256: string | null;
}

interface Stored { work_key: string; execution_id: string; envelope: string; record: string }
const RECORD_KEYS = ["schema", "scope", "dispatch_eligible", "subject", "envelope", "effect_state",
  "lifecycle", "result_sha256"];
export interface FixtureExecutionOptions {
  clock?: () => number;
  /** Fixture-supplied current claim/proof authority. Defaults to refusal. */
  verifyAuthority?: (envelope: FixtureHermesDispatch) => boolean;
}

export class HermesExecutionFixture {
  readonly path: string;
  private readonly db: Database;
  private readonly clock: () => number;
  private readonly verifyAuthority: NonNullable<FixtureExecutionOptions["verifyAuthority"]>;

  constructor(root: string, options: FixtureExecutionOptions = {}) {
    if (process.env.FACTORY_STATE_MODE !== "test") throw new Error("FACTORY_EXECUTION_FIXTURE_ONLY");
    const canonical = resolve(root), rel = relative(realpathSync(tmpdir()), canonical);
    if (!rel || isAbsolute(rel) || rel.startsWith("..")
      || !basename(canonical).startsWith("factory-claims-v2-fixture-")) throw new Error("FACTORY_EXECUTION_FIXTURE_ROOT");
    const stat = lstatSync(canonical);
    if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(canonical) !== canonical
      || (typeof process.getuid === "function" && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o700))) {
      throw new Error("FACTORY_EXECUTION_FIXTURE_ROOT");
    }
    this.path = join(canonical, "factory-execution-fixture.sqlite");
    try { closeSync(openSync(this.path, "wx", 0o600)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    const file = lstatSync(this.path);
    if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1
      || (typeof process.getuid === "function" && (file.uid !== process.getuid() || (file.mode & 0o777) !== 0o600))) {
      throw new Error("FACTORY_EXECUTION_FIXTURE_FILE");
    }
    this.clock = options.clock ?? Date.now;
    this.verifyAuthority = options.verifyAuthority ?? (() => false);
    this.db = new Database(this.path, { strict: true });
    this.db.exec("PRAGMA busy_timeout=2000; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;");
    this.db.exec(`CREATE TABLE IF NOT EXISTS executions (
      work_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL UNIQUE,
      envelope TEXT NOT NULL, record TEXT NOT NULL)`);
  }

  close(): void { this.db.close(); }

  private now(): number {
    const now = this.clock();
    if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(new Date(now).getTime())) {
      throw new Error("FACTORY_EXECUTION_TIME");
    }
    return now;
  }

  private assertLeaseWindow(envelope: FixtureHermesDispatch, minimumTime: number): number {
    const now = this.now();
    if (now < minimumTime) throw new Error("FACTORY_EXECUTION_CLOCK_ROLLBACK");
    if (now < envelope.claim_receipt.recorded_at_ms || now >= envelope.claim_receipt.lease_expires_ms) {
      throw new Error("FACTORY_EXECUTION_LEASE_EXPIRED");
    }
    return now;
  }

  private assertAdmission(envelope: FixtureHermesDispatch, minimumTime = envelope.claim_receipt.recorded_at_ms): number {
    const before = this.assertLeaseWindow(envelope, minimumTime);
    // Callback gets a disposable copy; it cannot rewrite the bound envelope.
    if (this.verifyAuthority(JSON.parse(JSON.stringify(envelope))) !== true) {
      throw new Error("FACTORY_EXECUTION_AUTHORITY_HELD");
    }
    // Verification can take time or call injected code. Bound the whole check,
    // including clock rollback, before the caller launches or settles an effect.
    return this.assertLeaseWindow(envelope, before);
  }

  private read(subject: FactoryExecutionSubject): FixtureExecutionRecord | null {
    const row = this.db.query("SELECT * FROM executions WHERE work_key=? OR execution_id=?")
      .get(subject.claim_key, subject.execution_id) as Stored | null;
    if (!row) return null;
    const record = JSON.parse(row.record) as FixtureExecutionRecord;
    const envelope = validateFixtureHermesDispatch(record.envelope);
    if (Object.keys(record).length !== RECORD_KEYS.length || RECORD_KEYS.some(key => !Object.hasOwn(record, key))
      || JSON.stringify(record.subject) !== JSON.stringify(subject)
      || JSON.stringify(envelope.subject) !== JSON.stringify(subject)
      || row.work_key !== subject.claim_key || row.execution_id !== subject.execution_id
      || row.envelope !== JSON.stringify(envelope)
      || record.schema !== "factory-hermes-execution-fixture/v1" || record.scope !== "synthetic_only"
      || record.dispatch_eligible !== false || !["started", "settled", "uncertain"].includes(record.effect_state)
      || record.lifecycle.delivery_target !== "implementation_complete"
      || !isDeepStrictEqual(normalizeExecutionLifecycle({ ...record.lifecycle }, { now: record.lifecycle.state_updated_at }), record.lifecycle)
      || (record.effect_state === "settled" && (record.lifecycle.state !== "implementation_complete"
        || !record.lifecycle.target_reached || !/^[a-f0-9]{64}$/.test(record.result_sha256 ?? "")
        || !record.lifecycle.evidence.implementation_complete?.some(evidence =>
          evidence.kind === "fixture-executor" && evidence.reference === record.result_sha256)))
      || (record.effect_state !== "settled" && record.result_sha256 !== null)
      || (record.effect_state === "started" && record.lifecycle.state !== "executing")
      || (record.effect_state === "uncertain" && record.lifecycle.state !== "held")) {
      throw new Error("FACTORY_EXECUTION_RECORD_BINDING");
    }
    return record;
  }

  private hold(record: FixtureExecutionRecord): FixtureExecutionRecord {
    if (record.effect_state !== "started") return record;
    const at = new Date(Math.max(this.now(), Date.parse(record.lifecycle.state_updated_at))).toISOString();
    const held: FixtureExecutionRecord = { ...record, effect_state: "uncertain",
      lifecycle: transitionExecutionLifecycle(record.lifecycle, "held", {
        kind: "uncertain-effect", reference: record.subject.execution_id,
        recorded_at: at,
      }, { now: at }) };
    const changed = this.db.query("UPDATE executions SET record=? WHERE work_key=? AND record=?")
      .run(JSON.stringify(held), record.subject.claim_key, JSON.stringify(record)).changes;
    if (changed !== 1) throw new Error("FACTORY_EXECUTION_CONCURRENT_CHANGE");
    return held;
  }

  /** Read-only for settled records; uncertain effects become a durable hold. Never invokes an executor. */
  recover(subject: FactoryExecutionSubject): FixtureExecutionRecord | null {
    const record = this.read(subject);
    return record ? this.hold(record) : null;
  }

  async run(input: FixtureHermesDispatch,
    executor: (subject: Readonly<FactoryExecutionSubject>) => Promise<{ result_sha256: string }>,
  ): Promise<FixtureExecutionRecord> {
    const envelope = validateFixtureHermesDispatch(input);
    const previous = this.read(envelope.subject);
    if (previous) {
      if (JSON.stringify(previous.envelope) !== JSON.stringify(envelope)) throw new Error("FACTORY_EXECUTION_REPLAY_MISMATCH");
      return this.hold(previous);
    }
    const now = this.assertAdmission(envelope);
    const record: FixtureExecutionRecord = {
      schema: "factory-hermes-execution-fixture/v1", scope: "synthetic_only", dispatch_eligible: false,
      subject: envelope.subject, envelope, effect_state: "started",
      lifecycle: createExecutionLifecycle("implementation_complete", new Date(now).toISOString()),
      result_sha256: null,
    };
    // Autocommit durably reserves the work identity before the external effect.
    // The UNIQUE work key also blocks another execution ID or claim generation.
    this.db.query("INSERT INTO executions VALUES (?,?,?,?)").run(envelope.subject.claim_key,
      envelope.subject.execution_id, JSON.stringify(envelope), JSON.stringify(record));
    try {
      const launchAt = this.assertAdmission(envelope, now);
      const result = await executor(Object.freeze({ ...envelope.subject }));
      const resultDigest = result?.result_sha256;
      if (typeof resultDigest !== "string" || !/^[a-f0-9]{64}$/.test(resultDigest)) throw new Error("FACTORY_EXECUTION_RESULT");
      const at = new Date(this.assertAdmission(envelope, launchAt)).toISOString();
      const settled: FixtureExecutionRecord = { ...record, effect_state: "settled", result_sha256: resultDigest,
        lifecycle: transitionExecutionLifecycle(record.lifecycle, "implementation_complete", {
          kind: "fixture-executor", reference: resultDigest,
          recorded_at: at,
        }, { now: at }) };
      const changed = this.db.query("UPDATE executions SET record=? WHERE work_key=? AND record=?")
        .run(JSON.stringify(settled), record.subject.claim_key, JSON.stringify(record)).changes;
      if (changed !== 1) throw new Error("FACTORY_EXECUTION_CONCURRENT_CHANGE");
      return settled;
    } catch {
      // Executor exceptions do not prove no effect happened. Never retry automatically.
      return this.recover(envelope.subject)!;
    }
  }
}
