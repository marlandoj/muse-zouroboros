#!/usr/bin/env bun
import { parseArgs } from "util";
import * as fs from "fs";

const LOG_PATH = `${process.env.HOME}/.zouroboros/consensus-gate.log`;
const REPUTATION_PATH = `${process.env.HOME}/.zouroboros/reputation.json`;
const OUTCOMES_PATH = `${process.env.HOME}/.zouroboros/trace-outcomes.jsonl`;

// Learned credit assignment: blend LOCAL agreement with DISTANT outcome credit.
// effective_weight = (1-λ)·local + λ·outcome_credit, where λ ramps from 0 →
// MAX_LAMBDA as a voter accumulates outcome-resolved traces. Below
// MIN_OUTCOME_SAMPLES, λ=0 (pure local — zero regression on cold start).
const MIN_OUTCOME_SAMPLES = 10;
const RAMP_TARGET = 50;
const MAX_LAMBDA = 0.5;

export interface OutcomeRecord {
  trace_id: string;
  outcome: "success" | "failure";
  source: string;
  timestamp: string;
}

export interface JoinHealth {
  consensus_rows: number;
  traced_gate_rows: number;
  outcome_rows: number;
  matched_unique_trace_ids: number;
  join_status: "healthy" | "pending" | "failed";
  pending_gate_ids: string[];
  /** @deprecated Use pending_gate_ids. Kept for readers of the pre-remediation artifact. */
  unmatched_gate_ids: string[];
  unmatched_outcome_ids: string[];
  source_counts: Record<string, number>;
}

function readOutcomeRecordsAt(outcomesPath: string): OutcomeRecord[] {
  if (!fs.existsSync(outcomesPath)) return [];
  const records: OutcomeRecord[] = [];
  for (const line of fs.readFileSync(outcomesPath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line) as OutcomeRecord;
      if (rec.trace_id && (rec.outcome === "success" || rec.outcome === "failure")) records.push(rec);
    } catch {
      // skip malformed lines
    }
  }
  return records;
}

function outcomesMapFrom(records: OutcomeRecord[]): Map<string, "success" | "failure"> {
  const map = new Map<string, "success" | "failure">();
  for (const rec of records) {
    if (!map.has(rec.trace_id)) map.set(rec.trace_id, rec.outcome);
  }
  return map;
}

export function calculateJoinHealth(
  consensusEntries: Array<{ trace_id?: unknown }>,
  outcomeRecords: OutcomeRecord[],
): JoinHealth {
  const gateIds = new Set<string>();
  let tracedGateRows = 0;
  for (const entry of consensusEntries) {
    if (typeof entry.trace_id !== "string" || entry.trace_id.length === 0) continue;
    tracedGateRows++;
    gateIds.add(entry.trace_id);
  }

  const outcomeIds = new Set<string>();
  const sourceCounts: Record<string, number> = {};
  for (const record of outcomeRecords) {
    outcomeIds.add(record.trace_id);
    sourceCounts[record.source] = (sourceCounts[record.source] ?? 0) + 1;
  }

  const matched = [...gateIds].filter((id) => outcomeIds.has(id));
  const pendingGateIds = [...gateIds].filter((id) => !outcomeIds.has(id)).sort();
  const unmatchedOutcomeIds = [...outcomeIds].filter((id) => !gateIds.has(id)).sort();
  return {
    consensus_rows: consensusEntries.length,
    traced_gate_rows: tracedGateRows,
    outcome_rows: outcomeRecords.length,
    matched_unique_trace_ids: matched.length,
    join_status: unmatchedOutcomeIds.length > 0 ? "failed" : pendingGateIds.length > 0 ? "pending" : "healthy",
    pending_gate_ids: pendingGateIds,
    unmatched_gate_ids: pendingGateIds,
    unmatched_outcome_ids: unmatchedOutcomeIds,
    source_counts: Object.fromEntries(Object.entries(sourceCounts).sort(([a], [b]) => a.localeCompare(b))),
  };
}

export function computeJoinHealthFrom(
  logPath: string = LOG_PATH,
  outcomesPath: string = OUTCOMES_PATH,
): JoinHealth {
  const entries = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  return calculateJoinHealth(entries, readOutcomeRecordsAt(outcomesPath));
}

/** Read trace-outcomes.jsonl → Map<trace_id, outcome>. First write per trace wins. */
function readOutcomesMapAt(outcomesPath: string): Map<string, "success" | "failure"> {
  return outcomesMapFrom(readOutcomeRecordsAt(outcomesPath));
}
function readOutcomesMap(): Map<string, "success" | "failure"> {
  return readOutcomesMapAt(OUTCOMES_PATH);
}

interface VoterStats {
  agreement_rate: number;
  vendor_error_rate: number;
  effective_weight: number;
  total_votes: number;
  agreed: number;
  vendor_errors: number;
  status: string;
  // learned credit assignment
  outcome_votes: number;   // traces this voter participated in WITH a resolved outcome
  outcome_credits: number; // votes whose polarity matched the distant outcome (PASS↔success, FAIL↔failure)
  outcome_credit: number;  // outcome_credits / outcome_votes (0 when no resolved traces)
}

interface Reputation {
  updated: string;
  runs: number;
  voters: Record<string, VoterStats>;
  join_health?: JoinHealth;
}

export function computeReputationFrom(
  logPath: string = LOG_PATH,
  outcomesPath: string = OUTCOMES_PATH
): Reputation {
  const voters: Record<string, VoterStats> = {};
  let totalRuns = 0;

  const outcomeRecords = readOutcomeRecordsAt(outcomesPath);
  const entries = fs.existsSync(logPath)
    ? fs.readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const joinHealth = calculateJoinHealth(entries, outcomeRecords);

  if (!fs.existsSync(logPath)) {
    return { updated: new Date().toISOString(), runs: 0, voters: {}, join_health: joinHealth };
  }

  // Learned credit assignment: join each gate decision to its distant downstream
  // outcome via trace_id. Entries without a trace_id, or traces with no resolved
  // outcome yet, simply contribute no outcome signal (cold-start safe).
  const outcomes = outcomesMapFrom(outcomeRecords);

  for (const entry of entries) {
    totalRuns++;

    const status = entry.status;
    const verdict = entry.verdict;
    const models = verdict?.models ?? {};

    const consensusPass = verdict?.pass;
    const isEscalated = status === "escalate" || status === "split";

    const traceOutcome = entry.trace_id ? outcomes.get(entry.trace_id) : undefined;

    for (const [model, v] of Object.entries(models) as [string, any][]) {
      if (!voters[model]) {
        voters[model] = { agreement_rate: 0, vendor_error_rate: 0, effective_weight: 0, total_votes: 0, agreed: 0, vendor_errors: 0, status: "", outcome_votes: 0, outcome_credits: 0, outcome_credit: 0 };
      }

      voters[model].total_votes++;

      const isVendorError = (v.issues ?? []).some(
        (i: string) =>
          i.startsWith("No response from vendor") ||
          i.startsWith("API error:") ||
          i.startsWith("Call failed:")
      );

      if (isVendorError) {
        voters[model].vendor_errors++;
      } else if (!isEscalated && consensusPass !== null && v.pass === consensusPass) {
        voters[model].agreed++;
      }

      // outcome credit: PASS↔success, FAIL↔failure
      if (traceOutcome) {
        voters[model].outcome_votes++;
        if ((v.pass && traceOutcome === "success") || (!v.pass && traceOutcome === "failure")) {
          voters[model].outcome_credits++;
        }
      }
    }
  }

  for (const stats of Object.values(voters)) {
    const validVotes = stats.total_votes - stats.vendor_errors;
    stats.agreement_rate = validVotes > 0 ? stats.agreed / validVotes : 0;
    stats.vendor_error_rate = stats.total_votes > 0 ? stats.vendor_errors / stats.total_votes : 0;
    const local = stats.agreement_rate * (1 - stats.vendor_error_rate);
    stats.outcome_credit = stats.outcome_votes > 0 ? stats.outcome_credits / stats.outcome_votes : 0;
    // λ ramps 0 → MAX_LAMBDA as outcome evidence accrues; 0 until MIN_OUTCOME_SAMPLES
    const lambda =
      stats.outcome_votes >= MIN_OUTCOME_SAMPLES
        ? Math.min(stats.outcome_votes / RAMP_TARGET, 1) * MAX_LAMBDA
        : 0;
    stats.effective_weight = (1 - lambda) * local + lambda * stats.outcome_credit;
  }

  return { updated: new Date().toISOString(), runs: totalRuns, voters, join_health: joinHealth };
}

function computeReputation(): Reputation {
  return computeReputationFrom();
}

function saveReputation(rep: Reputation): string {
  fs.mkdirSync(`${process.env.HOME}/.zouroboros`, { recursive: true });
  // Preserve the immediately-prior snapshot so daily delta checks
  // (>5% weight shift, newly-qualified voters) are auditable after a rebuild.
  if (fs.existsSync(REPUTATION_PATH)) {
    fs.copyFileSync(REPUTATION_PATH, `${REPUTATION_PATH}.bak`);
  }
  fs.writeFileSync(REPUTATION_PATH, JSON.stringify(rep, null, 2));
  return REPUTATION_PATH;
}

export function updateReputation(
  modelVerdicts: Array<{ model: string; pass: boolean; vendorErrors: string[] }>,
  consensus: { pass: boolean | null; status: string }
): void {
  const rep = fs.existsSync(REPUTATION_PATH)
    ? JSON.parse(fs.readFileSync(REPUTATION_PATH, "utf-8"))
    : { updated: "", runs: 0, voters: {} };

  rep.updated = new Date().toISOString();
  rep.runs++;

  const isEscalated = consensus.status === "escalate" || consensus.status === "split";

  for (const { model, pass, vendorErrors } of modelVerdicts) {
    if (!rep.voters[model]) {
      rep.voters[model] = { agreement_rate: 0, vendor_error_rate: 0, effective_weight: 0, total_votes: 0, agreed: 0, vendor_errors: 0, status: "", outcome_votes: 0, outcome_credits: 0, outcome_credit: 0 };
    }

    rep.voters[model].total_votes++;

    if (vendorErrors.length > 0) {
      rep.voters[model].vendor_errors++;
    } else if (!isEscalated && consensus.pass !== null && pass === consensus.pass) {
      rep.voters[model].agreed++;
    }
  }

  // Incremental path: recompute local effective_weight. outcome_credit is
  // join-based (requires the full log + outcomes file) and is refreshed on the
  // next `--rebuild`. Preserve any existing outcome fields from prior rebuilds.
  for (const stats of Object.values(rep.voters) as VoterStats[]) {
    const validVotes = stats.total_votes - stats.vendor_errors;
    stats.agreement_rate = validVotes > 0 ? stats.agreed / validVotes : 0;
    stats.vendor_error_rate = stats.total_votes > 0 ? stats.vendor_errors / stats.total_votes : 0;
    const local = stats.agreement_rate * (1 - stats.vendor_error_rate);
    const lambda =
      (stats.outcome_votes ?? 0) >= MIN_OUTCOME_SAMPLES
        ? Math.min((stats.outcome_votes ?? 0) / RAMP_TARGET, 1) * MAX_LAMBDA
        : 0;
    stats.effective_weight = (1 - lambda) * local + lambda * (stats.outcome_credit ?? 0);
  }

  fs.writeFileSync(REPUTATION_PATH, JSON.stringify(rep, null, 2));
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean" as const, default: false },
      rebuild: { type: "boolean" as const, default: false },
    },
    strict: true,
    allowPositionals: true,
  });

    if (positionals[0] === "diff") {
    const days = 30;
    const cutoff = new Date(Date.now() - days * 86400000).toISOString();
    const rep = computeReputation();
    
    let equalPassed = 0, equalRejected = 0, equalEscalated = 0;
    let weightedPassed = 0, weightedRejected = 0, weightedEscalated = 0;
    let flips: Array<{ id: string; equal: string; weighted: string; score: number }> = [];
    
    console.log(`\n⚖️  Weighted vs Equal-Weight Comparison (last ${days} days)`);
    console.log(`   Voters with reputation: ${Object.keys(rep.voters).filter(k => rep.voters[k].total_votes >= 20).join(', ')}\n`);
    console.log(`${"Run ID".padEnd(24)}  Equal       Weighted    Score\n${"-".repeat(64)}`);
    
    for (const line of fs.readFileSync(LOG_PATH, "utf-8").trim().split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line);
      if (entry.timestamp < cutoff) continue;
      
      const models = entry.verdict?.models ?? {};
      const equalPass = entry.verdict?.pass;
      let equalStatus: string;
      if (equalPass === true) equalStatus = "passed";
      else if (equalPass === false) equalStatus = "rejected";
      else equalStatus = "escalate";
      
      if (equalStatus === "passed") equalPassed++;
      else if (equalStatus === "rejected") equalRejected++;
      else equalEscalated++;
      
      const verdicts = Object.entries(models).map(([model, v]: [string, any]) => ({
        model,
        pass: v.pass,
        issues: v.issues ?? [],
        dissent_claims: [] as any[],
        confidence: typeof v.confidence === 'number' ? v.confidence : 0.5,
        latencyMs: 0,
      }));
      
      const criteria = entry.criteria ?? "correctness";
      
      const { status: wStatus, weightedScore } = (() => {
        const repPath = `${process.env.HOME}/.zouroboros/reputation.json`;
        const rep = fs.existsSync(repPath) ? JSON.parse(fs.readFileSync(repPath, "utf-8")) : null;
        const voters = rep?.voters ?? {};
        const isCodeCriteria = /correct|security|safety|type|design|brand/.test(criteria.toLowerCase());
        
        let weightSum = 0, scoreSum = 0;
        for (const v of verdicts) {
          let w: number;
          if (v.model.startsWith("non-llm/")) {
            w = isCodeCriteria && !v.issues.some((i: string) => i.includes("not in arbiter scope")) ? 1.0 : 0;
          } else {
            const eff = voters[v.model]?.effective_weight;
            w = (eff === undefined || eff === null || (rep && rep.runs < 20)) ? 1.0 : Math.max(eff, 0.5);
          }
          if (w > 0) { weightSum += w; scoreSum += w * (v.pass ? 1 : 0); }
        }
        
        const ws = weightSum > 0 ? scoreSum / weightSum : 0.5;
        const THRESHOLD = 0.75;
        let s: string;
        if (ws >= THRESHOLD) s = "passed";
        else if (ws < 1 - THRESHOLD) s = "rejected";
        else s = "escalate";
        return { status: s, weightedScore: ws };
      })();
      
      if (wStatus === "passed") weightedPassed++;
      else if (wStatus === "rejected") weightedRejected++;
      else weightedEscalated++;
      
      if (equalStatus !== wStatus) {
        flips.push({ id: entry.consensus_id ?? entry.timestamp, equal: equalStatus, weighted: wStatus, score: weightedScore });
        console.log(`${(entry.consensus_id ?? entry.timestamp).padEnd(24)} ${equalStatus.padEnd(11)} → ${wStatus.padEnd(11)} ${weightedScore.toFixed(3)}`);
      }
    }
    
    console.log(`\n--- Summary ---`);
    console.log(`Equal-weight:   ${equalPassed} passed, ${equalRejected} rejected, ${equalEscalated} escalated`);
    console.log(`Weighted:       ${weightedPassed} passed, ${weightedRejected} rejected, ${weightedEscalated} escalated`);
    console.log(`Flips:          ${flips.length} verdict${flips.length !== 1 ? 's' : ''} changed`);
    process.exit(0);
  }

if (values.help) {
    console.log(`Usage: bun run reputation.ts [--rebuild]

Flags:
  --rebuild  Rebuild reputation from full log (default if no reputation.json exists)

If reputation.json exists, validates and prints current state.
With --rebuild, recomputes from scratch.`);
    process.exit(0);
  }

  const shouldRebuild = values.rebuild || !fs.existsSync(REPUTATION_PATH);
  const hadPrior = fs.existsSync(REPUTATION_PATH);
  const rep = computeReputation();
  const path = saveReputation(rep);

  console.log(`\n📊 Reputation ${shouldRebuild ? "rebuilt" : "loaded"} from ${rep.runs} runs`);
  console.log(`   Saved: ${path}`);
  if (hadPrior) console.log(`   Prior snapshot backed up: ${path}.bak`);
  console.log("");

  const modelMaxLen = Math.max(...Object.keys(rep.voters).map((m) => m.length), 30);
  console.log(
    `${"Model".padEnd(modelMaxLen)}  agree  v_err  eff_wt   ocr   ocn   votes`
  );
  console.log(`${"-".repeat(modelMaxLen)}  -----  -----  ------   ---   ---   -----`);

  for (const [model, stats] of Object.entries(rep.voters).sort(
    (a, b) => b[1].effective_weight - a[1].effective_weight
  )) {
    const ocr = stats.outcome_votes > 0 ? stats.outcome_credit.toFixed(3) : "  -  ";
    const ocn = stats.outcome_votes.toString().padStart(3);
    console.log(
      `${model.padEnd(modelMaxLen)}  ${stats.agreement_rate.toFixed(3)}  ${stats.vendor_error_rate.toFixed(3)}  ${stats.effective_weight.toFixed(3)}   ${ocr}   ${ocn}   ${stats.total_votes}`
    );
  }

  const joinHealth = rep.join_health ?? computeJoinHealthFrom();
  console.log("\n   Join health:");
  console.log(`     consensus rows:          ${joinHealth.consensus_rows}`);
  console.log(`     traced gate rows:        ${joinHealth.traced_gate_rows}`);
  console.log(`     outcome rows:            ${joinHealth.outcome_rows}`);
  console.log(`     matched unique trace IDs:${joinHealth.matched_unique_trace_ids.toString().padStart(3)}`);
  console.log(`     join status:              ${joinHealth.join_status}`);
  console.log(`     pending gate IDs:         ${joinHealth.pending_gate_ids.length}${joinHealth.pending_gate_ids.length ? ` (${joinHealth.pending_gate_ids.join(", ")})` : ""}`);
  console.log(`     unmatched outcome IDs:    ${joinHealth.unmatched_outcome_ids.length}${joinHealth.unmatched_outcome_ids.length ? ` (${joinHealth.unmatched_outcome_ids.join(", ")})` : ""}`);
  console.log(`     outcome sources:         ${JSON.stringify(joinHealth.source_counts)}`);
  if (joinHealth.join_status === "failed") {
    console.warn("   WARNING: outcome rows exist without matching consensus traces");
  }

  const resolvedTraces = Object.values(rep.voters).reduce((s, v) => s + (v.outcome_votes || 0), 0);
  if (resolvedTraces > 0) {
    console.log(`\n   🧬 learned-credit: ${resolvedTraces} trace${resolvedTraces !== 1 ? "s" : ""} resolved downstream → outcome_credit blended into eff_wt`);
  } else {
    console.log(`\n   🧬 learned-credit: no resolved traces yet — eff_wt = agreement × (1 − vendor_err) [cold-start]`);
  }
}


if (import.meta.main) {
  main().catch(console.error);
}
