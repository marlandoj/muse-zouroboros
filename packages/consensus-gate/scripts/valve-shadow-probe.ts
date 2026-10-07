#!/usr/bin/env bun
/**
 * valve-shadow-probe.ts — measure-only probe for the gate escalation valve.
 *
 * WHY: The Zo interactive-chat model call is made by the Zo platform, not by code
 * we control, so the valve (escalation-valve.ts) cannot transparently sit in front
 * of the live Complex-tier Opus call today (see valve-ask-server.ts PLATFORM
 * BOUNDARY). What we CAN do now is measure, at the exact complex/apex decision
 * point, how often the cheap MoA answer WOULD have passed the sufficiency gate —
 * i.e. how much metered Anthropic headroom the valve would protect if/when a real
 * interception hook exists. This probe produces that measurement and nothing else.
 *
 * It runs the valve's first two stages only:
 *   1. CHEAP  — moaGenerate (GLM-5.2 / Kimi-K2.7-Code / DeepSeek-V4 → aggregator). No Anthropic.
 *   2. GATE   — reviewSufficiency: the consensus panel votes sufficient/insufficient.
 * It DOES NOT escalate — never calls Opus — so the probe itself costs $0 Anthropic.
 * The user's real response is unaffected; this only appends a measurement record.
 *
 * Meant to be spawned fire-and-forget (detached, not awaited) by model-route-gate.ts
 * when VALVE_SHADOW is enabled and the classified tier is complex or apex.
 *
 * Output: one JSONL record appended to Skills/consensus-gate/data/valve-shadow.jsonl
 *
 * Usage:
 *   bun valve-shadow-probe.ts --tier complex --persona alaric "<user message>"
 *
 * Always exits 0 (never disrupt the caller); failures are logged as records.
 */

import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { appendFileSync, mkdirSync, existsSync } from "fs";
import { moaGenerate, reviewSufficiency } from "./escalation-valve.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOG_PATH = resolve(__dirname, "../data/valve-shadow.jsonl");

// Same bar the valve uses to decide "good enough to ship".
const SHADOW_CRITERIA =
  "factual accuracy, completeness, and faithfully following the task's explicit output/format instructions";

function logRecord(rec: Record<string, unknown>): void {
  try {
    const dir = dirname(LOG_PATH);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    appendFileSync(LOG_PATH, JSON.stringify(rec) + "\n");
  } catch {
    /* never throw from the probe */
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let tier = "unknown";
  let persona = "unknown";
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--tier") tier = argv[++i] ?? "unknown";
    else if (a === "--persona") persona = argv[++i] ?? "unknown";
    else positional.push(a);
  }
  const task = positional.join(" ").trim();
  if (!task) {
    logRecord({ ts: new Date().toISOString(), tier, persona, error: "empty task" });
    return;
  }

  const t0 = Date.now();
  const base = { ts: new Date().toISOString(), tier, persona, task: task.slice(0, 280) };

  if (!process.env.OPENROUTER_API_KEY) {
    logRecord({ ...base, error: "OPENROUTER_API_KEY not set", wallMs: Date.now() - t0 });
    return;
  }

  try {
    // 1. CHEAP — no Anthropic call
    const cheap = await moaGenerate(task);
    if (!cheap.ok || !cheap.text) {
      logRecord({
        ...base,
        cheapOk: false,
        cheapModel: cheap.model,
        cheapLatencyMs: cheap.latencyMs,
        cheapError: cheap.error,
        // cheap gen failing is exactly the case the live valve would escalate on
        wouldEscalate: true,
        reason: "cheap generation failed",
        wallMs: Date.now() - t0,
      });
      return;
    }

    // 2. GATE — panel sufficiency vote, no Anthropic call
    const suff = await reviewSufficiency(task, cheap.text, SHADOW_CRITERIA);

    logRecord({
      ...base,
      cheapOk: true,
      cheapModel: cheap.model,
      cheapLatencyMs: cheap.latencyMs,
      cheapSource: cheap.source,
      sufficient: suff.sufficient,
      passCount: suff.passCount,
      failCount: suff.failCount,
      panelSize: suff.verdicts.length,
      // The headline metric: would the live valve have AVOIDED the Opus call?
      wouldShipCheap: suff.sufficient,
      wouldEscalate: !suff.sufficient,
      verdicts: suff.verdicts.map((v) => ({
        model: v.model,
        sufficient: v.sufficient,
        confidence: v.confidence,
        substitutedFrom: v.substitutedFrom,
      })),
      wallMs: Date.now() - t0,
    });
  } catch (e) {
    logRecord({ ...base, error: String(e), wallMs: Date.now() - t0 });
  }
}

main();
