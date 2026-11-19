-- rollback-v4.sql — Revert the intelligence-plane migration (migrate-v4.sql).
-- WARNING: dropping fact_forgotten permanently restores all reversibly
-- forgotten facts; dropping memory_audit discards the audit trail.

DROP INDEX IF EXISTS idx_memory_audit_actor;
DROP INDEX IF EXISTS idx_memory_audit_fact;
DROP INDEX IF EXISTS idx_memory_audit_action;
DROP INDEX IF EXISTS idx_memory_audit_call;
DROP TABLE IF EXISTS memory_audit;

DROP INDEX IF EXISTS idx_fact_promotions_fact;
DROP INDEX IF EXISTS idx_fact_promotions_stage;
DROP TABLE IF EXISTS fact_promotions;

DROP INDEX IF EXISTS idx_fact_forgotten_at;
DROP TABLE IF EXISTS fact_forgotten;
