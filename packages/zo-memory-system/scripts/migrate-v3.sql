-- zo-memory-system v3 continuation recall migration
-- Adds searchable episode documents and first-class open loops
-- Safe to run multiple times

CREATE TABLE IF NOT EXISTS episode_documents (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS episode_documents_fts USING fts5(
  episode_id UNINDEXED,
  text
);

INSERT INTO episode_documents (episode_id, text, updated_at)
SELECT e.id,
       trim(
         coalesce(e.summary, '') || char(10) ||
         coalesce((SELECT group_concat(entity, ' ') FROM episode_entities ee WHERE ee.episode_id = e.id), '') || char(10) ||
         coalesce(e.metadata, '')
       ),
       strftime('%s','now')
FROM episodes e
WHERE NOT EXISTS (
  SELECT 1 FROM episode_documents d WHERE d.episode_id = e.id
);

INSERT INTO episode_documents_fts (episode_id, text)
SELECT d.episode_id, d.text
FROM episode_documents d
WHERE NOT EXISTS (
  SELECT 1 FROM episode_documents_fts f WHERE f.episode_id = d.episode_id
);

CREATE TABLE IF NOT EXISTS open_loops (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL DEFAULT 'shared',
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'task' CHECK(kind IN ('task','bug','incident','approval','commitment','other')),
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved','stale','superseded')),
  priority REAL DEFAULT 0.6,
  entity TEXT,
  source TEXT,
  related_episode_id TEXT REFERENCES episodes(id) ON DELETE SET NULL,
  fingerprint TEXT NOT NULL,
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  updated_at INTEGER DEFAULT (strftime('%s','now')),
  resolved_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_open_loops_status_updated ON open_loops(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_open_loops_entity ON open_loops(entity);
CREATE INDEX IF NOT EXISTS idx_open_loops_persona ON open_loops(persona);
CREATE UNIQUE INDEX IF NOT EXISTS idx_open_loops_active_fingerprint ON open_loops(fingerprint, status);

CREATE VIRTUAL TABLE IF NOT EXISTS open_loops_fts USING fts5(
  loop_id UNINDEXED,
  text
);
