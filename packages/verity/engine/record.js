// Verity hybrid Phase 2: CLI verdicts (run, gate, prepush) in the hooks'
// verdict store, $VERITY_LOG else $VERITY_HOME/verdicts.jsonl, in the line
// shape scripts/report.sh already reads, with `surface: "cli"`.
//
// Kind mapping (the memo's): a secret or test-deletion finding is `deny`;
// no passing check (including an unverifiable change, which has none) is
// `done`; a pass is `none`; a gate that could not answer is `error`.
// `ms` is the gate's own overhead: wall time minus the trusted check's run.
//
// Provenance only, as the hook ledger: rule, path and label per finding,
// never a fingerprint, value, file content or check output.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function verityHome(env = process.env) {
  return env.VERITY_HOME || path.join(env.HOME || os.homedir(), ".verity");
}

export function verdictStore(env = process.env) {
  return env.VERITY_LOG || path.join(verityHome(env), "verdicts.jsonl");
}

const DENY_RULES = new Set(["secret", "test_deletion", "repo_removed"]);

/** deny | done | none | error for one verdict object ({decision, findings}). */
export function kindFor(verdict) {
  const d = verdict && verdict.decision;
  if (d === "pass") return "none";
  if (d === "error" || !d) return "error";
  const findings = Array.isArray(verdict.findings) ? verdict.findings : [];
  if (findings.some((f) => DENY_RULES.has(f.rule) && f.severity !== "info")) return "deny";
  return "done";
}

export function provenance(findings) {
  return (Array.isArray(findings) ? findings : []).map((f) => ({
    rule: f.rule,
    ...(f.path ? { path: f.path } : {}),
    ...(f.label ? { label: f.label } : {}),
    ...(f.severity ? { severity: f.severity } : {}),
    ...(f.renamedTo ? { renamedTo: f.renamedTo } : {}),
    ...(f.detail ? { detail: f.detail } : {}),
    ...(f.allowed ? { allowed: true } : {}),
  }));
}

/**
 * Append one CLI verdict line. `verdict` is a swarm-shaped verdict (or a
 * prepush one); `extra` adds top-level fields (attribution, downgraded, ...)
 * and `detail` adds verdict fields (childExit, signal, ...). Returns the line.
 * Never throws: a store that cannot be written loses the line, not the run.
 */
export function appendCliVerdict({ event, harness = "cli", mode, applied = false, runId = null, cwd = null, verdict, wallMs = 0, extra = {}, detail = {}, env = process.env }) {
  const checkMs = verdict && verdict.check && typeof verdict.check.durationMs === "number" ? verdict.check.durationMs : 0;
  const line = {
    ts: new Date().toISOString(),
    ms: Math.max(0, Math.round(wallMs - checkMs)),
    checkMs,
    surface: "cli",
    harness,
    mode,
    kind: kindFor(verdict),
    applied,
    event,
    session: runId,
    cwd,
    tool: null,
    target: null,
    bytes: 0,
    ...extra,
    verdict: {
      decision: verdict ? verdict.decision : "error",
      reason: verdict ? String(verdict.message ?? verdict.error ?? "") : "",
      findings: provenance(verdict && verdict.findings),
      code: verdict && verdict.changes ? (verdict.changes.code || []).length : 0,
      ...(verdict && verdict.changes && verdict.changes.truncated ? { truncated: true, ...(verdict.changes.truncatedReason ? { truncatedReason: verdict.changes.truncatedReason } : {}) } : {}),
      ...(verdict && verdict.check ? { check: { command: verdict.check.command ?? null, exitCode: verdict.check.exitCode ?? null, source: verdict.check.source ?? null, ...(verdict.check.skipped ? { skipped: verdict.check.skipped } : {}) } } : {}),
      ...detail,
    },
  };
  try {
    const file = verdictStore(env);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.appendFileSync(file, JSON.stringify(line) + "\n", { mode: 0o600 });
  } catch {
    // the run's own verdict file still holds it
  }
  return line;
}
