#!/usr/bin/env bun
/**
 * noise-watch — weekly health monitor for consensus-gate.
 *
 * Reads ~/.zouroboros/consensus-gate.json, computes signal/noise/override
 * metrics over the configured window, and emits a one-line health verdict
 * plus a structured payload. Designed to be invoked from a scheduled agent.
 *
 * Exit codes:
 *   0  HEALTHY     — noise within bounds, gate is producing value
 *   1  DATA_GAP    — not enough classified runs to judge
 *   2  WARN        — noise elevated; consider tightening labels or scope
 *   3  CRITICAL    — gate noise dominates signal; defer-item #3 territory
 */
import { execSync } from "child_process";
import { parseArgs } from "util";
import { join } from "path";

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "7" },
    "noise-warn": { type: "string", default: "0.45" },
    "noise-critical": { type: "string", default: "0.65" },
    "wouldfail-warn": { type: "string", default: "0.20" },
    "wouldfail-critical": { type: "string", default: "0.40" },
    "min-runs": { type: "string", default: "5" },
    json: { type: "boolean" },
  },
});

const since = parseInt(values.since!, 10);
const noiseWarn = parseFloat(values["noise-warn"]!);
const noiseCrit = parseFloat(values["noise-critical"]!);
const wfWarn = parseFloat(values["wouldfail-warn"]!);
const wfCrit = parseFloat(values["wouldfail-critical"]!);
const minRuns = parseInt(values["min-runs"]!, 10);

// Resolve the gate CLI relative to this script so the package works from any checkout location.
const GATE = join(import.meta.dir, "consensus-gate.ts");

const raw = execSync(`bun ${GATE} noise-stats --since ${since}`, {
  encoding: "utf-8",
  stdio: ["pipe", "pipe", "ignore"],
});
const idx = raw.indexOf("{");
if (idx < 0) {
  console.error("noise-watch: could not parse noise-stats JSON");
  process.exit(1);
}
const stats = JSON.parse(raw.slice(idx));

if (!stats.total_runs || stats.total_runs < minRuns) {
  const msg = `DATA_GAP: only ${stats.total_runs ?? 0} classified runs in last ${since}d (need ≥${minRuns})`;
  if (values.json) console.log(JSON.stringify({ status: "DATA_GAP", ...stats }));
  else console.log(msg);
  process.exit(1);
}

const noise = stats.noise_ratio as number;
const wouldFail = stats.would_have_failed_rate as number;
const signal = stats.signal_ratio as number;
const overrideRate = stats.override_rate as number;

let status: "HEALTHY" | "WARN" | "CRITICAL";
let reason: string;

if (noise >= noiseCrit || wouldFail >= wfCrit) {
  status = "CRITICAL";
  reason = `noise=${(noise * 100).toFixed(0)}% would-have-failed=${(wouldFail * 100).toFixed(0)}% — gate friction exceeds value, consider scope-precheck + round cap`;
} else if (noise >= noiseWarn || wouldFail >= wfWarn) {
  status = "WARN";
  reason = `noise=${(noise * 100).toFixed(0)}% would-have-failed=${(wouldFail * 100).toFixed(0)}% — trending noisy, watch trend`;
} else {
  status = "HEALTHY";
  reason = `noise=${(noise * 100).toFixed(0)}% signal=${(signal * 100).toFixed(0)}% — gate is producing value`;
}

const summary = {
  status,
  window_days: since,
  total_runs: stats.total_runs,
  signal_ratio: signal,
  noise_ratio: noise,
  override_rate: overrideRate,
  would_have_failed_rate: wouldFail,
  trend: stats.trend,
  reason,
  noisiest_labels: (stats.noisiest_labels || []).slice(0, 3),
  thresholds: {
    noise_warn: noiseWarn,
    noise_critical: noiseCrit,
    wouldfail_warn: wfWarn,
    wouldfail_critical: wfCrit,
  },
};

if (values.json) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const icon =
    status === "HEALTHY" ? "✅" : status === "WARN" ? "⚠️" : "❌";
  console.log(`${icon} consensus-gate ${status}: ${reason}`);
  console.log(
    `   runs=${stats.total_runs} sig=${(signal * 100).toFixed(0)}% noise=${(noise * 100).toFixed(0)}% overrides=${(overrideRate * 100).toFixed(0)}% would-fail=${(wouldFail * 100).toFixed(0)}%`
  );
  if (stats.trend) {
    const arrow =
      stats.trend.recent < stats.trend.prior
        ? "↓"
        : stats.trend.recent > stats.trend.prior
          ? "↑"
          : "→";
    console.log(
      `   trend: ${(stats.trend.prior * 100).toFixed(0)}% → ${(stats.trend.recent * 100).toFixed(0)}% ${arrow}`
    );
  }
  if (summary.noisiest_labels.length) {
    console.log("   noisiest labels:");
    for (const r of summary.noisiest_labels) {
      console.log(
        `     • ${r.label} — noise=${(r.noise * 100).toFixed(0)}% sig=${(r.signal * 100).toFixed(0)}% (n=${r.runs})`
      );
    }
  }
}

if (status === "CRITICAL") process.exit(3);
if (status === "WARN") process.exit(2);
process.exit(0);
