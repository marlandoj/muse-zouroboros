#!/usr/bin/env bun
import { parseArgs } from "util";
import * as fs from "fs";
import { loadCandidates, updateCandidateStatus, type ProvisionalRecord } from "./provisional-candidates";
import { runShadowAdvisory, type CandidateRunSummary } from "./shadow-candidate-runner";

const REP_PATH = `${process.env.HOME}/.zouroboros/reputation.json`;
const QUARANTINE_PATH = `${process.env.HOME}/.zouroboros/quarantine-state.json`;

export interface ShadowCandidate {
  model: string;
  since: string;
  coldStartScore: number;
  shadow_runs: number;
  shadow_passes: number;
}

interface QuarantineState {
  quarantined: Array<{
    model: string;
    since: string;
    reason: string;
    effective_weight: number;
    shadow_runs: number;
    shadow_passes: number;
  }>;
  shadowLog: Array<{
    model: string;
    date: string;
    effective_weight: number;
  }>;
  shadowCandidates: ShadowCandidate[];
}

function loadReputation() {
  return JSON.parse(fs.readFileSync(REP_PATH, "utf-8"));
}

function loadQuarantine(): QuarantineState {
  if (!fs.existsSync(QUARANTINE_PATH)) {
    return { quarantined: [], shadowLog: [], shadowCandidates: [] };
  }
  const state = JSON.parse(fs.readFileSync(QUARANTINE_PATH, "utf-8"));
  if (!state.shadowCandidates) state.shadowCandidates = [];
  return state;
}

function saveQuarantine(state: QuarantineState) {
  fs.mkdirSync(`${process.env.HOME}/.zouroboros`, { recursive: true });
  fs.writeFileSync(QUARANTINE_PATH, JSON.stringify(state, null, 2));
}

function checkThresholds(): { candidates: Array<{ model: string; effective_weight: number; total_votes: number }>; active: number } {
  const rep = loadReputation();
  const candidates: Array<{ model: string; effective_weight: number; total_votes: number }> = [];
  
  for (const [model, stats] of Object.entries(rep.voters) as [string, any][]) {
    if (model.startsWith("non-llm/")) continue;
    if (stats.total_votes < 50) continue;
    if ((stats.status ?? "active") === "quarantine") {
      candidates.push({ model, effective_weight: stats.effective_weight, total_votes: stats.total_votes });
      continue;
    }
    if (stats.effective_weight < 0.50) {
      candidates.push({ model, effective_weight: stats.effective_weight, total_votes: stats.total_votes });
    }
  }

  const active = Object.values(rep.voters).filter(
    (v: any) => (v.status ?? "active") !== "quarantine" && !v.model?.startsWith("non-llm/")
  ).length;

  return { candidates, active };
}

function applyHotSwap(model: string): string | null {
  const { getChain } = require("./catalog");
  try {
    const chain = getChain(model);
    if (chain && chain.length > 0) {
      return chain[0];
    }
  } catch {}
  return null;
}

function quarantineCheck(): void {
  const { candidates, active } = checkThresholds();
  
  if (candidates.length === 0) {
    console.log("✅ No voters below quarantine threshold");
    return;
  }

  const state = loadQuarantine();
  
  for (const c of candidates) {
    const alreadyQuarantined = state.quarantined.find(q => q.model === c.model);
    if (alreadyQuarantined) continue;
    
    // Cascade cap
    if (state.quarantined.length >= 1) {
      console.log(`\n⚠️  CASCADE PREVENTION: ${c.model} also qualifies (eff=${c.effective_weight.toFixed(3)})`);
      console.log(`   One quarantine already active. Paging user for manual review.\n`);
      
      // Output full table for manual decision
      weeklyDigest();
      process.exit(2);
    }

    // Quarantine this voter
    const replacement = applyHotSwap(c.model);
    state.quarantined.push({
      model: c.model,
      since: new Date().toISOString(),
      reason: `effective_weight=${c.effective_weight.toFixed(3)} (< 0.50) over ${c.total_votes} runs`,
      effective_weight: c.effective_weight,
      shadow_runs: 0,
      shadow_passes: 0,
    });

    // Mark in reputation
    const rep = loadReputation();
    if (rep.voters[c.model]) {
      rep.voters[c.model].status = "quarantine";
      rep.voters[c.model].quarantined_since = new Date().toISOString();
      fs.writeFileSync(REP_PATH, JSON.stringify(rep, null, 2));
    }

    console.log(`\n🚫 QUARANTINED: ${c.model}`);
    console.log(`   Reason: effective_weight=${c.effective_weight.toFixed(3)} (< 0.50)`);
    console.log(`   Replacement: ${replacement ?? "none available — manual intervention required"}`);
  }

  saveQuarantine(state);
}

function weeklyDigest(): void {
  const rep = loadReputation();
  const state = loadQuarantine();
  
  console.log(`\n📊 Weekly Consensus Gate Health Digest — ${new Date().toISOString().slice(0, 10)}`);
  console.log(`   Runs: ${rep.runs}`);
  console.log();
  
  const modelMaxLen = Math.max(...Object.keys(rep.voters).map(m => m.length), 45);
  console.log(
    `${"Voter".padEnd(modelMaxLen)}  eff_wt   Status    30d  Votes`
  );
  console.log(`${"-".repeat(modelMaxLen)}  ------   --------  ---  -----`);

  for (const [model, stats] of Object.entries(rep.voters).sort(
    (a, b) => (b[1] as any).effective_weight - (a[1] as any).effective_weight
  )) {
    const s = stats as any;
    const status = s.status ?? (model.startsWith("non-llm/") ? "arbiter" : "active");
    const qEntry = state.quarantined.find(q => q.model === model);
    const suffix = qEntry
      ? ` (${qEntry.shadow_runs}/10 shadow, ${Math.floor((Date.now() - new Date(qEntry.since).getTime()) / 86400000)}d)`
      : "";
    console.log(
      `${model.padEnd(modelMaxLen)}  ${s.effective_weight.toFixed(4)}   ${(status + suffix).padEnd(9)}  ${Math.floor(s.effective_weight * 100)}%  ${s.total_votes}`
    );
  }
}

function scheduleWeeklyShadow(): void {
  const state = loadQuarantine();
  const rep = loadReputation();
  
  for (const q of state.quarantined) {
    const daysElapsed = (Date.now() - new Date(q.since).getTime()) / 86400000;
    const voter = rep.voters[q.model];
    
    if (!voter) continue;
    
    // Update shadow log with latest effective_weight
    state.shadowLog.push({
      model: q.model,
      date: new Date().toISOString(),
      effective_weight: voter.effective_weight,
    });
    
    // Trim shadow log to last 10 entries
    const modelLog = state.shadowLog.filter(l => l.model === q.model).slice(-10);
    state.shadowLog = state.shadowLog.filter(l => l.model !== q.model).concat(modelLog);
    
    // Check recovery conditions
    const recoveryLog = modelLog.filter(l => l.effective_weight > 0.65);
    const recoveryRuns = recoveryLog.length;
    
    q.shadow_runs = modelLog.length;
    q.shadow_passes = recoveryRuns;
    
    if (recoveryRuns >= 10 && daysElapsed >= 14) {
      console.log(`\n✅ RECOVERED: ${q.model}`);
      console.log(`   effective_weight: ${voter.effective_weight.toFixed(3)} (> 0.65)`);
      console.log(`   Shadow runs: ${recoveryRuns}/10 passed`);
      console.log(`   Days elapsed: ${daysElapsed.toFixed(1)}/14`);
      
      // Restore to active
      voter.status = "active";
      delete voter.quarantined_since;
      state.quarantined = state.quarantined.filter(x => x.model !== q.model);
    } else if (modelLog.length > 0) {
      console.log(`⏳ ${q.model}: ${recoveryRuns}/10 shadow passes, ${daysElapsed.toFixed(1)}/14 days`);
    }
  }

  saveQuarantine(state);
  if (rep) {
    fs.writeFileSync(REP_PATH, JSON.stringify(rep, null, 2));
  }
}

// ZOU-486 — Symmetric shadow promotion. The same shadow lane that restores a
// demoted model also elevates a cold-start-passed candidate. New candidates
// accrue outcome samples in shadow (advisory only) and promote on merit when
// their effective_weight clears the threshold over the required window.
// Auto-promotion into DEFAULT_QUORUM is operator-gated: this emits a
// recommendation, it never mutates the live quorum directly.
export const SHADOW_PROMOTE_EW = 0.65;
export const SHADOW_PROMOTE_RUNS = 10;
export const SHADOW_PROMOTE_DAYS = 14;

export function candidateRouteId(candidate: Pick<ProvisionalRecord, "id" | "provider">): string {
  return candidate.provider === "openrouter" && !candidate.id.startsWith("or:")
    ? `or:${candidate.id}`
    : candidate.id;
}

export function distinctDailyShadowLog(
  log: QuarantineState["shadowLog"],
  model: string,
  limit = SHADOW_PROMOTE_RUNS,
): QuarantineState["shadowLog"] {
  const byDay = new Map<string, QuarantineState["shadowLog"][number]>();
  for (const row of log.filter((entry) => entry.model === model).sort((a, b) => a.date.localeCompare(b.date))) {
    byDay.set(row.date.slice(0, 10), row);
  }
  return [...byDay.values()].slice(-limit);
}

function configuredPromotionTargets(): Set<string> {
  return new Set(
    (process.env.SHADOW_PROMOTION_TARGETS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

function summaryByCandidate(summaries: CandidateRunSummary[]): Map<string, CandidateRunSummary> {
  return new Map(summaries.map((summary) => [summary.candidate_id, summary]));
}

async function promoteShadowCandidates(): Promise<void> {
  const state = loadQuarantine();
  const allCandidates = loadCandidates();
  const candidateById = new Map(allCandidates.map((candidate) => [candidate.id, candidate]));
  const targets = configuredPromotionTargets();
  const candidates = allCandidates.filter(
    (candidate) =>
      (candidate.status === "cold-start-passed" || candidate.status === "shadow") &&
      targets.has(candidateRouteId(candidate)),
  );
  const now = Date.now();

  if (targets.size === 0) {
    console.warn("No SHADOW_PROMOTION_TARGETS configured; no candidates will be enrolled or invoked.");
  }

  // Enroll new cold-start-passed candidates into the shadow lane
  for (const c of candidates) {
    if (c.status !== "cold-start-passed") continue;
    if (state.shadowCandidates.some((s) => s.model === c.id)) continue;
    state.shadowCandidates.push({
      model: c.id,
      since: new Date(now).toISOString(),
      coldStartScore: c.coldStartScore ?? 0,
      shadow_runs: 0,
      shadow_passes: 0,
    });
    updateCandidateStatus(c.id, "shadow");
    console.log(`\n🔵 ENROLLED in shadow: ${c.id} (cold-start score ${c.coldStartScore})`);
  }

  saveQuarantine(state);

  const runnableCandidates = state.shadowCandidates.flatMap((candidate) => {
    const record = candidateById.get(candidate.model);
    if (!record) return [];
    const route = candidateRouteId(record);
    return targets.has(route) ? [{ id: candidate.model, route }] : [];
  });
  const advisorySummaries = await runShadowAdvisory(runnableCandidates);
  const summaries = summaryByCandidate(advisorySummaries);
  for (const summary of advisorySummaries) {
    console.log(
      `SHADOW_EVIDENCE ${summary.candidate_id}: attempted=${summary.attempted} fresh=${summary.fresh_evidence} agreements=${summary.agreements} vendor_errors=${summary.vendor_errors}`,
    );
  }
  const rep = fs.existsSync(REP_PATH) ? JSON.parse(fs.readFileSync(REP_PATH, "utf-8")) : null;
  const today = new Date(now).toISOString().slice(0, 10);

  for (const sc of state.shadowCandidates) {
    const daysElapsed = (now - new Date(sc.since).getTime()) / 86400000;
    const voter = rep?.voters?.[sc.model];
    if (!voter) {
      // No production outcome samples yet — still earning in shadow
      if (daysElapsed < 1) console.log(`⏳ ${sc.model}: earning outcome samples in shadow (${daysElapsed.toFixed(1)}d)`);
      continue;
    }

    const freshEvidence = summaries.get(sc.model)?.fresh_evidence ?? 0;
    const alreadyObservedToday = state.shadowLog.some(
      (entry) => entry.model === sc.model && entry.date.slice(0, 10) === today,
    );
    if (freshEvidence > 0 && !alreadyObservedToday) {
      state.shadowLog.push({
        model: sc.model,
        date: new Date(now).toISOString(),
        effective_weight: voter.effective_weight,
      });
    }
    const modelLog = distinctDailyShadowLog(state.shadowLog, sc.model);

    const passes = modelLog.filter((l) => l.effective_weight > SHADOW_PROMOTE_EW).length;
    sc.shadow_runs = modelLog.length;
    sc.shadow_passes = passes;

    if (passes >= SHADOW_PROMOTE_RUNS && daysElapsed >= SHADOW_PROMOTE_DAYS) {
      console.log(`\n✅ READY FOR PROMOTION: ${sc.model}`);
      console.log(`   effective_weight: ${voter.effective_weight.toFixed(3)} (> ${SHADOW_PROMOTE_EW})`);
      console.log(`   Shadow passes: ${passes}/${SHADOW_PROMOTE_RUNS}, days: ${daysElapsed.toFixed(1)}/${SHADOW_PROMOTE_DAYS}`);
      console.log(`   ⚠️ Advisory: operator must add to DEFAULT_QUORUM/DEFAULT_MOA (auto-promote is gated).`);
      updateCandidateStatus(sc.model, "promoted", { promotedAt: new Date(now).toISOString() });
      state.shadowCandidates = state.shadowCandidates.filter((s) => s.model !== sc.model);
    } else if (modelLog.length > 0) {
      console.log(`⏳ ${sc.model}: ${passes}/${SHADOW_PROMOTE_RUNS} shadow passes, ${daysElapsed.toFixed(1)}/${SHADOW_PROMOTE_DAYS}d (advisory)`);
    }
  }

  saveQuarantine(state);
}

export const DEFAULT_CONSENSUS_MODELS = [
  "hf:zai-org/GLM-5.2",
  "kimi:kimi-k3",
  "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4",
];

export function getActiveModels(): string[] {
  const rep = loadReputation();
  const state = loadQuarantine();
  const quarantinedModels = new Set(state.quarantined.map(q => q.model));
  
  const active: string[] = [];
  
  for (const model of DEFAULT_CONSENSUS_MODELS) {
    if (quarantinedModels.has(model)) {
      const replacement = applyHotSwap(model);
      if (replacement) {
        active.push(replacement);
      }
    } else {
      active.push(model);
    }
  }

  return active;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean" as const, default: false },
    },
    strict: true,
    allowPositionals: true,
  });

  if (values.help || positionals.length === 0) {
    console.log(`Quarantine Manager for Consensus Gate

Usage:
  bun run quarantine.ts check       Check for voters below threshold
  bun run quarantine.ts hotswap     Apply quarantine + hot-swap
  bun run quarantine.ts shadow      Run weekly shadow check (recovering voters + new candidate promotion)
  bun run quarantine.ts digest      Weekly health digest (text table)`);
    process.exit(0);
  }

  const cmd = positionals[0];

  switch (cmd) {
    case "check":
      quarantineCheck();
      break;
    case "hotswap":
      quarantineCheck();
      break;
    case "shadow":
      scheduleWeeklyShadow();
      await promoteShadowCandidates();
      break;
    case "digest":
      weeklyDigest();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      process.exit(1);
  }
}

if (import.meta.main) {
  main().catch(console.error);
}
