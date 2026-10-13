/**
 * plan-gate-ledger-stub.ts — Local stand-in for the workflow plan-gate ledger
 * (packages/workflow/src/plan-gate/ledger.ts).
 *
 * The upstream module is a hash-chained, file-locked ledger (~400 lines) and
 * is not vendored in this distribution. This stub provides the small surface
 * the factory actually uses — append / readAll / verify / pruneArchives —
 * over plain JSONL:
 *
 * - append: appends one JSON line.
 * - readAll: parses JSONL; malformed lines fail closed (verify reports them).
 * - verify: structural integrity — every line must be valid JSON. Records
 *   carrying a record_sha256 get it hash-verified; records without one (e.g.
 *   written by plan-gate-stub.ts) are accepted as-is.
 * - pruneArchives: no-op (no rotation in this distribution).
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

export interface StoredLedgerRecord {
  record_id?: string;
  artifact_sha256?: string;
  revision?: number;
  timestamp?: string;
  policy_mode?: string;
  execution_action?: string;
  execution_mode?: string;
  ticket_id?: string;
  identifier?: string;
  execution_id?: string;
  reason?: string;
  record_sha256?: string;
  [key: string]: unknown;
}

/** Input record shape (before storage). StoredLedgerRecord adds record_sha256. */
export type LedgerRecord = Omit<StoredLedgerRecord, "record_sha256">;

export interface HashChainResult {
  valid: boolean;
  record_count: number;
  tampered_at_index?: number;
  tampered_record_id?: string;
  reason?: string;
}

export interface PlanGateLedgerOptions {
  ledgerPath?: string;
  retentionDays?: number;
}

export class PlanGateLedger {
  private readonly ledgerPath: string;

  constructor(opts: PlanGateLedgerOptions = {}) {
    this.ledgerPath =
      opts.ledgerPath ?? "./plan-gate-ledger.jsonl";
    const dir = dirname(this.ledgerPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  append(record: Record<string, unknown>): void {
    appendFileSync(this.ledgerPath, JSON.stringify(record) + "\n", "utf8");
  }

  readAll(): StoredLedgerRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    return readFileSync(this.ledgerPath, "utf8")
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as StoredLedgerRecord);
  }

  verify(): HashChainResult {
    if (!existsSync(this.ledgerPath)) return { valid: true, record_count: 0 };
    const lines = readFileSync(this.ledgerPath, "utf8").split("\n");
    let count = 0;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      if (line.trim().length === 0) continue;
      let record: StoredLedgerRecord;
      try {
        record = JSON.parse(line) as StoredLedgerRecord;
      } catch {
        return {
          valid: false,
          record_count: count,
          tampered_at_index: index,
          reason: `line ${index + 1} is not valid JSON`,
        };
      }
      count++;
      if (typeof record.record_sha256 === "string") {
        const { record_sha256, ...rest } = record;
        const computed = createHash("sha256")
          .update(JSON.stringify(rest))
          .digest("hex");
        if (computed !== record_sha256) {
          return {
            valid: false,
            record_count: count,
            tampered_at_index: index,
            tampered_record_id:
              typeof record.record_id === "string" ? record.record_id : undefined,
            reason: `record_sha256 mismatch at line ${index + 1}`,
          };
        }
      }
    }
    return { valid: true, record_count: count };
  }

  pruneArchives(): void {
    // No rotation in this distribution.
  }
}
