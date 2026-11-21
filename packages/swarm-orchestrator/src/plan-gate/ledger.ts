/**
 * PCG-005: Append-only JSONL audit ledger for Plan Gate decisions.
 *
 * Properties:
 *   - Restrictive file permissions (0o600, owner-only)
 *   - Cross-process locking via O_CREAT|O_EXCL lock file
 *   - fsync before lock release on every decision write
 *   - SHA-256 hash chaining (each record hashes its predecessor)
 *   - Recovery / tamper detection on read
 *   - Configurable rotation by file size
 *   - 90-day default retention for archived files
 *
 * Default ledger path: $PLAN_GATE_LEDGER_PATH or ~/.zouroboros/plan-gate/audit.jsonl
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { LedgerRecord } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_MAX_LEDGER_BYTES = 10 * 1024 * 1024; // 10 MiB
export const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
export const DEFAULT_LOCK_RETRY_MS = 50;
/** Ledger file mode: owner read/write only (no group/world access). */
export const LEDGER_FILE_MODE = 0o600;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A persisted ledger entry: the full LedgerRecord plus its own SHA-256 hash.
 * The hash covers all fields including prev_record_hash; record_sha256 is
 * excluded from the preimage to avoid a self-referential hash.
 */
export type StoredLedgerRecord = LedgerRecord & { record_sha256: string };

export interface LedgerOptions {
  /** Absolute path to the JSONL ledger file. */
  ledgerPath?: string;
  /** Days to retain archived ledger files. Default: 90. */
  retentionDays?: number;
  /** Rotate when the active file exceeds this many bytes. Default: 10 MiB. */
  maxSizeBytes?: number;
  /** Cross-process lock acquisition timeout in ms. Default: 5000. */
  lockTimeoutMs?: number;
}

export interface HashChainResult {
  valid: boolean;
  record_count: number;
  /** Index of the first tampered record (0-based), if any. */
  tampered_at_index?: number;
  tampered_record_id?: string;
  /** Human-readable explanation when valid is false. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function deepSortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(deepSortKeys);
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = deepSortKeys(obj[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * Compute the canonical SHA-256 hash of a LedgerRecord.
 * The record_sha256 field, if present, is excluded from the hash preimage.
 */
export function computeRecordHash(record: LedgerRecord): string {
  const canonical = JSON.stringify(deepSortKeys(record));
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

/**
 * Verify the SHA-256 hash chain of a sequence of stored ledger records.
 *
 * Returns { valid: true } when every record's own hash is correct and every
 * record's prev_record_hash matches the previous record's record_sha256.
 *
 * On the first violation, returns { valid: false, tampered_at_index, reason }.
 */
export function hashChain(
  records: StoredLedgerRecord[],
  expectedPreviousHash?: string
): HashChainResult {
  for (let i = 0; i < records.length; i++) {
    const stored = records[i];
    // Strip record_sha256 to recompute the preimage
    const { record_sha256, ...rest } = stored;
    const expected = computeRecordHash(rest as LedgerRecord);

    if (record_sha256 !== expected) {
      return {
        valid: false,
        record_count: records.length,
        tampered_at_index: i,
        tampered_record_id: stored.record_id,
        reason: `Record ${i} (${stored.record_id}) hash mismatch: stored=${record_sha256.slice(0, 16)}… expected=${expected.slice(0, 16)}…`,
      };
    }

    if (i > 0) {
      const prevHash = records[i - 1].record_sha256;
      if (rest.prev_record_hash !== prevHash) {
        return {
          valid: false,
          record_count: records.length,
          tampered_at_index: i,
          tampered_record_id: stored.record_id,
          reason:
            `Record ${i} (${stored.record_id}) prev_record_hash chain broken: ` +
            `stored=${String(rest.prev_record_hash).slice(0, 16)}… expected=${prevHash.slice(0, 16)}…`,
        };
      }
    } else if (rest.prev_record_hash !== expectedPreviousHash) {
      return {
        valid: false,
        record_count: records.length,
        tampered_at_index: 0,
        tampered_record_id: stored.record_id,
        reason:
          `First record prev_record_hash mismatch: stored=${String(rest.prev_record_hash)} ` +
          `expected=${String(expectedPreviousHash)}.`,
      };
    }
  }
  return { valid: true, record_count: records.length };
}

// ---------------------------------------------------------------------------
// Lock file helpers (synchronous, cross-process)
// ---------------------------------------------------------------------------

function sleepSync(ms: number): void {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // Fallback for environments without SharedArrayBuffer
    const end = Date.now() + ms;
    while (Date.now() < end) { /* busy wait */ }
  }
}

function acquireLock(lockPath: string, timeoutMs: number, retryMs: number): void {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      const fd = fs.openSync(
        lockPath,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY,
        0o600
      );
      fs.writeSync(fd, `${process.pid}\n`);
      fs.closeSync(fd);
      return;
    } catch (err) {
      const errno = (err as NodeJS.ErrnoException).code;
      if (errno !== 'EEXIST') throw err;

      // Remove stale lock if the holding process has clearly finished
      try {
        const lockStat = fs.statSync(lockPath);
        if (Date.now() - lockStat.mtimeMs > timeoutMs * 2) {
          fs.unlinkSync(lockPath);
          continue; // retry immediately
        }
      } catch { /* lock may have been released between the stat and unlink */ }

      if (Date.now() >= deadline) {
        throw new Error(
          `Failed to acquire ledger lock at '${lockPath}' after ${timeoutMs}ms. ` +
          `If a process crashed, delete the lock file manually.`
        );
      }
      sleepSync(retryMs);
    }
  }
}

function releaseLock(lockPath: string): void {
  try { fs.unlinkSync(lockPath); } catch { /* ignore; lock may already be gone */ }
}

// ---------------------------------------------------------------------------
// Default path resolution
// ---------------------------------------------------------------------------

function defaultLedgerPath(): string {
  const envPath = process.env['PLAN_GATE_LEDGER_PATH'];
  if (envPath) return envPath;
  return path.join(os.homedir(), '.zouroboros', 'plan-gate', 'audit.jsonl');
}

// ---------------------------------------------------------------------------
// Archive filename helpers
// ---------------------------------------------------------------------------

const ARCHIVE_SUFFIX_RE = /\.(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)$/;

function archiveSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function archivePath(ledgerPath: string): string {
  return `${ledgerPath}.${archiveSuffix()}`;
}

// ---------------------------------------------------------------------------
// PlanGateLedger
// ---------------------------------------------------------------------------

/**
 * Append-only JSONL audit ledger with hash chaining, cross-process locking,
 * fsync durability, configurable rotation, and retention enforcement.
 */
export class PlanGateLedger {
  private readonly ledgerPath: string;
  private readonly lockPath: string;
  private readonly retentionDays: number;
  private readonly maxSizeBytes: number;
  private readonly lockTimeoutMs: number;

  constructor(opts: LedgerOptions = {}) {
    this.ledgerPath = opts.ledgerPath ?? defaultLedgerPath();
    this.lockPath = `${this.ledgerPath}.lock`;
    this.retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
    this.maxSizeBytes = opts.maxSizeBytes ?? DEFAULT_MAX_LEDGER_BYTES;
    this.lockTimeoutMs = opts.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;

    // Ensure parent directory exists with restricted permissions
    const dir = path.dirname(this.ledgerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  /**
   * Append a single LedgerRecord to the ledger.
   *
   * - Acquires the cross-process lock.
   * - Rotates the active file if it exceeds maxSizeBytes.
   * - Reads the previous record hash to link the chain.
   * - Writes the new record and calls fsync before releasing the lock.
   */
  append(record: LedgerRecord): void {
    acquireLock(this.lockPath, this.lockTimeoutMs, DEFAULT_LOCK_RETRY_MS);
    try {
      this.rotateIfNeeded();

      const prevHash = this.readLastHash();
      const chainedRecord: LedgerRecord = {
        ...record,
        prev_record_hash: prevHash ?? undefined,
      };

      const record_sha256 = computeRecordHash(chainedRecord);
      const stored: StoredLedgerRecord = { ...chainedRecord, record_sha256 };

      const fd = fs.openSync(
        this.ledgerPath,
        fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
        LEDGER_FILE_MODE
      );
      try {
        fs.fchmodSync(fd, LEDGER_FILE_MODE);
        fs.writeSync(fd, JSON.stringify(stored) + '\n');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } finally {
      releaseLock(this.lockPath);
    }
  }

  /**
   * Read all stored records from the active ledger file.
   * Returns an empty array when the file does not exist.
   * Malformed lines fail closed so truncation or injected bytes cannot disappear
   * from the verification surface.
   */
  readAll(): StoredLedgerRecord[] {
    if (!fs.existsSync(this.ledgerPath)) return [];
    const content = fs.readFileSync(this.ledgerPath, 'utf8');
    const records: StoredLedgerRecord[] = [];
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as StoredLedgerRecord);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Malformed ledger record at line ${records.length + 1}: ${message}`);
      }
    }
    return records;
  }

  /**
   * Verify hash chain integrity of the active ledger.
   */
  verify(): HashChainResult {
    try {
      const records = this.readAll();
      const expectedPreviousHash = records[0]?.prev_record_hash
        ? this.readLatestArchiveHash()
        : undefined;
      return hashChain(records, expectedPreviousHash ?? undefined);
    } catch (error) {
      return {
        valid: false,
        record_count: 0,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Trigger an immediate rotation: archive the current file and start fresh.
   */
  rotate(): void {
    acquireLock(this.lockPath, this.lockTimeoutMs, DEFAULT_LOCK_RETRY_MS);
    try {
      this.doRotate();
    } finally {
      releaseLock(this.lockPath);
    }
  }

  /**
   * Delete archived ledger files whose modification time exceeds retentionDays.
   * Must be called from outside the lock (this method acquires it).
   */
  pruneArchives(): void {
    acquireLock(this.lockPath, this.lockTimeoutMs, DEFAULT_LOCK_RETRY_MS);
    try {
      this.doPruneOldArchives();
    } finally {
      releaseLock(this.lockPath);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers (must be called within the lock)
  // ---------------------------------------------------------------------------

  private rotateIfNeeded(): void {
    if (!fs.existsSync(this.ledgerPath)) return;
    const stat = fs.statSync(this.ledgerPath);
    if (stat.size >= this.maxSizeBytes) this.doRotate();
  }

  private doRotate(): void {
    if (!fs.existsSync(this.ledgerPath)) return;
    const dest = archivePath(this.ledgerPath);
    fs.renameSync(this.ledgerPath, dest);
    this.doPruneOldArchives();
  }

  private doPruneOldArchives(): void {
    const dir = path.dirname(this.ledgerPath);
    const base = path.basename(this.ledgerPath) + '.';
    const cutoffMs = Date.now() - this.retentionDays * 24 * 60 * 60 * 1_000;
    let entries: string[];
    try { entries = fs.readdirSync(dir); } catch { return; }
    for (const entry of entries) {
      if (!entry.startsWith(base) || !ARCHIVE_SUFFIX_RE.test(entry)) continue;
      const full = path.join(dir, entry);
      try {
        if (fs.statSync(full).mtimeMs < cutoffMs) fs.unlinkSync(full);
      } catch { /* ignore concurrent deletions */ }
    }
  }

  private readLastHash(): string | null {
    if (!fs.existsSync(this.ledgerPath)) return this.readLatestArchiveHash();
    return this.readLastHashFrom(this.ledgerPath);
  }

  private readLastHashFrom(sourcePath: string): string | null {
    const content = fs.readFileSync(sourcePath, 'utf8');
    const lines = content.split('\n').filter((l) => l.trim() !== '');
    if (lines.length === 0) return null;
    try {
      const last = JSON.parse(lines[lines.length - 1]) as StoredLedgerRecord;
      return last.record_sha256 ?? null;
    } catch {
      return null;
    }
  }

  private readLatestArchiveHash(): string | null {
    const dir = path.dirname(this.ledgerPath);
    const base = path.basename(this.ledgerPath) + '.';
    let entries: string[];
    try {
      entries = fs.readdirSync(dir)
        .filter((entry) => entry.startsWith(base) && ARCHIVE_SUFFIX_RE.test(entry))
        .sort();
    } catch {
      return null;
    }
    const latest = entries.at(-1);
    return latest ? this.readLastHashFrom(path.join(dir, latest)) : null;
  }
}
