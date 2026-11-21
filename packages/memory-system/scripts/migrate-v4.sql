-- migrate-v4.sql — Intelligence plane (Track 1, 2026-10-14)
-- Adds: memory_audit (per-access audit trail), fact_promotions (append-only
-- promotion ledger), fact_forgotten (reversible forgetting).
-- Idempotent; rollback in rollback-v4.sql.

CREATE TABLE IF NOT EXISTS memory_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor TEXT NOT NULL,
  scope TEXT NOT NULL,
  action TEXT NOT NULL,
  fact_id TEXT,
  call_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_memory_audit_actor ON memory_audit(actor, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_audit_fact ON memory_audit(fact_id);
CREATE INDEX IF NOT EXISTS idx_memory_audit_action ON memory_audit(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_audit_call ON memory_audit(call_id);

CREATE TABLE IF NOT EXISTS fact_promotions (
  id TEXT PRIMARY KEY,
  fact_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  stage TEXT NOT NULL CHECK(stage IN ('capture', 'extraction', 'review', 'promotion')),
  decided_by TEXT NOT NULL,
  decided_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  contradiction_of TEXT REFERENCES facts(id),
  created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_fact_promotions_fact ON fact_promotions(fact_id, decided_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_promotions_stage ON fact_promotions(stage, decided_at DESC);

CREATE TABLE IF NOT EXISTS fact_forgotten (
  fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  forgotten_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
  forgotten_by TEXT NOT NULL,
  reason TEXT,
  retention_score REAL
);
CREATE INDEX IF NOT EXISTS idx_fact_forgotten_at ON fact_forgotten(forgotten_at);
