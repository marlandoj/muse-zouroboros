#!/usr/bin/env bun
/**
 * ZOU-436 SF-P3 — Hermetic selftest for the multi-harness router.
 *
 * Fully sandboxed: injected fake healthProbe, NO real binaries, NO ExecutorClient
 * import, NO network, NO spend. Safe to run inside the conveyor smoke gate (step 8).
 * Guards harnessForAttempt clamping + selectHarness chain-walk / fallback / never-throw.
 *
 * Exit 0 = all cases pass, 1 = any failure.
 */

import {
  coderHarnessChain,
  type HealthProbe,
  harnessForAttempt,
  parseHarnessChainOverride,
  selectHarness,
} from "./harness-router";

const BASELINE_CHAIN = coderHarnessChain({});

let failures = 0;
function check(name: string, cond: boolean, detail = ""): void {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond || !detail ? "" : ` — ${detail}`}`);
  if (!cond) failures++;
}

/** Probe that reports the named ids healthy, everything else unhealthy. */
function probeHealthy(...healthy: string[]): HealthProbe {
  const set = new Set(healthy);
  return async (id: string) => ({ healthy: set.has(id), message: set.has(id) ? `${id} ok` : `${id} not found` });
}

console.log("harness-router selftest");

// (1) harnessForAttempt clamps to the chain bounds.
check("attempt 0 → claude-code", harnessForAttempt(0, BASELINE_CHAIN) === "claude-code", harnessForAttempt(0, BASELINE_CHAIN));
check("attempt 1 → opencode", harnessForAttempt(1, BASELINE_CHAIN) === "opencode", harnessForAttempt(1, BASELINE_CHAIN));
check("attempt 2 → codex", harnessForAttempt(2, BASELINE_CHAIN) === "codex", harnessForAttempt(2, BASELINE_CHAIN));
check("attempt 3 → gemini", harnessForAttempt(3, BASELINE_CHAIN) === "gemini", harnessForAttempt(3, BASELINE_CHAIN));
check("attempt 4 → pi", harnessForAttempt(4, BASELINE_CHAIN) === "pi", harnessForAttempt(4, BASELINE_CHAIN));
check("attempt 5 → kimi", harnessForAttempt(5, BASELINE_CHAIN) === "kimi", harnessForAttempt(5, BASELINE_CHAIN));
check("attempt 9 clamps → kimi", harnessForAttempt(9, BASELINE_CHAIN) === "kimi", harnessForAttempt(9, BASELINE_CHAIN));
check("attempt -3 clamps → claude-code", harnessForAttempt(-3, BASELINE_CHAIN) === "claude-code", harnessForAttempt(-3, BASELINE_CHAIN));
check("default chain contains all 6 coder harnesses", BASELINE_CHAIN.join(",") === "claude-code,opencode,codex,gemini,pi,kimi", BASELINE_CHAIN.join(","));

// (1b) SF_EXEC_HARNESS_CHAIN — the Model Policy executor pin.
check("unset override → null", parseHarnessChainOverride(undefined) === null);
check("empty override → null", parseHarnessChainOverride("") === null);
check("all-unknown override → null", parseHarnessChainOverride("gpt-9, nonsense") === null);
check(
  "override keeps declared order",
  parseHarnessChainOverride("kimi,pi,opencode,codex,gemini,claude-code")?.join(",") === "kimi,pi,opencode,codex,gemini,claude-code",
  String(parseHarnessChainOverride("kimi,pi,opencode,codex,gemini,claude-code")),
);
check(
  "override drops unknown ids and de-dupes",
  parseHarnessChainOverride(" opencode , rm-rf , opencode ,codex ")?.join(",") === "opencode,codex",
  String(parseHarnessChainOverride(" opencode , rm-rf , opencode ,codex ")),
);
check(
  "override wins over the default order",
  coderHarnessChain({ SF_EXEC_HARNESS_CHAIN: "pi,kimi,opencode" }).join(",") === "pi,kimi,opencode",
  coderHarnessChain({ SF_EXEC_HARNESS_CHAIN: "pi,kimi,opencode" }).join(","),
);
check(
  "unusable override falls back to the default chain",
  coderHarnessChain({ SF_EXEC_HARNESS_CHAIN: "," }).join(",") === "claude-code,opencode,codex,gemini,pi,kimi",
  coderHarnessChain({ SF_EXEC_HARNESS_CHAIN: "," }).join(","),
);
check(
  "single-harness pin is allowed",
  coderHarnessChain({ SF_EXEC_HARNESS_CHAIN: "opencode" }).join(",") === "opencode",
  coderHarnessChain({ SF_EXEC_HARNESS_CHAIN: "opencode" }).join(","),
);

// (2) all-healthy → picks chain[attempt]; decision shape well-formed.
{
  const d = await selectHarness({ attempt: 1, chain: BASELINE_CHAIN, healthProbe: probeHealthy(...BASELINE_CHAIN) });
  check("all-healthy attempt 1 → opencode", d.selected === "opencode", d.selected ?? "null");
  check("all-healthy no fallback", d.fellBackToAsk === false, String(d.fellBackToAsk));
  check("all-healthy 1 probed candidate (stops at first healthy)", d.candidates.length === 1, String(d.candidates.length));
  check("selected candidate reason=selected", d.candidates[0]?.reason === "selected", d.candidates[0]?.reason);
  check("decision echoes attempt", d.attempt === 1, String(d.attempt));
}

// (3) first-unhealthy → falls to next healthy, records the skipped one as unhealthy.
{
  const d = await selectHarness({ attempt: 0, chain: BASELINE_CHAIN, healthProbe: probeHealthy("codex") }); // claude-code and opencode down
  check("claude-code down → codex selected", d.selected === "codex", d.selected ?? "null");
  check("3 candidates recorded", d.candidates.length === 3, String(d.candidates.length));
  check("claude-code recorded unhealthy", d.candidates[0]?.id === "claude-code" && d.candidates[0]?.reason === "unhealthy", JSON.stringify(d.candidates[0]));
  check("no fallback (a harness was healthy)", d.fellBackToAsk === false, String(d.fellBackToAsk));
}

// (4) none-healthy → selected=null, fellBackToAsk=true, all 6 probed unhealthy.
{
  const d = await selectHarness({ attempt: 0, chain: BASELINE_CHAIN, healthProbe: probeHealthy() });
  check("none-healthy → selected null", d.selected === null, d.selected ?? "null");
  check("none-healthy → fellBackToAsk", d.fellBackToAsk === true, String(d.fellBackToAsk));
  check("none-healthy → all 6 probed", d.candidates.length === 6, String(d.candidates.length));
  check("none-healthy → all unhealthy", d.candidates.every((c) => c.reason === "unhealthy"), JSON.stringify(d.candidates.map((c) => c.reason)));
}

// (5) probe that throws is treated as unhealthy (never propagates).
{
  const throwing: HealthProbe = async (id: string) => {
    if (id === "claude-code") throw new Error("boom");
    return { healthy: id === "codex", message: `${id}` };
  };
  const d = await selectHarness({ attempt: 0, chain: BASELINE_CHAIN, healthProbe: throwing });
  check("throwing probe → codex still selected", d.selected === "codex", d.selected ?? "null");
  check("throwing probe recorded unhealthy (not crash)", d.candidates[0]?.id === "claude-code" && d.candidates[0]?.healthy === false, JSON.stringify(d.candidates[0]));
}

// (6) attempt beyond chain wraps but still finds a healthy harness.
{
  const d = await selectHarness({ attempt: 5, chain: BASELINE_CHAIN, healthProbe: probeHealthy("claude-code") }); // start kimi, wrap to claude-code
  check("attempt 5 start kimi, only claude-code up → wraps to claude-code", d.selected === "claude-code", d.selected ?? "null");
}

// (7) clamp hardening (consensus-mined): non-finite attempt coerces to index 0.
check("NaN attempt → claude-code (coerced to 0)", harnessForAttempt(NaN, BASELINE_CHAIN) === "claude-code", harnessForAttempt(NaN, BASELINE_CHAIN));
check("Infinity attempt → claude-code (non-finite coerced to 0)", harnessForAttempt(Infinity, BASELINE_CHAIN) === "claude-code", harnessForAttempt(Infinity, BASELINE_CHAIN));
check("large finite attempt clamps → kimi", harnessForAttempt(999, BASELINE_CHAIN) === "kimi", harnessForAttempt(999, BASELINE_CHAIN));
{
  const d = await selectHarness({ attempt: NaN, chain: BASELINE_CHAIN, healthProbe: probeHealthy(...BASELINE_CHAIN) });
  check("NaN attempt in selectHarness → claude-code", d.selected === "claude-code", d.selected ?? "null");
}

// (8) empty-chain hardening (consensus-mined): harnessForAttempt throws; selectHarness
//     degrades safely to fallback rather than returning an undefined harness id.
{
  let threw = false;
  try { harnessForAttempt(0, []); } catch { threw = true; }
  check("empty chain → harnessForAttempt throws (signals misconfig)", threw);
  const d = await selectHarness({ attempt: 0, chain: [], healthProbe: probeHealthy("claude-code") });
  check("empty chain → selectHarness selected=null (safe fallback, no undefined id)", d.selected === null, d.selected ?? "null");
  check("empty chain → fellBackToAsk", d.fellBackToAsk === true, String(d.fellBackToAsk));
}

console.log(`\nharness-router selftest: ${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
