/**
 * Shared SQLite schema for swarm extensions.
 *
 * Uses bun:sqlite for zero-dependency, in-process storage.
 * Tables: swarm_budget, budget_config, budget_per_executor, swarm_heartbeats, swarm_roles, cost_ledger
 */

import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';

const DEFAULT_DB_PATH = join(getWorkspaceRoot(), '.swarm', 'swarm.db');

const _dbs = new Map<string, Database>();

export function getDb(dbPath: string = DEFAULT_DB_PATH): Database {
  const existing = _dbs.get(dbPath);
  if (existing) return existing;

  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);
  db.run('PRAGMA journal_mode = WAL');
  db.run('PRAGMA busy_timeout = 5000');
  initSchema(db);
  _dbs.set(dbPath, db);
  return db;
}

export function closeDb(): void {
  for (const db of _dbs.values()) db.close();
  _dbs.clear();
}

function initSchema(db: Database): void {
  db.run(`CREATE TABLE IF NOT EXISTS routing_history (
    executor TEXT NOT NULL, category TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0, successes INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (executor, category)
  )`);

  db.run(`
    CREATE TABLE IF NOT EXISTS swarm_budget (
      swarm_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      tokens_used INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      updated_at INTEGER DEFAULT (unixepoch()),
      PRIMARY KEY (swarm_id, executor_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS budget_config (
      swarm_id TEXT PRIMARY KEY,
      total_budget_usd REAL NOT NULL,
      alert_threshold_pct REAL DEFAULT 80,
      hard_cap_action TEXT DEFAULT 'downgrade',
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS budget_per_executor (
      swarm_id TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      limit_usd REAL,
      PRIMARY KEY (swarm_id, executor_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS swarm_heartbeats (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      swarm_id TEXT NOT NULL,
      beat_number INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'ok',
      tasks_dispatched INTEGER DEFAULT 0,
      tasks_failed INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (unixepoch())
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS swarm_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      executor_id TEXT NOT NULL,
      model TEXT,
      tags TEXT,
      description TEXT,
      budget_cap_usd REAL,
      inputs TEXT,
      outputs TEXT,
      success_criteria TEXT,
      created_at INTEGER DEFAULT (unixepoch()),
      updated_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Per-call cost ledger shared with the consensus-gate skill — identical DDL
  // on both sides (IF NOT EXISTS), so whichever writer opens the DB first
  // creates it. Feeds the /dashboard Costs tab savings comparison.
  db.run(`
    CREATE TABLE IF NOT EXISTS cost_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts INTEGER NOT NULL,
      source TEXT NOT NULL,
      run_id TEXT,
      label TEXT,
      model TEXT NOT NULL,
      vendor TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      rate_source TEXT,
      estimated INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cost_ledger_ts ON cost_ledger(ts)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cost_ledger_source ON cost_ledger(source)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_cost_ledger_model ON cost_ledger(model)`);

  migrateSwarmRolesSOP(db);
  seedDefaultRoles(db);
  backfillDefaultRoleSOPs(db);
  retireMimirRoleExecutor(db);
}

function migrateSwarmRolesSOP(db: Database): void {
  const cols = db.query(`PRAGMA table_info(swarm_roles)`).all() as { name: string }[];
  const have = new Set(cols.map((c) => c.name));
  if (!have.has('inputs')) db.run(`ALTER TABLE swarm_roles ADD COLUMN inputs TEXT`);
  if (!have.has('outputs')) db.run(`ALTER TABLE swarm_roles ADD COLUMN outputs TEXT`);
  if (!have.has('success_criteria')) db.run(`ALTER TABLE swarm_roles ADD COLUMN success_criteria TEXT`);
}

interface DefaultRoleSeed {
  id: string;
  name: string;
  executor_id: string;
  model: string | null;
  tags: string;
  description: string;
  inputs: string;
  outputs: string;
  success_criteria: string;
}

const DEFAULT_ROLE_SEEDS: DefaultRoleSeed[] = [
  {
    id: 'senior-architect',
    name: 'Senior Architect',
    executor_id: 'claude-code',
    model: 'sonnet',
    tags: '["reasoning","planning","architecture","system-design"]',
    description: 'System design, complex planning, architectural decisions',
    inputs: '{"requirements":"string","constraints":"array"}',
    outputs: '{"design_doc":"string","interfaces":"array"}',
    success_criteria: '["design_doc non-empty","interfaces length >= 1"]',
  },
  {
    id: 'ui-developer',
    name: 'UI Developer',
    executor_id: 'gemini',
    model: 'pro',
    tags: '["ui","frontend","visual","design","css"]',
    description: 'Frontend development, UI/UX, visual work',
    inputs: '{"design_brief":"string","brand_tokens":"object"}',
    outputs: '{"ui_artifacts":"array","component_doc":"string"}',
    success_criteria: '["ui_artifacts non-empty","component_doc non-empty"]',
  },
  {
    id: 'backend-developer',
    name: 'Backend Developer',
    executor_id: 'codex',
    model: 'gpt-5.x',
    tags: '["backend","api","refactor","database","server"]',
    description: 'API development, refactoring, backend systems',
    inputs: '{"task_spec":"string","codebase_context":"string"}',
    outputs: '{"code_diff":"string","test_results":"string"}',
    success_criteria: '["code_diff non-empty","tests pass"]',
  },
  {
    id: 'researcher',
    name: 'Researcher',
    executor_id: 'hermes',
    model: null,
    tags: '["research","web","multi-platform","analysis","investigation"]',
    description: 'Web research, multi-platform analysis, data gathering',
    inputs: '{"research_question":"string","scope":"string"}',
    outputs: '{"findings":"array","sources":"array"}',
    success_criteria: '["findings length >= 1","sources length >= 1"]',
  },
  {
    id: 'junior-developer',
    name: 'Junior Developer',
    executor_id: 'gemini',
    model: 'flash',
    tags: '["simple","quick","edit","fix"]',
    description: 'Simple edits, quick fixes, low-complexity tasks',
    inputs: '{"task_spec":"string","codebase_context":"string"}',
    outputs: '{"code_diff":"string","test_results":"string"}',
    success_criteria: '["code_diff non-empty"]',
  },
  {
    id: 'ops-engineer',
    name: 'Ops Engineer',
    executor_id: 'hermes',
    model: null,
    tags: '["infrastructure","deployment","devops","monitoring","chat"]',
    description: 'Infrastructure, deployment, chat delivery, operations',
    inputs: '{"ops_task":"string","environment":"string"}',
    outputs: '{"action_log":"string","status":"string"}',
    success_criteria: '["action_log non-empty","status non-empty"]',
  },
  {
    id: 'memory-sage',
    name: 'Memory Sage',
    executor_id: 'hermes',
    model: null,
    tags: '["memory","context","sage","recall","history"]',
    description: 'Queries shared memory for historical context relevant to a task and injects institutional knowledge into downstream nodes.',
    inputs: '{"task_context":"string","query_hint":"string"}',
    outputs: '{"recalled_facts":"array","recall_summary":"string"}',
    success_criteria: '["recall_summary non-empty"]',
  },
];

function seedDefaultRoles(db: Database): void {
  const existing = db.query('SELECT COUNT(*) as cnt FROM swarm_roles').get() as { cnt: number };
  if (existing.cnt > 0) return;

  const stmt = db.prepare(
    'INSERT OR IGNORE INTO swarm_roles (id, name, executor_id, model, tags, description, inputs, outputs, success_criteria) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
  );

  for (const r of DEFAULT_ROLE_SEEDS) {
    stmt.run(r.id, r.name, r.executor_id, r.model, r.tags, r.description, r.inputs, r.outputs, r.success_criteria);
  }
}

/**
 * Backfill SOP contracts (inputs/outputs/success_criteria) on the 7 default
 * roles seeded by prior versions of this schema. Only updates rows where the
 * column is NULL, so any operator-supplied custom contracts are preserved.
 * Idempotent.
 */
function backfillDefaultRoleSOPs(db: Database): void {
  const stmt = db.prepare(
    `UPDATE swarm_roles
       SET inputs = COALESCE(inputs, ?),
           outputs = COALESCE(outputs, ?),
           success_criteria = COALESCE(success_criteria, ?),
           updated_at = unixepoch()
     WHERE id = ?
       AND (inputs IS NULL OR outputs IS NULL OR success_criteria IS NULL)`
  );
  for (const r of DEFAULT_ROLE_SEEDS) {
    stmt.run(r.inputs, r.outputs, r.success_criteria, r.id);
  }
}

function retireMimirRoleExecutor(db: Database): void {
  db.run(
    `UPDATE swarm_roles
       SET name = 'Memory Sage',
           executor_id = 'hermes',
           tags = '["memory","context","sage","recall","history"]',
           description = 'Queries shared memory for historical context relevant to a task and injects institutional knowledge into downstream nodes.',
           updated_at = unixepoch()
     WHERE id = 'memory-sage' AND executor_id = 'mimir'`,
  );
}
