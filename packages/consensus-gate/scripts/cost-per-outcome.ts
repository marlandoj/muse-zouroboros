/**
 * Per-outcome cost ($/resolved-task) for the consensus gate (P2-6, zou-cost-p2-6).
 *
 * AIEWF §6 (Arize / Cursor): token spend does not correlate with shipped value.
 * Rank models by $/RESOLVED-TASK (spend on gate runs that PASSED ÷ passed-run
 * count), not $/call — per-outcome ranking can FLIP the per-token ranking, so a
 * model that is cheap per call but rarely passes can cost more per shipped
 * decision than a pricier model that passes first time.
 *
 * This module is PURE: it takes plain cost rows + verdict rows (already loaded
 * elsewhere), joins them by gate_run_id, and returns the breakdown. No fs / db /
 * network, no import side effects. The CLI that loads swarm.db + the verdict log
 * lives below `import.meta.main` (it does not run on import).
 *
 * ADVISORY ONLY — read-only over the data; emits no routing signal.
 */

export interface CostRow {
  runId: string | null;
  model: string;
  /** provider/vendor prefix, used as the "tier" grouping (xai / hf / syn / …) */
  vendor: string;
  costUsd: number;
  /** epoch ms (cost_ledger.ts) — only used for the estimated proximity backfill */
  ts: number;
}

export interface VerdictRow {
  /** the join key (present only on runs after COST_OUTCOME_JOIN landed) */
  gateRunId: string | null;
  consensusId: string;
  status: string;
  /** ISO timestamp (consensus-gate.log) — only used for the estimated backfill */
  timestamp: string;
}

export interface OutcomeBucket {
  runs: number;
  totalUsd: number;
  usdPerRun: number;
}

export interface PerModelStat {
  model: string;
  tier: string;
  calls: number;
  totalUsd: number;
  usdPerCall: number;
  /** runs that PASSED in which this model participated */
  passedRuns: number;
  /** this model's spend across passed runs */
  passedUsd: number;
  /** $/resolved-task for this model; null when it never appeared in a passed run */
  usdPerPassedRun: number | null;
}

export interface RankFlip {
  byCall: string[];
  byResolved: string[];
  flipped: boolean;
}

export interface CostPerOutcome {
  joinedRuns: number;
  unjoinedCostRuns: number;
  unjoinedVerdicts: number;
  byOutcome: Record<string, OutcomeBucket>;
  /** headline: $/resolved-task = passed bucket usdPerRun (null when nothing passed) */
  resolvedTaskUsd: number | null;
  byModel: PerModelStat[];
  byTier: PerModelStat[];
  rankFlip: RankFlip | null;
  /** true when these numbers include proximity-estimated joins (never the headline) */
  estimated: boolean;
}

const PASSED = "passed";

function round(n: number, dp = 6): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Group cost rows by runId; drop rows with no runId (cannot be joined). */
function indexCostByRun(costRows: CostRow[]): Map<string, CostRow[]> {
  const m = new Map<string, CostRow[]>();
  for (const r of costRows) {
    if (!r.runId) continue;
    const arr = m.get(r.runId);
    if (arr) arr.push(r);
    else m.set(r.runId, [r]);
  }
  return m;
}

/**
 * Join cost rows to verdicts by gate_run_id and aggregate $/resolved-task.
 *
 * EXACT mode (default): only verdicts whose gateRunId matches a cost run are
 * joined. PROXIMITY mode (opts.proximityMs > 0): unjoined verdicts are matched
 * to the nearest *still-unclaimed* cost run within the window — this is the
 * estimated backfill for historical rows that predate the join key. The result
 * is flagged estimated=true so it is never mistaken for the exact headline.
 */
export function computeCostPerOutcome(
  costRows: CostRow[],
  verdicts: VerdictRow[],
  opts: { proximityMs?: number } = {}
): CostPerOutcome {
  const proximityMs = opts.proximityMs ?? 0;
  const byRun = indexCostByRun(costRows);

  // run_id -> the verdict that owns it (exact join first)
  const runToVerdict = new Map<string, VerdictRow>();
  const claimedRuns = new Set<string>();
  const unmatchedVerdicts: VerdictRow[] = [];

  for (const v of verdicts) {
    if (v.gateRunId && byRun.has(v.gateRunId)) {
      runToVerdict.set(v.gateRunId, v);
      claimedRuns.add(v.gateRunId);
    } else {
      unmatchedVerdicts.push(v);
    }
  }

  let estimated = false;
  if (proximityMs > 0 && unmatchedVerdicts.length) {
    // candidate cost runs not yet claimed, with a representative ts (min row ts)
    const freeRuns: { runId: string; ts: number }[] = [];
    for (const [runId, rows] of byRun) {
      if (claimedRuns.has(runId)) continue;
      freeRuns.push({ runId, ts: Math.min(...rows.map((r) => r.ts)) });
    }
    for (const v of unmatchedVerdicts) {
      const vt = Date.parse(v.timestamp);
      if (Number.isNaN(vt)) continue;
      let best: { runId: string; d: number } | null = null;
      for (const fr of freeRuns) {
        if (claimedRuns.has(fr.runId)) continue;
        const d = Math.abs(fr.ts - vt);
        if (d <= proximityMs && (!best || d < best.d)) best = { runId: fr.runId, d };
      }
      if (best) {
        runToVerdict.set(best.runId, v);
        claimedRuns.add(best.runId);
        estimated = true;
      }
    }
  }

  // ---- aggregate ----
  const byOutcome: Record<string, OutcomeBucket> = {};
  // model -> running stats
  const modelAgg = new Map<
    string,
    { tier: string; calls: number; totalUsd: number; passedRuns: number; passedUsd: number }
  >();
  // a model can appear multiple times in one run (fallbacks) — count passedRuns
  // once per (model, run), so track which runs we already credited
  const modelPassedRunSeen = new Map<string, Set<string>>();

  for (const [runId, rows] of byRun) {
    const verdict = runToVerdict.get(runId);
    const runUsd = rows.reduce((s, r) => s + r.costUsd, 0);

    if (verdict) {
      const b = (byOutcome[verdict.status] ??= { runs: 0, totalUsd: 0, usdPerRun: 0 });
      b.runs += 1;
      b.totalUsd += runUsd;
    }

    const isPassed = verdict?.status === PASSED;
    for (const r of rows) {
      const a =
        modelAgg.get(r.model) ??
        (modelAgg.set(r.model, {
          tier: r.vendor,
          calls: 0,
          totalUsd: 0,
          passedRuns: 0,
          passedUsd: 0,
        }),
        modelAgg.get(r.model)!);
      a.calls += 1;
      a.totalUsd += r.costUsd;
      if (isPassed) {
        a.passedUsd += r.costUsd;
        let seen = modelPassedRunSeen.get(r.model);
        if (!seen) modelPassedRunSeen.set(r.model, (seen = new Set()));
        if (!seen.has(runId)) {
          seen.add(runId);
          a.passedRuns += 1;
        }
      }
    }
  }

  for (const b of Object.values(byOutcome)) {
    b.totalUsd = round(b.totalUsd);
    b.usdPerRun = b.runs ? round(b.totalUsd / b.runs) : 0;
  }

  const byModel: PerModelStat[] = [...modelAgg.entries()]
    .map(([model, a]) => ({
      model,
      tier: a.tier,
      calls: a.calls,
      totalUsd: round(a.totalUsd),
      usdPerCall: a.calls ? round(a.totalUsd / a.calls) : 0,
      passedRuns: a.passedRuns,
      passedUsd: round(a.passedUsd),
      usdPerPassedRun: a.passedRuns ? round(a.passedUsd / a.passedRuns) : null,
    }))
    .sort((x, y) => y.totalUsd - x.totalUsd);

  const byTier = rollupTier(byModel);
  const rankFlip = computeRankFlip(byModel);

  const passedBucket = byOutcome[PASSED];
  return {
    joinedRuns: runToVerdict.size,
    unjoinedCostRuns: byRun.size - runToVerdict.size,
    unjoinedVerdicts: verdicts.length - runToVerdict.size,
    byOutcome,
    resolvedTaskUsd: passedBucket ? passedBucket.usdPerRun : null,
    byModel,
    byTier,
    rankFlip,
    estimated,
  };
}

function rollupTier(byModel: PerModelStat[]): PerModelStat[] {
  const m = new Map<string, PerModelStat>();
  for (const s of byModel) {
    const t =
      m.get(s.tier) ??
      (m.set(s.tier, {
        model: s.tier,
        tier: s.tier,
        calls: 0,
        totalUsd: 0,
        usdPerCall: 0,
        passedRuns: 0,
        passedUsd: 0,
        usdPerPassedRun: null,
      }),
      m.get(s.tier)!);
    t.calls += s.calls;
    t.totalUsd = round(t.totalUsd + s.totalUsd);
    t.passedRuns += s.passedRuns;
    t.passedUsd = round(t.passedUsd + s.passedUsd);
  }
  for (const t of m.values()) {
    t.usdPerCall = t.calls ? round(t.totalUsd / t.calls) : 0;
    t.usdPerPassedRun = t.passedRuns ? round(t.passedUsd / t.passedRuns) : null;
  }
  return [...m.values()].sort((a, b) => b.totalUsd - a.totalUsd);
}

/**
 * The Cursor headline: order models by $/call vs by $/resolved-task. If the
 * orderings differ, per-outcome ranking has FLIPPED per-token ranking. Models
 * that never appear in a passed run (usdPerPassedRun === null) sort LAST in the
 * resolved ordering (infinitely expensive per outcome).
 */
export function computeRankFlip(byModel: PerModelStat[]): RankFlip | null {
  const ranked = byModel.filter((m) => m.calls > 0);
  if (ranked.length < 2) return null;
  const byCall = [...ranked].sort((a, b) => a.usdPerCall - b.usdPerCall).map((m) => m.model);
  const byResolved = [...ranked]
    .sort((a, b) => {
      const av = a.usdPerPassedRun ?? Infinity;
      const bv = b.usdPerPassedRun ?? Infinity;
      if (av !== bv) return av - bv;
      return a.usdPerCall - b.usdPerCall;
    })
    .map((m) => m.model);
  const flipped = byCall.some((m, i) => m !== byResolved[i]);
  return { byCall, byResolved, flipped };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI (advisory, read-only). Loads cost_ledger + the verdict log, joins, prints.
// Guarded by import.meta.main → no side effects on import.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse "7d" / "24h" / "30m" / ISO into an epoch-ms lower bound (or 0). */
function parseSince(s: string | undefined): number {
  if (!s) return 0;
  const rel = s.match(/^(\d+)([dhm])$/);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2] === "d" ? 86400000 : rel[2] === "h" ? 3600000 : 60000;
    return Date.now() - n * unit;
  }
  const t = Date.parse(s);
  return Number.isNaN(t) ? 0 : t;
}

function fmtUsd(n: number | null): string {
  if (n == null) return "  —    ";
  return `$${n.toFixed(5)}`;
}

function renderTable(out: CostPerOutcome): string {
  const L: string[] = [];
  L.push(`Join: ${out.joinedRuns} run(s)  |  unjoined cost-runs: ${out.unjoinedCostRuns}  |  unjoined verdicts: ${out.unjoinedVerdicts}${out.estimated ? "  |  ⚠ INCLUDES ESTIMATED (proximity) JOINS" : ""}`);
  L.push("");
  L.push("By outcome:");
  for (const [status, b] of Object.entries(out.byOutcome).sort()) {
    L.push(`  ${status.padEnd(10)} runs=${String(b.runs).padStart(4)}  total=${fmtUsd(b.totalUsd)}  $/run=${fmtUsd(b.usdPerRun)}`);
  }
  L.push("");
  L.push(`$/resolved-task (passed bucket $/run): ${fmtUsd(out.resolvedTaskUsd)}`);
  L.push("");
  L.push("By model — $/call vs $/resolved-task:");
  L.push(`  ${"model".padEnd(34)} ${"calls".padStart(5)} ${"$/call".padStart(10)} ${"passedRuns".padStart(11)} ${"$/resolved".padStart(11)}`);
  for (const m of out.byModel) {
    L.push(`  ${m.model.padEnd(34)} ${String(m.calls).padStart(5)} ${fmtUsd(m.usdPerCall).padStart(10)} ${String(m.passedRuns).padStart(11)} ${fmtUsd(m.usdPerPassedRun).padStart(11)}`);
  }
  if (out.rankFlip) {
    L.push("");
    if (out.rankFlip.flipped) {
      L.push("⚠ RANK FLIP — per-outcome ranking differs from per-token ranking:");
      L.push(`    by $/call     : ${out.rankFlip.byCall.join(" < ")}`);
      L.push(`    by $/resolved : ${out.rankFlip.byResolved.join(" < ")}`);
    } else {
      L.push("No rank flip: $/call ordering == $/resolved-task ordering.");
    }
  }
  return L.join("\n");
}

if (import.meta.main) {
  const { Database } = await import("bun:sqlite");
  const fs = await import("node:fs");

  const argv = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (name: string) => argv.includes(name);

  const since = parseSince(arg("--since"));
  const asJson = has("--json");
  const includeEstimated = has("--include-estimated");
  const proximityMs = Number(arg("--proximity-ms") ?? 5000);

  const COST_DB = process.env.ZO_SWARM_DB || "/home/workspace/.swarm/swarm.db";
  const LOG = `${process.env.HOME}/.zouroboros/consensus-gate.log`;
  const ARTIFACT = `${process.env.HOME}/.zouroboros/cost-per-outcome.json`;

  // cost rows
  const db = new Database(COST_DB, { readonly: true });
  const rows = db
    .query(
      `SELECT run_id as runId, model, vendor, cost_usd as costUsd, ts
       FROM cost_ledger WHERE source='consensus-gate' AND ts >= ? ORDER BY ts`
    )
    .all(since) as CostRow[];
  db.close();

  // verdicts from the JSONL log
  const verdicts: VerdictRow[] = [];
  if (fs.existsSync(LOG)) {
    for (const line of fs.readFileSync(LOG, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const d = JSON.parse(line);
        const ts = Date.parse(d.timestamp);
        if (!Number.isNaN(ts) && ts < since) continue;
        verdicts.push({
          gateRunId: d.gate_run_id ?? null,
          consensusId: d.consensus_id ?? "",
          status: d.status ?? "unknown",
          timestamp: d.timestamp ?? "",
        });
      } catch { /* skip malformed line */ }
    }
  }

  const out = computeCostPerOutcome(rows, verdicts, {
    proximityMs: includeEstimated ? proximityMs : 0,
  });

  fs.mkdirSync(`${process.env.HOME}/.zouroboros`, { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify({ generatedAt: new Date().toISOString(), ...out }, null, 2));

  if (asJson) {
    console.log(JSON.stringify(out, null, 2));
  } else {
    console.log(renderTable(out));
    console.log(`\nArtifact written: ${ARTIFACT}`);
  }
}
