#!/usr/bin/env bun
/**
 * T1 (SF-P3 / ZOU-435) — Learned Auto-Approval: per-archetype outcome-credit reputation.
 *
 * Pure & deterministic (no LLM, no network, no I/O). Reads the resolved approval
 * ledger (approved = PR merged / ticket completed; rejected = PR closed / ticket
 * canceled) and derives, per archetype, an *earned* auto-lane baseline: an archetype
 * qualifies for the SF-002 auto-promote lane on its OWN track record (≥N distinct
 * resolved tickets at ≥R approval rate) instead of the single flat global
 * ≥20-decision baseline that AUTO_PROMOTE_MIN_BASELINE hard-codes today. That flat
 * baseline is the "hand-tuned threshold" ZOU-435 replaces with outcome credit.
 *
 * Reputation NEVER overrides the hard blast-radius ceiling (medium-only, ≤10 files,
 * no schema/secret/infra contact) — it only replaces the *baseline-sufficiency*
 * check inside autoPromoteEligible.
 *
 * Distinct-ticket dedup is mandatory. The ledger is inflated by hourly re-dispatch
 * (correlated verdicts per ticket — 202 pending / 559 raw rows at authoring time), so
 * raw row counts would over-credit an archetype. Gating uses distinct resolved
 * tickets, mirroring agreementStats.distinct_tickets_resolved. A ticket counts as
 * approved only if NONE of its resolved verdicts were rejected (conservative: any
 * rejection taints the ticket).
 */

import type { LedgerEntry } from "./approval-ledger";

// ─── Tunables (learned baseline; NOT a per-run knob — set once, audited) ─────────

export const REPUTATION_MIN_TICKETS = 8; // distinct resolved tickets before an archetype earns the lane
export const REPUTATION_MIN_RATE = 0.9; // distinct approval-rate floor

export interface ReputationOpts {
  minTickets?: number;
  minRate?: number;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReputationBucket {
  archetype: string;
  resolved: number; // raw resolved rows (re-dispatch-inflated)
  approved: number;
  rejected: number;
  approval_rate: number | null; // raw approved/resolved
  distinct_tickets: number; // distinct resolved tickets (dedup)
  distinct_approved: number; // distinct tickets with NO rejected verdict
  distinct_rejected: number; // distinct tickets with ≥1 rejected verdict
  distinct_rate: number | null; // distinct_approved / distinct_tickets — the gated metric
}

export interface ReputationBaseline {
  source: "reputation";
  archetype: string;
  eligible: boolean;
  cold_start: boolean;
  distinct_tickets: number;
  distinct_rate: number | null;
  resolved: number;
  reasons: string[];
}

// ─── Core (pure) ────────────────────────────────────────────────────────────────

/**
 * Build a per-archetype reputation table from the resolved ledger. `entries` is the
 * latest-row-wins map produced by readLedger(); pending rows are ignored.
 */
export function computeReputation(entries: Map<string, LedgerEntry>): Map<string, ReputationBucket> {
  // raw counters + per-(archetype,ticket) taint tracking for distinct dedup
  const raw = new Map<string, { approved: number; rejected: number }>();
  const tickets = new Map<string, Map<string, { approved: boolean; rejected: boolean }>>();

  for (const e of entries.values()) {
    const ov = e.operator_verdict;
    if (ov !== "approved" && ov !== "rejected") continue; // pending / unresolved
    const arch = e.verdict.inputs?.archetype ?? "unknown";
    const ticketId = e.verdict.ticket_id;

    const r = raw.get(arch) ?? { approved: 0, rejected: 0 };
    r[ov]++;
    raw.set(arch, r);

    let byTicket = tickets.get(arch);
    if (!byTicket) {
      byTicket = new Map();
      tickets.set(arch, byTicket);
    }
    const t = byTicket.get(ticketId) ?? { approved: false, rejected: false };
    if (ov === "approved") t.approved = true;
    else t.rejected = true;
    byTicket.set(ticketId, t);
  }

  const table = new Map<string, ReputationBucket>();
  for (const [arch, r] of raw) {
    const resolved = r.approved + r.rejected;
    const byTicket = tickets.get(arch)!;
    let dApproved = 0;
    let dRejected = 0;
    for (const t of byTicket.values()) {
      // a ticket is credited only when it was never rejected (conservative)
      if (t.rejected) dRejected++;
      else if (t.approved) dApproved++;
    }
    const distinct = dApproved + dRejected;
    table.set(arch, {
      archetype: arch,
      resolved,
      approved: r.approved,
      rejected: r.rejected,
      approval_rate: resolved > 0 ? Number((r.approved / resolved).toFixed(3)) : null,
      distinct_tickets: distinct,
      distinct_approved: dApproved,
      distinct_rejected: dRejected,
      distinct_rate: distinct > 0 ? Number((dApproved / distinct).toFixed(3)) : null,
    });
  }
  return table;
}

/**
 * Earned-baseline decision for a single archetype. Eligible iff the archetype has
 * ≥minTickets distinct resolved tickets AND distinct approval-rate ≥minRate.
 * Unknown / thin archetypes are cold-start (never eligible → falls back to the flat
 * global baseline at the caller when advisory, blocks when enforced).
 */
export function reputationGate(
  archetype: string,
  table: Map<string, ReputationBucket>,
  opts: ReputationOpts = {}
): ReputationBaseline {
  const minTickets = opts.minTickets ?? REPUTATION_MIN_TICKETS;
  const minRate = opts.minRate ?? REPUTATION_MIN_RATE;
  const b = table.get(archetype);

  if (!b || b.distinct_tickets < minTickets) {
    const n = b?.distinct_tickets ?? 0;
    return {
      source: "reputation",
      archetype,
      eligible: false,
      cold_start: true,
      distinct_tickets: n,
      distinct_rate: b?.distinct_rate ?? null,
      resolved: b?.resolved ?? 0,
      reasons: [`cold-start: ${n}/${minTickets} distinct resolved tickets for '${archetype}'`],
    };
  }
  if (b.distinct_rate === null || b.distinct_rate < minRate) {
    return {
      source: "reputation",
      archetype,
      eligible: false,
      cold_start: false,
      distinct_tickets: b.distinct_tickets,
      distinct_rate: b.distinct_rate,
      resolved: b.resolved,
      reasons: [
        `approval rate ${b.distinct_rate ?? "n/a"} < floor ${minRate} (${b.distinct_approved}/${b.distinct_tickets} distinct tickets)`,
      ],
    };
  }
  return {
    source: "reputation",
    archetype,
    eligible: true,
    cold_start: false,
    distinct_tickets: b.distinct_tickets,
    distinct_rate: b.distinct_rate,
    resolved: b.resolved,
    reasons: [
      `earned: ${b.distinct_approved}/${b.distinct_tickets} distinct tickets @ ${b.distinct_rate} ≥ ${minRate}`,
    ],
  };
}

export function reputationBaselineForVerdict(
  verdict: { inputs: { archetype: string } },
  table: Map<string, ReputationBucket>,
  opts: ReputationOpts = {}
): ReputationBaseline {
  return reputationGate(verdict.inputs.archetype, table, opts);
}

// ─── Report formatting (advisory) ────────────────────────────────────────────────

export function formatReputation(table: Map<string, ReputationBucket>, opts: ReputationOpts = {}): string {
  const minTickets = opts.minTickets ?? REPUTATION_MIN_TICKETS;
  const minRate = opts.minRate ?? REPUTATION_MIN_RATE;
  const rows: string[] = [];
  rows.push("# SF-002 Learned Auto-Approval — Per-Archetype Reputation");
  rows.push("");
  rows.push(`**Generated:** ${new Date().toISOString()}`);
  rows.push(`**Gate:** distinct tickets ≥ ${minTickets} AND distinct approval-rate ≥ ${minRate}`);
  rows.push("");
  rows.push("| Archetype | Distinct tickets | Distinct rate | Raw resolved | Raw rate | Earned auto-lane |");
  rows.push("|-----------|------------------|---------------|--------------|----------|------------------|");
  const sorted = [...table.values()].sort((a, b) => b.distinct_tickets - a.distinct_tickets);
  for (const b of sorted) {
    const gate = reputationGate(b.archetype, table, opts);
    const status = gate.eligible ? "✅ EARNED" : gate.cold_start ? `cold-start (${b.distinct_tickets}/${minTickets})` : `below-rate`;
    rows.push(
      `| ${b.archetype} | ${b.distinct_tickets} (${b.distinct_approved}✓/${b.distinct_rejected}✗) | ${b.distinct_rate ?? "n/a"} | ${b.resolved} | ${b.approval_rate ?? "n/a"} | ${status} |`
    );
  }
  if (sorted.length === 0) rows.push("| _(no resolved decisions yet)_ | — | — | — | — | — |");
  rows.push("");
  rows.push(
    "> Reputation replaces the flat global ≥20-decision baseline in the SF-002 auto-promote lane " +
      "(`SF002_REPUTATION_ENFORCE`). The hard blast-radius ceiling (medium-only, ≤10 files, no " +
      "schema/secret/infra) is retained unconditionally — reputation only widens the *baseline* gate."
  );
  return rows.join("\n");
}
