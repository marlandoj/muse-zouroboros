-- Zo Persona Memory System Schema
-- SQLite with FTS5 for full-text search
-- No external dependencies required

-- Main facts table
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  persona TEXT NOT NULL DEFAULT 'shared',
  entity TEXT NOT NULL,
  key TEXT,
  value TEXT NOT NULL,
  text TEXT,
  category TEXT DEFAULT 'fact',
  decay_class TEXT DEFAULT 'stable',
  importance REAL DEFAULT 1.0,
  source TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_accessed INTEGER,
  confidence REAL DEFAULT 1.0,
  metadata TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS facts_fts USING fts5(
  text,
  entity,
  key,
  value,
  category,
  content='facts',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS facts_ai AFTER INSERT ON facts BEGIN
  INSERT INTO facts_fts(rowid, text, entity, key, value, category)
  VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_ad AFTER DELETE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
  VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
END;

CREATE TRIGGER IF NOT EXISTS facts_au AFTER UPDATE ON facts BEGIN
  INSERT INTO facts_fts(facts_fts, rowid, text, entity, key, value, category)
  VALUES ('delete', old.rowid, old.text, old.entity, old.key, old.value, old.category);
  INSERT INTO facts_fts(rowid, text, entity, key, value, category)
  VALUES (new.rowid, new.text, new.entity, new.key, new.value, new.category);
END;

CREATE INDEX IF NOT EXISTS idx_facts_persona ON facts(persona);
CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_facts_decay ON facts(decay_class);
CREATE INDEX IF NOT EXISTS idx_facts_expires ON facts(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_facts_created ON facts(created_at);
CREATE INDEX IF NOT EXISTS idx_facts_lookup ON facts(entity, key);

CREATE TABLE IF NOT EXISTS ttl_defaults (
  decay_class TEXT PRIMARY KEY,
  ttl_seconds INTEGER
);

INSERT OR IGNORE INTO ttl_defaults VALUES
  ('permanent', NULL),
  ('stable', 7776000),
  ('active', 1209600),
  ('session', 86400),
  ('checkpoint', 14400);

CREATE TABLE IF NOT EXISTS fact_links (
  source_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  target_id TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  relation TEXT NOT NULL DEFAULT 'related',
  weight REAL DEFAULT 1.0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  PRIMARY KEY (source_id, target_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_fact_links_source ON fact_links(source_id);
CREATE INDEX IF NOT EXISTS idx_fact_links_target ON fact_links(target_id);

CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id TEXT PRIMARY KEY REFERENCES facts(id) ON DELETE CASCADE,
  embedding BLOB NOT NULL,
  model TEXT DEFAULT 'text-embedding-3-small',
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE TABLE IF NOT EXISTS capture_log (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  transcript_hash TEXT NOT NULL,
  facts_extracted INTEGER,
  facts_skipped INTEGER,
  contradictions INTEGER,
  model TEXT,
  duration_ms INTEGER,
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_capture_log_hash ON capture_log(transcript_hash);

CREATE TABLE IF NOT EXISTS episodes (
  id TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK(outcome IN ('success','failure','resolved','ongoing')),
  happened_at INTEGER NOT NULL,
  duration_ms INTEGER,
  procedure_id TEXT REFERENCES procedures(id),
  metadata TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS episode_entities (
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  entity TEXT NOT NULL,
  PRIMARY KEY (episode_id, entity)
);

CREATE INDEX IF NOT EXISTS idx_episodes_outcome ON episodes(outcome);
CREATE INDEX IF NOT EXISTS idx_episodes_happened ON episodes(happened_at);
CREATE INDEX IF NOT EXISTS idx_episode_entities_entity ON episode_entities(entity);

CREATE TABLE IF NOT EXISTS procedures (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  steps TEXT NOT NULL,
  success_count INTEGER DEFAULT 0,
  failure_count INTEGER DEFAULT 0,
  evolved_from TEXT REFERENCES procedures(id),
  created_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE TABLE IF NOT EXISTS procedure_episodes (
  procedure_id TEXT NOT NULL REFERENCES procedures(id) ON DELETE CASCADE,
  episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  PRIMARY KEY (procedure_id, episode_id)
);

CREATE INDEX IF NOT EXISTS idx_procedures_name ON procedures(name);

CREATE TABLE IF NOT EXISTS episode_documents (
  episode_id TEXT PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  text TEXT NOT NULL,
  updated_at INTEGER DEFAULT (strftime('%s','now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS episode_documents_fts USING fts5(
  episode_id UNINDEXED,
  text
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

-- NotebookLM citation provenance (Adoption 1 — Artem stack)
-- Each `source_chunks` row is a verbatim slice from a NotebookLM source,
-- keyed by md5(cited_text[:100]) per Artem's recipe. `fact_citations` links
-- a synthetic fact_id (qa:{conv}:{turn}) to the chunks that backed the answer.
CREATE TABLE IF NOT EXISTS source_chunks (
  chunk_md5      TEXT PRIMARY KEY,
  source_id      TEXT NOT NULL,
  source_title   TEXT,
  cited_text     TEXT NOT NULL,
  start_char     INTEGER,
  end_char       INTEGER,
  chunk_id       TEXT,
  notebook_id    TEXT NOT NULL,
  agent_slug     TEXT,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  hit_count      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_source_chunks_source   ON source_chunks(source_id);
CREATE INDEX IF NOT EXISTS idx_source_chunks_notebook ON source_chunks(notebook_id);
CREATE INDEX IF NOT EXISTS idx_source_chunks_agent    ON source_chunks(agent_slug);

CREATE TABLE IF NOT EXISTS fact_citations (
  fact_id           TEXT NOT NULL,
  chunk_md5         TEXT NOT NULL REFERENCES source_chunks(chunk_md5) ON DELETE CASCADE,
  citation_number   INTEGER NOT NULL DEFAULT 0,
  source_kind       TEXT NOT NULL DEFAULT 'qa' CHECK (source_kind IN ('qa','fact')),
  conversation_id   TEXT,
  turn_number       INTEGER,
  question          TEXT,
  answer_excerpt    TEXT,
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (fact_id, chunk_md5, citation_number)
);
CREATE INDEX IF NOT EXISTS idx_fact_citations_chunk ON fact_citations(chunk_md5);
CREATE INDEX IF NOT EXISTS idx_fact_citations_kind  ON fact_citations(source_kind);
CREATE INDEX IF NOT EXISTS idx_fact_citations_conv  ON fact_citations(conversation_id, turn_number);

-- Topics-as-hubs (Adoption 4 — Artem stack).
-- Topics are slug-keyed concept hubs. Each Q&A turn extracts 3-7 topics,
-- which are UPSERTed and linked to the synthetic fact_id via fact_topics.
-- Enables queries like "every fact about claude-code" without depending on
-- substring search.
CREATE TABLE IF NOT EXISTS topics (
  id             TEXT PRIMARY KEY,           -- slug (lowercase, hyphenated)
  display_name   TEXT NOT NULL,              -- canonical display form
  description    TEXT,                       -- optional one-line summary
  fact_count     INTEGER NOT NULL DEFAULT 0,
  first_seen_at  INTEGER NOT NULL,
  last_seen_at   INTEGER NOT NULL,
  metadata       TEXT
);
CREATE INDEX IF NOT EXISTS idx_topics_last_seen ON topics(last_seen_at DESC);

CREATE TABLE IF NOT EXISTS fact_topics (
  fact_id     TEXT NOT NULL,
  topic_id    TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  weight      REAL NOT NULL DEFAULT 1.0,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (fact_id, topic_id)
);
CREATE INDEX IF NOT EXISTS idx_fact_topics_topic ON fact_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_fact_topics_fact  ON fact_topics(fact_id);
