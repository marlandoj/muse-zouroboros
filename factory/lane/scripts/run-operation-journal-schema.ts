import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Database } from "bun:sqlite";

export const JOURNAL_SCHEMA_VERSION = 2 as const;
export const DEFAULT_BUSY_TIMEOUT_MS = 3_000;
export const MAX_BUSY_TIMEOUT_MS = 3_000;
export const MAX_DATABASE_BYTES = 64 * 1024 * 1024;
const BOOTSTRAP_BUSY_RETRY_INTERVAL_MS = 10;

const V1_INSERT_ONLY_TABLES = [
  "journal_meta",
  "operations",
  "authority_holds",
  "journal_events",
  "effect_definitions",
  "effect_states",
  "terminal_records",
  "receipts",
  "schema_migrations",
] as const;

const V2_INSERT_ONLY_TABLES = [
  "edge_proof_plans",
  "edge_proof_observations",
  "edge_proof_records",
] as const;

const SCHEMA_SQL = `
CREATE TABLE journal_meta (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY NOT NULL CHECK(operation_id GLOB 'op-*'),
  scope TEXT NOT NULL CHECK(length(scope) BETWEEN 1 AND 256),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 512),
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  canonical_input TEXT NOT NULL,
  trigger_kind TEXT NOT NULL,
  trigger_identity TEXT NOT NULL,
  authority_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  operation_deadline TEXT,
  UNIQUE(scope, idempotency_key)
) STRICT;

CREATE TABLE authority_holds (
  hold_id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  reason_code TEXT NOT NULL,
  canonical_authority TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(scope, idempotency_key, input_hash, reason_code)
) STRICT;

CREATE TABLE journal_events (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE CHECK(event_id GLOB 'evt-*'),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  event_sequence INTEGER NOT NULL CHECK(event_sequence > 0),
  kind TEXT NOT NULL,
  canonical_payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash) = 64 AND payload_hash NOT GLOB '*[^0-9a-f]*'),
  prior_event_hash TEXT CHECK(prior_event_hash IS NULL OR (length(prior_event_hash) = 64 AND prior_event_hash NOT GLOB '*[^0-9a-f]*')),
  event_hash TEXT NOT NULL UNIQUE CHECK(length(event_hash) = 64 AND event_hash NOT GLOB '*[^0-9a-f]*'),
  source_writer TEXT,
  source_event_id TEXT,
  source_payload_hash TEXT CHECK(source_payload_hash IS NULL OR (length(source_payload_hash) = 64 AND source_payload_hash NOT GLOB '*[^0-9a-f]*')),
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, event_sequence),
  CHECK((source_writer IS NULL) = (source_event_id IS NULL)),
  CHECK(source_payload_hash IS NULL OR source_writer IS NOT NULL)
) STRICT;

CREATE UNIQUE INDEX journal_events_source_identity
  ON journal_events(source_writer, source_event_id)
  WHERE source_writer IS NOT NULL;

CREATE TABLE effect_definitions (
  effect_id TEXT PRIMARY KEY NOT NULL CHECK(effect_id GLOB 'eff-*'),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  attempt_n INTEGER NOT NULL CHECK(attempt_n > 0),
  tool_call_id TEXT NOT NULL UNIQUE,
  adapter_kind TEXT NOT NULL,
  side_effect_kind TEXT NOT NULL CHECK(side_effect_kind IN ('file_write', 'file_delete', 'api_call', 'ledger_append', 'service_register', 'git_push', 'linear_mutation', 'qdrant_upsert', 'qdrant_delete')),
  target TEXT NOT NULL,
  input_hash TEXT NOT NULL CHECK(length(input_hash) = 64 AND input_hash NOT GLOB '*[^0-9a-f]*'),
  canonical_input TEXT NOT NULL,
  reversible INTEGER NOT NULL CHECK(reversible IN (0, 1)),
  rollback_ref TEXT,
  authority_scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, adapter_kind, target, input_hash),
  CHECK(reversible = 0 OR rollback_ref IS NOT NULL)
) STRICT;

CREATE TABLE effect_states (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  state_id TEXT NOT NULL UNIQUE,
  effect_id TEXT NOT NULL REFERENCES effect_definitions(effect_id),
  state_sequence INTEGER NOT NULL CHECK(state_sequence > 0),
  state TEXT NOT NULL CHECK(state IN ('intended', 'dispatch_started', 'committed', 'not_committed', 'ambiguous', 'compensated')),
  canonical_evidence TEXT NOT NULL,
  evidence_hash TEXT NOT NULL CHECK(length(evidence_hash) = 64 AND evidence_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE(effect_id, state_sequence)
) STRICT;

CREATE TABLE terminal_records (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES operations(operation_id),
  outcome TEXT NOT NULL CHECK(outcome IN ('success', 'failure', 'partial', 'timeout', 'cancelled', 'held')),
  reason_code TEXT NOT NULL,
  terminal_event_id TEXT NOT NULL UNIQUE REFERENCES journal_events(event_id),
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE receipts (
  operation_id TEXT PRIMARY KEY NOT NULL REFERENCES terminal_records(operation_id),
  receipt_id TEXT NOT NULL UNIQUE CHECK(receipt_id GLOB 'rr-*'),
  receipt_hash TEXT NOT NULL UNIQUE CHECK(length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
  canonical_receipt TEXT NOT NULL,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL CHECK(length(checksum) = 64 AND checksum NOT GLOB '*[^0-9a-f]*'),
  applied_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER journal_events_contiguous BEFORE INSERT ON journal_events
BEGIN
  SELECT CASE WHEN NEW.event_sequence != COALESCE(
    (SELECT MAX(event_sequence) + 1 FROM journal_events WHERE operation_id = NEW.operation_id), 1
  ) THEN RAISE(ABORT, 'event_sequence_gap') END;
  SELECT CASE WHEN NEW.prior_event_hash IS NOT (
    SELECT event_hash FROM journal_events WHERE operation_id = NEW.operation_id ORDER BY event_sequence DESC LIMIT 1
  ) THEN RAISE(ABORT, 'event_chain_mismatch') END;
END;

CREATE TRIGGER effect_states_contiguous BEFORE INSERT ON effect_states
BEGIN
  SELECT CASE WHEN NEW.state_sequence != COALESCE(
    (SELECT MAX(state_sequence) + 1 FROM effect_states WHERE effect_id = NEW.effect_id), 1
  ) THEN RAISE(ABORT, 'effect_state_sequence_gap') END;
  SELECT CASE
    WHEN NEW.state_sequence = 1 AND NEW.state != 'intended' THEN RAISE(ABORT, 'effect_must_start_intended')
    WHEN NEW.state_sequence > 1 AND NOT EXISTS (
      SELECT 1 FROM effect_states prior
      WHERE prior.effect_id = NEW.effect_id AND prior.state_sequence = NEW.state_sequence - 1
      AND (
        (prior.state = 'intended' AND NEW.state = 'dispatch_started') OR
        (prior.state = 'dispatch_started' AND NEW.state IN ('committed', 'not_committed', 'ambiguous')) OR
        (prior.state = 'not_committed' AND NEW.state = 'dispatch_started') OR
        (prior.state = 'ambiguous' AND NEW.state IN ('committed', 'not_committed')) OR
        (prior.state = 'committed' AND NEW.state = 'compensated')
      )
    ) THEN RAISE(ABORT, 'invalid_effect_transition')
  END;
END;
`;

const EDGE_PROOF_SCHEMA_SQL = `
CREATE TABLE edge_proof_plans (
  plan_id TEXT PRIMARY KEY NOT NULL CHECK(plan_id GLOB 'epp-*'),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  target_hash TEXT NOT NULL CHECK(length(target_hash) = 64 AND target_hash NOT GLOB '*[^0-9a-f]*'),
  requirement TEXT NOT NULL CHECK(requirement IN ('required', 'notApplicable')),
  canonical_plan TEXT NOT NULL,
  plan_hash TEXT NOT NULL UNIQUE CHECK(length(plan_hash) = 64 AND plan_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL,
  UNIQUE(operation_id, target_hash)
) STRICT;

CREATE TABLE edge_proof_observations (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id TEXT NOT NULL UNIQUE CHECK(observation_id GLOB 'epo-*'),
  plan_id TEXT NOT NULL REFERENCES edge_proof_plans(plan_id),
  attempt INTEGER NOT NULL CHECK(attempt BETWEEN 1 AND 16),
  status TEXT NOT NULL CHECK(status IN ('confirmed', 'retryable', 'unavailable')),
  acknowledgement_tier TEXT NOT NULL CHECK(acknowledgement_tier IN ('none', 'transport_accepted', 'durable_confirmed', 'user_visible_confirmed')),
  canonical_observation TEXT NOT NULL,
  observation_hash TEXT NOT NULL UNIQUE CHECK(length(observation_hash) = 64 AND observation_hash NOT GLOB '*[^0-9a-f]*'),
  source_binding_hash TEXT UNIQUE CHECK(source_binding_hash IS NULL OR (length(source_binding_hash) = 64 AND source_binding_hash NOT GLOB '*[^0-9a-f]*')),
  predecessor_hash TEXT CHECK(predecessor_hash IS NULL OR (length(predecessor_hash) = 64 AND predecessor_hash NOT GLOB '*[^0-9a-f]*')),
  observed_at TEXT NOT NULL,
  next_poll_at TEXT,
  UNIQUE(plan_id, attempt)
) STRICT;

CREATE TABLE edge_proof_records (
  commit_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  record_id TEXT NOT NULL UNIQUE CHECK(record_id GLOB 'epr-*'),
  proof_id TEXT NOT NULL UNIQUE CHECK(proof_id GLOB 'proof-*'),
  operation_id TEXT NOT NULL REFERENCES operations(operation_id),
  receipt_id TEXT NOT NULL REFERENCES receipts(receipt_id),
  receipt_hash TEXT NOT NULL CHECK(length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*'),
  plan_id TEXT NOT NULL REFERENCES edge_proof_plans(plan_id),
  classification TEXT NOT NULL CHECK(classification IN ('required', 'notApplicable', 'unavailable')),
  acknowledgement_tier TEXT NOT NULL CHECK(acknowledgement_tier IN ('none', 'transport_accepted', 'durable_confirmed', 'user_visible_confirmed')),
  timeliness TEXT NOT NULL CHECK(timeliness IN ('within_deadline', 'late', 'not_applicable')),
  canonical_record TEXT NOT NULL,
  predecessor_record_hash TEXT CHECK(predecessor_record_hash IS NULL OR (length(predecessor_record_hash) = 64 AND predecessor_record_hash NOT GLOB '*[^0-9a-f]*')),
  record_hash TEXT NOT NULL UNIQUE CHECK(length(record_hash) = 64 AND record_hash NOT GLOB '*[^0-9a-f]*'),
  created_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER edge_proof_observations_contiguous BEFORE INSERT ON edge_proof_observations
BEGIN
  SELECT CASE WHEN NEW.attempt != COALESCE(
    (SELECT MAX(attempt) + 1 FROM edge_proof_observations WHERE plan_id = NEW.plan_id), 1
  ) THEN RAISE(ABORT, 'edge_proof_attempt_gap') END;
  SELECT CASE WHEN NEW.predecessor_hash IS NOT (
    SELECT observation_hash FROM edge_proof_observations WHERE plan_id = NEW.plan_id ORDER BY attempt DESC LIMIT 1
  ) THEN RAISE(ABORT, 'edge_proof_observation_chain_mismatch') END;
END;

CREATE TRIGGER edge_proof_records_chain BEFORE INSERT ON edge_proof_records
BEGIN
  SELECT CASE WHEN NEW.predecessor_record_hash IS NOT (
    SELECT record_hash FROM edge_proof_records WHERE operation_id = NEW.operation_id ORDER BY commit_sequence DESC LIMIT 1
  ) THEN RAISE(ABORT, 'edge_proof_record_chain_mismatch') END;
END;
`;

export const JOURNAL_SCHEMA_V1_CHECKSUM = createHash("sha256").update(SCHEMA_SQL, "utf8").digest("hex");
export const JOURNAL_SCHEMA_CHECKSUM = createHash("sha256")
  .update(`${JOURNAL_SCHEMA_V1_CHECKSUM}\0${EDGE_PROOF_SCHEMA_SQL}`, "utf8")
  .digest("hex");

export class JournalStorageError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "JournalStorageError";
  }
}

export interface OpenJournalOptions {
  busyTimeoutMs?: number;
  create?: boolean;
  backupPath?: string;
  now?: () => string;
}

function assertAbsoluteFilePath(path: string, label = "journal path"): void {
  if (!path || !isAbsolute(path) || path.endsWith("/") || path.includes("\0")) {
    throw new JournalStorageError("invalid_path", `${label} must be an explicit absolute file path`);
  }
}

export function resolveJournalPath(options: { path?: string; env?: Record<string, string | undefined> }): string {
  const env = options.env ?? process.env;
  const direct = options.path ?? env.FACTORY_OPERATION_JOURNAL_PATH;
  let candidate: string;
  try {
    candidate = direct
      ? resolveFactoryStateOverride(direct)
      : join(factoryStateRoot({ env }), "operation-journal.sqlite");
  } catch (error) {
    throw new JournalStorageError("path_required", error instanceof Error ? error.message : String(error));
  }
  assertAbsoluteFilePath(candidate);
  return resolve(candidate);
}

function pragmaScalar(db: Database, pragma: string): unknown {
  const row = db.query(`PRAGMA ${pragma}`).get() as Record<string, unknown> | null;
  return row ? Object.values(row)[0] : undefined;
}

function installInsertOnlyTriggers(db: Database, tables: readonly string[]): void {
  for (const table of tables) {
    db.exec(`CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table} BEGIN SELECT RAISE(ABORT, '${table}_is_insert_only'); END;`);
    db.exec(`CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table} BEGIN SELECT RAISE(ABORT, '${table}_is_insert_only'); END;`);
  }
}

function databaseHasUserObjects(db: Database): boolean {
  const row = db.query("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get() as { count: number };
  return row.count > 0;
}

function applyInitialMigration(db: Database, now: string): void {
  db.exec(SCHEMA_SQL);
  installInsertOnlyTriggers(db, V1_INSERT_ONLY_TABLES);
  db.query("INSERT INTO journal_meta(key, value) VALUES ('schema_checksum', ?)").run(JOURNAL_SCHEMA_V1_CHECKSUM);
  db.query("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)")
    .run(1, JOURNAL_SCHEMA_V1_CHECKSUM, now);
  applyEdgeProofMigration(db, now);
}

function applyEdgeProofMigration(db: Database, now: string): void {
  db.exec(EDGE_PROOF_SCHEMA_SQL);
  installInsertOnlyTriggers(db, V2_INSERT_ONLY_TABLES);
  db.query("INSERT INTO journal_meta(key, value) VALUES ('schema_checksum_v2', ?)").run(JOURNAL_SCHEMA_CHECKSUM);
  db.query("INSERT INTO schema_migrations(version, checksum, applied_at) VALUES (?, ?, ?)")
    .run(JOURNAL_SCHEMA_VERSION, JOURNAL_SCHEMA_CHECKSUM, now);
  db.exec(`PRAGMA user_version = ${JOURNAL_SCHEMA_VERSION}`);
}

export function createVerifiedBackup(db: Database, backupPath: string, expectedVersion: number = JOURNAL_SCHEMA_VERSION): void {
  assertAbsoluteFilePath(backupPath, "backup path");
  if (existsSync(backupPath)) throw new JournalStorageError("backup_exists", `backup already exists: ${backupPath}`);
  mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
  const temp = `${backupPath}.tmp-${process.pid}`;
  db.exec("PRAGMA wal_checkpoint(FULL)");
  try {
    writeFileSync(temp, db.serialize(), { mode: 0o600, flag: "wx" });
    verifyBackupFile(temp, expectedVersion);
    renameSync(temp, backupPath);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* no temporary backup to remove */ }
    throw error;
  }
}

function verifyBackupFile(path: string, expectedVersion: number): void {
  const verify = new Database(path, { readonly: true, strict: true });
  try {
    if (pragmaScalar(verify, "quick_check") !== "ok") throw new JournalStorageError("backup_integrity", "backup quick_check failed");
    const version = Number(pragmaScalar(verify, "user_version"));
    if (version !== expectedVersion) throw new JournalStorageError("backup_version", `backup has user_version ${version}`);
    const legacyChecksum = verify.query("SELECT value FROM journal_meta WHERE key = 'schema_checksum'").get() as { value: string } | null;
    const legacyMigration = verify.query("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum: string } | null;
    if (legacyChecksum?.value !== JOURNAL_SCHEMA_V1_CHECKSUM || legacyMigration?.checksum !== JOURNAL_SCHEMA_V1_CHECKSUM) {
      throw new JournalStorageError("backup_checksum", "backup v1 schema checksum is invalid");
    }
    if (expectedVersion === JOURNAL_SCHEMA_VERSION) {
      const checksum = verify.query("SELECT value FROM journal_meta WHERE key = 'schema_checksum_v2'").get() as { value: string } | null;
      const migration = verify.query("SELECT checksum FROM schema_migrations WHERE version = ?").get(JOURNAL_SCHEMA_VERSION) as { checksum: string } | null;
      if (checksum?.value !== JOURNAL_SCHEMA_CHECKSUM || migration?.checksum !== JOURNAL_SCHEMA_CHECKSUM) {
        throw new JournalStorageError("backup_checksum", "backup v2 schema checksum is invalid");
      }
    }
  } finally {
    verify.close();
  }
}

function ensureMigrationBackup(db: Database, backupPath: string, expectedVersion: number): void {
  if (!existsSync(backupPath)) {
    createVerifiedBackup(db, backupPath, expectedVersion);
    return;
  }
  db.exec("PRAGMA wal_checkpoint(FULL)");
  verifyBackupFile(backupPath, expectedVersion);
  if (!Buffer.from(db.serialize()).equals(readFileSync(backupPath))) {
    throw new JournalStorageError("backup_conflict", "existing migration backup does not match the current source database");
  }
}

export function restoreVerifiedBackup(backupPath: string, restorePath: string, expectedVersion: number = 1): void {
  assertAbsoluteFilePath(backupPath, "backup path");
  assertAbsoluteFilePath(restorePath, "restore path");
  if (resolve(backupPath) === resolve(restorePath)) throw new JournalStorageError("restore_path_conflict", "restore path must differ from the immutable backup");
  if (!existsSync(backupPath)) throw new JournalStorageError("backup_missing", `backup does not exist: ${backupPath}`);
  if (existsSync(restorePath)) throw new JournalStorageError("restore_exists", `restore path already exists: ${restorePath}`);
  verifyBackupFile(backupPath, expectedVersion);
  mkdirSync(dirname(restorePath), { recursive: true, mode: 0o700 });
  const temp = `${restorePath}.tmp-${process.pid}`;
  try {
    writeFileSync(temp, readFileSync(backupPath), { mode: 0o600, flag: "wx" });
    verifyBackupFile(temp, expectedVersion);
    renameSync(temp, restorePath);
  } catch (error) {
    try { unlinkSync(temp); } catch { /* no temporary restore to remove */ }
    throw error;
  }
}

function verifyOpenedDatabase(db: Database, busyTimeoutMs: number): void {
  if (String(pragmaScalar(db, "journal_mode")).toLowerCase() !== "wal") throw new JournalStorageError("wal_required", "journal_mode must be WAL");
  if (Number(pragmaScalar(db, "synchronous")) !== 2) throw new JournalStorageError("synchronous_required", "synchronous must be FULL");
  if (Number(pragmaScalar(db, "foreign_keys")) !== 1) throw new JournalStorageError("foreign_keys_required", "foreign_keys must be ON");
  if (Number(pragmaScalar(db, "busy_timeout")) !== busyTimeoutMs) throw new JournalStorageError("busy_timeout_mismatch", "busy_timeout mismatch");
  if (pragmaScalar(db, "quick_check") !== "ok") throw new JournalStorageError("integrity_failure", "quick_check failed");
  const version = Number(pragmaScalar(db, "user_version"));
  if (version !== JOURNAL_SCHEMA_VERSION) throw new JournalStorageError("unsupported_schema", `unsupported user_version ${version}`);
  const legacyChecksum = db.query("SELECT value FROM journal_meta WHERE key = 'schema_checksum'").get() as { value: string } | null;
  const legacyMigration = db.query("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum: string } | null;
  const checksum = db.query("SELECT value FROM journal_meta WHERE key = 'schema_checksum_v2'").get() as { value: string } | null;
  const migration = db.query("SELECT checksum FROM schema_migrations WHERE version = ?").get(JOURNAL_SCHEMA_VERSION) as { checksum: string } | null;
  if (
    legacyChecksum?.value !== JOURNAL_SCHEMA_V1_CHECKSUM || legacyMigration?.checksum !== JOURNAL_SCHEMA_V1_CHECKSUM
    || checksum?.value !== JOURNAL_SCHEMA_CHECKSUM || migration?.checksum !== JOURNAL_SCHEMA_CHECKSUM
  ) {
    throw new JournalStorageError("schema_checksum_mismatch", "compiled and stored schema checksums differ");
  }
}

function isBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

function execWithBusyDeadline(db: Database, statement: string, deadlineMs: number): void {
  const deadline = Date.now() + deadlineMs;
  while (true) {
    try {
      db.exec(statement);
      return;
    } catch (error) {
      const remainingMs = deadline - Date.now();
      if (!isBusy(error) || remainingMs <= 0) throw error;
      Bun.sleepSync(Math.min(BOOTSTRAP_BUSY_RETRY_INTERVAL_MS, remainingMs));
    }
  }
}

export function openJournalDatabase(path: string, options: OpenJournalOptions = {}): Database {
  assertAbsoluteFilePath(path);
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > MAX_BUSY_TIMEOUT_MS) {
    throw new JournalStorageError("busy_timeout_invalid", `busy_timeout must be between 0 and ${MAX_BUSY_TIMEOUT_MS}`);
  }
  const existed = existsSync(path);
  if (!existed && options.create === false) throw new JournalStorageError("database_missing", `journal does not exist: ${path}`);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path, { create: options.create !== false, strict: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    execWithBusyDeadline(db, "PRAGMA journal_mode = WAL", busyTimeoutMs);
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("BEGIN IMMEDIATE");
    let version: number;
    try {
      version = Number(pragmaScalar(db, "user_version"));
      if (version === 0) {
        if (databaseHasUserObjects(db)) throw new JournalStorageError("unknown_version_zero", "non-empty version-zero database is unsupported");
        applyInitialMigration(db, options.now?.() ?? new Date().toISOString());
        version = JOURNAL_SCHEMA_VERSION;
      } else if (version > JOURNAL_SCHEMA_VERSION) {
        throw new JournalStorageError("newer_schema", `database user_version ${version} is newer than supported ${JOURNAL_SCHEMA_VERSION}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    if (version < JOURNAL_SCHEMA_VERSION) {
      if (!options.backupPath) throw new JournalStorageError("backup_required", "a verified backup path is required before migration");
      if (version !== 1) throw new JournalStorageError("migration_unsupported", `no migration is defined from ${version}`);
      const legacyChecksum = db.query("SELECT value FROM journal_meta WHERE key = 'schema_checksum'").get() as { value: string } | null;
      const legacyMigration = db.query("SELECT checksum FROM schema_migrations WHERE version = 1").get() as { checksum: string } | null;
      if (legacyChecksum?.value !== JOURNAL_SCHEMA_V1_CHECKSUM || legacyMigration?.checksum !== JOURNAL_SCHEMA_V1_CHECKSUM) {
        throw new JournalStorageError("schema_checksum_mismatch", "compiled and stored v1 schema checksums differ");
      }
      ensureMigrationBackup(db, options.backupPath, 1);
      db.exec("BEGIN IMMEDIATE");
      try {
        applyEdgeProofMigration(db, options.now?.() ?? new Date().toISOString());
        db.exec("COMMIT");
        version = JOURNAL_SCHEMA_VERSION;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    }
    verifyOpenedDatabase(db, busyTimeoutMs);
    try { chmodSync(path, 0o600); } catch { /* permissions are best effort on v9fs */ }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export interface StorageQualificationResult {
  ok: true;
  databasePath: string;
  filesystemDevice: number;
  sameMount: true;
  walReopened: true;
  checkpointed: true;
  backupRestored: true;
}

export function qualifyJournalStorage(targetPath: string): StorageQualificationResult {
  assertAbsoluteFilePath(targetPath, "qualification target");
  const parent = dirname(targetPath);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const qualifierDir = join(parent, `.operation-journal-qualify-${process.pid}-${Date.now()}`);
  mkdirSync(qualifierDir, { mode: 0o700 });
  const dbPath = join(qualifierDir, "qualification.sqlite");
  const backupPath = join(qualifierDir, "qualification.backup.sqlite");
  const restorePath = join(qualifierDir, "qualification.restore.sqlite");
  let db: Database | undefined;
  try {
    if (statSync(parent).dev !== statSync(qualifierDir).dev) throw new JournalStorageError("mount_mismatch", "qualification path is not on the target mount");
    db = openJournalDatabase(dbPath);
    db.query("INSERT INTO authority_holds VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      "qualify-1", "qualification", "qualification", "0".repeat(64), "qualification", "{}", new Date(0).toISOString(),
    );
    db.close();
    db = openJournalDatabase(dbPath, { create: false });
    const reopenedCount = db.query("SELECT COUNT(*) AS count FROM authority_holds").get() as { count: number };
    if (reopenedCount.count !== 1) throw new JournalStorageError("reopen_mismatch", "WAL reopen lost committed rows");
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    createVerifiedBackup(db, backupPath);
    db.close();
    db = undefined;
    writeFileSync(restorePath, readFileSync(backupPath), { mode: 0o600, flag: "wx" });
    const restored = openJournalDatabase(restorePath, { create: false });
    try {
      const count = restored.query("SELECT COUNT(*) AS count FROM authority_holds").get() as { count: number };
      if (count.count !== 1) throw new JournalStorageError("restore_mismatch", "restored backup lost committed rows");
      restored.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } finally {
      restored.close();
    }
    return {
      ok: true,
      databasePath: dbPath,
      filesystemDevice: statSync(parent).dev,
      sameMount: true,
      walReopened: true,
      checkpointed: true,
      backupRestored: true,
    };
  } finally {
    db?.close();
    for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`, backupPath, restorePath, `${restorePath}-wal`, `${restorePath}-shm`]) {
      try { unlinkSync(path); } catch { /* disposable qualifier */ }
    }
    try { rmdirSync(qualifierDir); } catch { /* disposable qualifier */ }
  }
}

export function checkpointJournal(db: Database): void {
  const result = db.query("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy: number; log: number; checkpointed: number };
  if (result.busy !== 0 || result.log !== result.checkpointed) throw new JournalStorageError("checkpoint_incomplete", "WAL checkpoint did not complete");
}

export function assertDatabaseResourceCeiling(path: string, maxBytes = MAX_DATABASE_BYTES): void {
  const bytes = [path, `${path}-wal`, `${path}-shm`].reduce((sum, candidate) => sum + (existsSync(candidate) ? statSync(candidate).size : 0), 0);
  if (bytes > maxBytes) throw new JournalStorageError("database_size_exceeded", `journal uses ${bytes} bytes, ceiling is ${maxBytes}`);
}
