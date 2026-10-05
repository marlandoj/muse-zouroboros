-- zo-memory-system v2 migration: Episodic + Procedural Memory
-- Adds episodes, episode_entities, procedures, procedure_episodes tables
-- Safe to run multiple times (CREATE IF NOT EXISTS)

-- Episodes: event-based memory capturing "what happened" with outcomes
CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','resolved','ongoing')),
  happened_at INTEGER NOT NULL,
  duration_ms INTEGER,
  procedure_id TEXT REFERENCES procedures(id),
  metadata TEXT, -- JSON
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Junction table linking episodes to entities
CREATE TABLE IF NOT EXISTS episode_entities (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (episode_id, entity)
);

-- Procedures: workflow patterns that improve through feedback
CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  steps TEXT NOT NULL, -- JSON array of ProcedureStep
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  evolved_from TEXT REFERENCES procedures(id),
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Junction table linking procedures to generating episodes
CREATE TABLE IF NOT EXISTS procedure_episodes (
  procedure_id TEXT NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  PRIMARY KEY (procedure_id, episode_id)
);

-- Capture log (auto-capture pipeline run history)
CREATE TABLE IF NOT EXISTS capture_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  transcript_hash TEXT NOT NULL,
  facts_extracted INTEGER DEFAULT 0,
  facts_skipped INTEGER DEFAULT 0,
  contradictions INTEGER DEFAULT 0,
  model TEXT,
  duration_ms INTEGER,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_capture_log_hash ON capture_log(transcript_hash);
CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
CREATE INDEX IF NOT EXISTS idx_episodes_happened ON episodes(happened_at);
CREATE INDEX IF NOT EXISTS idx_episode_entities_entity ON episode_entities(entity);
CREATE INDEX IF NOT EXISTS idx_procedures_name ON procedures(name);
