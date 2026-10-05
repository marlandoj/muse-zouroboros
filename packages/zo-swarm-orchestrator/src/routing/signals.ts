import { Database } from 'bun:sqlite';
import { getMemoryDbPath } from 'zouroboros-core';
import { getDb } from '../db/schema.js';
import type { Task } from '../types.js';

/** Persist package-runtime outcomes and read existing procedural memory without writing it. */
export class RoutingSignals {
  constructor(private dbPath?: string, private memoryPath = getMemoryDbPath()) {}

  history(executor: string, task: Task): number {
    const row = getDb(this.dbPath).query(
      'SELECT attempts, successes FROM routing_history WHERE executor = ? AND category = ?',
    ).get(executor, task.memoryMetadata?.category || 'general') as { attempts: number; successes: number } | null;
    return row && row.attempts >= 3 ? row.successes / row.attempts : 0.5;
  }

  procedure(executor: string, task: Task): number {
    let db: Database | undefined;
    try {
      db = new Database(this.memoryPath, { readonly: true });
      const category = task.memoryMetadata?.category;
      const row = db.query(`SELECT count(*) AS attempts,
        sum(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS successes
        FROM procedures WHERE executor = ?${category ? ' AND category = ?' : ''}`)
        .get(...(category ? [executor, category] : [executor])) as { attempts: number; successes: number };
      return row.attempts > 0 ? row.successes / row.attempts : 0.5;
    } catch {
      return 0.5; // Optional memory unavailable or predates procedural schema.
    } finally { db?.close(); }
  }

  record(executor: string, task: Task, success: boolean): void {
    getDb(this.dbPath).query(`INSERT INTO routing_history (executor, category, attempts, successes)
      VALUES (?, ?, 1, ?) ON CONFLICT(executor, category) DO UPDATE SET
      attempts = attempts + 1, successes = successes + excluded.successes`)
      .run(executor, task.memoryMetadata?.category || 'general', success ? 1 : 0);
  }
}
