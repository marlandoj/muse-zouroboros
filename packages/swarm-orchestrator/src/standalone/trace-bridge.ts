import { readFileSync } from "fs";

/**
 * Resolve the active gate trace_id for outbound swarm dispatches.
 *
 * mcp-server is a long-running stdio process whose `process.env` is fixed at
 * startup, so a gate spawned in a different terminal cannot reach us via env
 * inheritance. The gate writes `/tmp/zo-trace-id` (sentinel) on every call;
 * we read it at dispatch time. `process.env.ZO_TRACE_ID` still wins when set
 * (e.g. when mcp-server itself was launched from a gate-spawned shell).
 */
export function resolveTraceId(): string | undefined {
  if (process.env.ZO_TRACE_ID) return process.env.ZO_TRACE_ID;
  try { return readFileSync("/tmp/zo-trace-id", "utf-8").trim() || undefined; }
  catch { return undefined; }
}
