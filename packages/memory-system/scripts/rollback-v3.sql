-- Rollback v3 continuation recall migration
-- WARNING: This will destroy episode search documents and open loop data

DROP TABLE IF EXISTS open_loops_fts;
DROP INDEX IF EXISTS idx_open_loops_active_fingerprint;
DROP INDEX IF EXISTS idx_open_loops_persona;
DROP INDEX IF EXISTS idx_open_loops_entity;
DROP INDEX IF EXISTS idx_open_loops_status_updated;
DROP TABLE IF EXISTS open_loops;

DROP TABLE IF EXISTS episode_documents_fts;
DROP TABLE IF EXISTS episode_documents;
