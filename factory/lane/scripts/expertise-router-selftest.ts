#!/usr/bin/env bun
/**
 * SF-P4 — Hermetic selftest for the expertise-aware executor router.
 *
 * Fully sandboxed: injected fake healthProbe + injected fixture profiles, NO real
 * binaries, NO ExecutorClient import, NO network, NO spend. The only fs touch is a
 * self-written temp file to exercise loadExecutorProfiles (removed in finally).
 * Safe to run inside the conveyor smoke gate (step 9).
 *
 * Guards: classifyLeg (incl. invariant D2), loadExecutorProfiles (parse + degrade),
 * rankExecutorsForKind (eligibility + Hermes≻Gemini ordering), and
 * selectExecutorByExpertise (code-defer / research-resolve / degrade / never-throw).
 *
 * Exit 0 = all cases pass, 1 = any failure.
 */

import { unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthProbe } from "./harness-router";
import {
  type ExecutorProfile,
  classifyLeg,
  loadExecutorProfiles,
  rankExecutorsForKind,
  selectExecutorByExpertise,
} from "./expertise-router";

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

/** Probe that reports the named ids healthy, everything else unhealthy. */
function probeHealthy(...healthy: string[]): HealthProbe {
  const set = new Set(healthy);
  return async (id: string) => ({ healthy: set.has(id), message: set.has(id) ? `${id} ok` : `${id} down` });
}

/** Fixture mirroring the real executor-registry.json expertise arrays. */
const FIXTURE: ExecutorProfile[] = [
  { id: "claude-code", transport: "acp", expertise: ["code-generation", "code-review", "debugging", "refactoring", "architecture", "testing", "documentation"] },
  { id: "hermes", transport: "bridge", expertise: ["web-research", "web-scraping", "data-analysis", "image-generation", "multi-modal", "tool-orchestration", "audit", "review", "security", "summarize", "investigate"] },
  { id: "gemini", transport: "acp", expertise: ["code-generation", "code-review", "reasoning", "multimodal", "large-context", "research", "prototyping", "analysis", "audit", "evaluate", "summarize", "compare"] },
  { id: "codex", transport: "acp", expertise: ["code-generation", "code-review", "shell-commands", "file-editing", "debugging", "refactoring", "rapid-prototyping"] },
  { id: "mimir", transport: "mimir", expertise: ["memory", "context", "recall", "history", "synthesis", "knowledge", "institutional-memory"] },
];

console.log("expertise-router selftest");

// ─── (1) classifyLeg — code signals ────────────────────────────────────────────
check("'Implement the router module' → code", classifyLeg("Implement the router module").kind === "code");
check("'Refactor pool-worker dispatch' → code", classifyLeg("Refactor pool-worker dispatch").kind === "code");
check("'Fix the failing unit test' → code", classifyLeg("Fix the failing unit test").kind === "code");
check("'Add a migration for the schema' → code", classifyLeg("Add a migration for the schema").kind === "code");
check("code hit is recorded", classifyLeg("Implement X").strongCodeHits.includes("implement"));

// ─── (2) classifyLeg — research signals ────────────────────────────────────────
check("'Research MoA papers and summarize' → research", classifyLeg("Research the latest MoA papers and summarize").kind === "research");
check("'Investigate why the provider errors' → research", classifyLeg("Investigate why the provider errors out").kind === "research");
check("'Audit the security of the login flow' → research", classifyLeg("Audit the security of the login flow").kind === "research");
check("'Web search and compare vector DBs' → research", classifyLeg("Web search for vector DBs and compare them").kind === "research");
check("research hit is recorded", classifyLeg("Audit the thing").strongResearchHits.includes("audit"));

// ─── (3) classifyLeg — invariant D2 + defaults ─────────────────────────────────
check("empty text → code (safe default)", classifyLeg("").kind === "code");
check("whitespace text → code (safe default)", classifyLeg("   ").kind === "code");
check("D2: 'Summarize then implement the fix' → code (code wins)", classifyLeg("Summarize findings then implement the fix").kind === "code");
check("D2 mixed leg still records the research hit", classifyLeg("Summarize then implement").strongResearchHits.includes("summarize"));
check("D2 rationale flags the override", classifyLeg("Audit then refactor").rationale.includes("D2"));
check("case-insensitive: 'IMPLEMENT X' → code", classifyLeg("IMPLEMENT X").kind === "code");
check("case-insensitive: 'RESEARCH X' → research", classifyLeg("RESEARCH the market").kind === "research");

// ─── (4) loadExecutorProfiles ──────────────────────────────────────────────────
check("missing registry path → [] (no throw)", loadExecutorProfiles(join(tmpdir(), "does-not-exist-xyz.json")).length === 0);
{
  const p = join(tmpdir(), `expertise-selftest-${process.pid}-${Date.now()}.json`);
  try {
    writeFileSync(p, JSON.stringify({ executors: [{ id: "hermes", transport: "bridge", expertise: ["audit", "review"] }, { id: "bad" /* no expertise */ }] }));
    const profs = loadExecutorProfiles(p);
    check("parses 2 profiles from fixture file", profs.length === 2, String(profs.length));
    check("expertise array preserved", profs[0]?.expertise.join(",") === "audit,review", profs[0]?.expertise.join(","));
    check("missing expertise defaults to []", Array.isArray(profs[1]?.expertise) && profs[1]?.expertise.length === 0);
  } finally {
    try { unlinkSync(p); } catch { /* best effort */ }
  }
}
check("malformed JSON → [] (no throw)", (() => { const p = join(tmpdir(), `bad-${Date.now()}.json`); writeFileSync(p, "{not json"); try { return loadExecutorProfiles(p).length === 0; } finally { try { unlinkSync(p); } catch {} } })());

// ─── (5) rankExecutorsForKind ──────────────────────────────────────────────────
{
  const code = rankExecutorsForKind("code", FIXTURE);
  check("code ranking → 3 coders eligible", code.length === 3, String(code.length));
  check("code ranking excludes hermes & mimir", !code.some((r) => r.profile.id === "hermes" || r.profile.id === "mimir"));
  const research = rankExecutorsForKind("research", FIXTURE);
  check("research ranking → hermes first", research[0]?.profile.id === "hermes", research[0]?.profile.id);
  check("research ranking → gemini second", research[1]?.profile.id === "gemini", research[1]?.profile.id);
  check("research ranking → only 2 eligible (coders/mimir score 0)", research.length === 2, String(research.length));
  check("hermes research score = 7", research[0]?.score === 7, String(research[0]?.score));
  check("gemini research score = 5", research[1]?.score === 5, String(research[1]?.score));
}

// ─── (6) selectExecutorByExpertise — code leg defers ───────────────────────────
{
  const throwing: HealthProbe = async () => { throw new Error("must not be probed on a code leg"); };
  const d = await selectExecutorByExpertise({ text: "Implement the feature", profiles: FIXTURE, healthProbe: throwing });
  check("code leg → kind code", d.kind === "code");
  check("code leg → selected null", d.selected === null, d.selected ?? "null");
  check("code leg → deferToCoderChain true", d.deferToCoderChain === true);
  check("code leg → no candidates probed (no throw)", d.candidates.length === 0, String(d.candidates.length));
  check("code leg rationale mentions defer", d.rationale.includes("defer"));
}

// ─── (7) selectExecutorByExpertise — research leg resolves ─────────────────────
{
  const d = await selectExecutorByExpertise({ text: "Audit the security posture", profiles: FIXTURE, healthProbe: probeHealthy("hermes", "gemini") });
  check("research leg, hermes up → hermes selected", d.selected === "hermes", d.selected ?? "null");
  check("research leg → deferToCoderChain false", d.deferToCoderChain === false);
  check("research leg → first candidate reason selected", d.candidates[0]?.reason === "selected", d.candidates[0]?.reason);
  check("research leg rationale names the executor", d.rationale.includes("hermes"));
}
{
  const d = await selectExecutorByExpertise({ text: "Audit the security posture", profiles: FIXTURE, healthProbe: probeHealthy("gemini") }); // hermes down
  check("research leg, hermes down → gemini selected", d.selected === "gemini", d.selected ?? "null");
  check("research leg → hermes recorded unhealthy first", d.candidates[0]?.id === "hermes" && d.candidates[0]?.reason === "unhealthy", JSON.stringify(d.candidates[0]));
}

// ─── (8) selectExecutorByExpertise — degrade + never-throw ─────────────────────
{
  const d = await selectExecutorByExpertise({ text: "Investigate the outage", profiles: FIXTURE, healthProbe: probeHealthy() }); // none healthy
  check("research leg, none healthy → selected null", d.selected === null, d.selected ?? "null");
  check("research leg, none healthy → defer true", d.deferToCoderChain === true);
  check("research leg, none healthy → both research execs probed", d.candidates.length === 2, String(d.candidates.length));
}
{
  const d = await selectExecutorByExpertise({ text: "Investigate the outage", profiles: [], healthProbe: probeHealthy() });
  check("research leg, empty registry → defer with 'no research-capable' rationale", d.selected === null && d.rationale.includes("no research-capable"), d.rationale);
}
{
  const throwing: HealthProbe = async (id) => { if (id === "hermes") throw new Error("boom"); return { healthy: id === "gemini", message: id }; };
  const d = await selectExecutorByExpertise({ text: "Audit the flow", profiles: FIXTURE, healthProbe: throwing });
  check("throwing hermes probe → gemini still selected (no propagate)", d.selected === "gemini", d.selected ?? "null");
  check("throwing probe recorded unhealthy not crash", d.candidates[0]?.id === "hermes" && d.candidates[0]?.healthy === false);
}
{
  // Regression lock (consensus-mined, GLM + Kimi): a NON-Error throwable must not
  // produce "probe threw: undefined" — the message stringifies the thrown value.
  const throwsString: HealthProbe = async () => { throw "kaput"; };
  const d = await selectExecutorByExpertise({ text: "Audit the flow", profiles: FIXTURE, healthProbe: throwsString });
  check("non-Error throwable → clean message (not 'undefined')", d.candidates[0]?.message === "probe threw: kaput", d.candidates[0]?.message);
}

// ─── (9) end-to-end invariant D2 — a code leg NEVER routes to a non-coder ──────
{
  const d = await selectExecutorByExpertise({ text: "Implement the audit report generator and research prior art", profiles: FIXTURE, healthProbe: probeHealthy("hermes", "gemini") });
  check("D2 e2e: mixed code+research leg → kind code", d.kind === "code");
  check("D2 e2e: never selects hermes even when healthy", d.selected === null, d.selected ?? "null");
  check("D2 e2e: defers to coder chain", d.deferToCoderChain === true);
}

console.log(`\nexpertise-router selftest: ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
