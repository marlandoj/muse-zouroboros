-- Rollback v2 migration: Remove episodic + procedural memory tables
-- WARNING: This will destroy all episode and procedure data

DROP TABLE IF EXISTS procedure_episodes;
DROP TABLE IF EXISTS episode_entities;
DROP TABLE IF EXISTS episodes;
DROP TABLE IF EXISTS procedures;

DROP INDEX IF EXISTS idx_episodes_outcome;
DROP INDEX IF EXISTS idx_episodes_happened;
DROP INDEX IF EXISTS idx_episode_entities_entity;
DROP INDEX IF EXISTS idx_procedures_name;
