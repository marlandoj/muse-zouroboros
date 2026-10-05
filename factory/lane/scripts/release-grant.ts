/**
 * ZOU-1568 — Operator release grants for SF-002 approval holds.
 *
 * Releasing a held execution never spawns an executor: the record flips to
 * `executing`, the reaper (aging from dispatch-time `started_at`) reaps it as a
 * stall, and the recovery retry re-runs SF-002 classification with no memory of
 * the operator's sign-off — so every high-tier retry re-parks at the gate.
 *
 * A ReleaseGrant persists the operator's sign-off across that reap/retry
 * boundary: `hold-notify.ts release` writes one when the released hold came
 * from the approval gate, and the next dispatch of the same ticket consumes it
 * (single-use, expiring, tier-bound) to execute instead of re-holding.
 *
 * Fail-closed contract: a missing, expired, already-consumed, tier-escalated,
 * or unreadable grant never bypasses the gate — callers hold exactly as before.
 * SLO-gate and failure-streak holds never produce grants.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { factoryStateRoot } from "./factory-state-root";

export type GrantTier = "low" | "medium" | "high";

export interface ReleaseGrant {
  identifier: string;
  ticket_id: string | null;
  source_execution_id: string;
  tier: GrantTier;
  granted_by: string;
  granted_at: string;
  expires_at: string;
  note: string | null;
  consumed_by: string | null;
  consumed_at: string | null;
}

export const RELEASE_GRANT_TTL_MS = 72 * 60 * 60 * 1000;

const TIER_RANK: Record<GrantTier, number> = { low: 0, medium: 1, high: 2 };

export function normalizeGrantTier(tier: string): GrantTier {
  return tier === "low" || tier === "medium" || tier === "high" ? tier : "high";
}

export function releaseGrantPath(identifier: string, stateDir = factoryStateRoot()): string {
  const safe = identifier.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(stateDir, `release-grant-${safe}.json`);
}

export interface WriteReleaseGrantInput {
  identifier: string;
  ticket_id: string | null;
  source_execution_id: string;
  tier: string;
  granted_by: string;
  note?: string | null;
}

/** Persist a fresh single-use grant, replacing any prior grant for the ticket. */
export function writeReleaseGrant(
  input: WriteReleaseGrantInput,
  stateDir = factoryStateRoot(),
  nowMs = Date.now(),
): ReleaseGrant {
  const grant: ReleaseGrant = {
    identifier: input.identifier,
    ticket_id: input.ticket_id,
    source_execution_id: input.source_execution_id,
    tier: normalizeGrantTier(input.tier),
    granted_by: input.granted_by,
    granted_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + RELEASE_GRANT_TTL_MS).toISOString(),
    note: input.note ?? null,
    consumed_by: null,
    consumed_at: null,
  };
  const path = releaseGrantPath(input.identifier, stateDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(grant, null, 2));
  renameSync(tmp, path);
  return grant;
}

export function loadReleaseGrant(identifier: string, stateDir = factoryStateRoot()): ReleaseGrant | null {
  const path = releaseGrantPath(identifier, stateDir);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as ReleaseGrant;
  if (!parsed || parsed.identifier !== identifier) return null;
  return parsed;
}

/**
 * Consume the grant for a dispatch, or explain why it does not apply.
 * Consumption is recorded durably BEFORE the caller acts on it, so a crash
 * after consumption can only under-approve, never double-approve.
 */
export function consumeReleaseGrant(
  identifier: string,
  verdictTier: string,
  executionId: string,
  stateDir = factoryStateRoot(),
  nowMs = Date.now(),
): { grant: ReleaseGrant | null; reason: string } {
  const grant = loadReleaseGrant(identifier, stateDir);
  if (!grant) return { grant: null, reason: "no grant on file" };
  if (grant.consumed_by !== null) {
    return { grant: null, reason: `already consumed by ${grant.consumed_by} at ${grant.consumed_at}` };
  }
  if (Date.parse(grant.expires_at) <= nowMs) {
    return { grant: null, reason: `expired at ${grant.expires_at}` };
  }
  const tier = normalizeGrantTier(verdictTier);
  if (TIER_RANK[tier] > TIER_RANK[grant.tier]) {
    return { grant: null, reason: `risk escalated beyond grant (verdict=${tier} > granted=${grant.tier})` };
  }
  const consumed: ReleaseGrant = {
    ...grant,
    consumed_by: executionId,
    consumed_at: new Date(nowMs).toISOString(),
  };
  const path = releaseGrantPath(identifier, stateDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(consumed, null, 2));
  renameSync(tmp, path);
  return { grant: consumed, reason: "consumed" };
}
