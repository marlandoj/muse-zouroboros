#!/usr/bin/env bun
/**
 * ensure-backend.ts — Auto-initialize a memory backend DB
 *
 * Creates the DB file, runs schema.sql + migrations if the DB doesn't exist
 * or is missing required tables. Idempotent — safe to call on every gate request.
 */

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";

const SCRIPTS_DIR = dirname(import.meta.path);
const SCHEMA_FILE = join(SCRIPTS_DIR, "schema.sql");
const MIGRATIONS = [
  join(SCRIPTS_DIR, "migrate-v2.sql"),
  join(SCRIPTS_DIR, "migrate-v3.sql"),
];

const initialized = new Set<string>();

export function ensureBackendDb(dbPath: string): void {
  if (initialized.has(dbPath)) return;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const isNew = !existsSync(dbPath);
  const db = new Database(dbPath);

  try {
    db.exec("PRAGMA journal_mode = WAL");

    if (isNew) {
      const schema = readFileSync(SCHEMA_FILE, "utf-8");
      db.exec(schema);
      for (const migration of MIGRATIONS) {
        if (existsSync(migration)) {
          db.exec(readFileSync(migration, "utf-8"));
        }
      }
    } else {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r: any) => r.name);

      const required = ["facts", "fact_embeddings", "episodes", "episode_entities", "procedures", "open_loops"];
      const missing = required.filter(t => !tables.includes(t));

      if (missing.length > 0) {
        const schema = readFileSync(SCHEMA_FILE, "utf-8");
        db.exec(schema);
        for (const migration of MIGRATIONS) {
          if (existsSync(migration)) {
            db.exec(readFileSync(migration, "utf-8"));
          }
        }
      }
    }

    initialized.add(dbPath);
  } finally {
    db.close();
  }
}

export function isBackendInitialized(dbPath: string): boolean {
  return initialized.has(dbPath);
}

export function getBackendStatus(dbPath: string): { exists: boolean; tables: number; facts: number } {
  if (!existsSync(dbPath)) return { exists: false, tables: 0, facts: 0 };
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.prepare("SELECT count(*) as c FROM sqlite_master WHERE type='table'").get() as { c: number };
    let facts = 0;
    try {
      facts = (db.prepare("SELECT count(*) as c FROM facts").get() as { c: number }).c;
    } catch {}
    return { exists: true, tables: tables.c, facts };
  } finally {
    db.close();
  }
}
