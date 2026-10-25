// Verity hybrid Phase 2: the relaunch feedback, rendered by the engine so
// `verity run` and the orchestrator's gate say the same thing.
//
// The block is the verdict's message, then (for a verdict that did not pass
// and whose trusted check ran) the last 40 lines of the check log, in the
// orchestrator's wording (verity-gate.ts FEEDBACK_TAIL_LINES). Credentials are
// named by path and label only: any credential-shaped value in the log tail is
// replaced by `[redacted: <label>]` before it is shown.
import fs from "node:fs";
import { findSecrets } from "./checks.js";

export const FEEDBACK_TAIL_LINES = 40;

export function tailLines(text, n = FEEDBACK_TAIL_LINES) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/** Replace every credential-shaped value with its label. */
export function redact(text) {
  let out = String(text);
  const hits = findSecrets(out).sort((a, b) => b.value.length - a.value.length);
  for (const s of hits) if (s.value) out = out.split(s.value).join(`[redacted: ${s.label}]`);
  return out;
}

/**
 * The feedback text for a verdict: message, plus the redacted check-log tail
 * when the verdict did not pass and a trusted check ran. `checkLog` defaults
 * to the verdict's own `check.log`.
 */
export function renderFeedback(verdict, { checkLog } = {}) {
  const v = verdict || {};
  let feedback = String(v.message ?? `Verity: ${v.decision ?? "error"}`);
  const log = checkLog ?? (v.check && v.check.log) ?? null;
  if (v.check && v.check.command && log && v.decision !== "pass") {
    try {
      const tail = redact(tailLines(fs.readFileSync(log, "utf8"), FEEDBACK_TAIL_LINES));
      if (tail) feedback += `\n\nLast ${FEEDBACK_TAIL_LINES} lines of the trusted check (\`${v.check.command}\`, exit ${v.check.exitCode}):\n${tail}`;
    } catch {
      // no log: the message alone
    }
  }
  return feedback;
}

/** The run's feedback file: the block a relaunched (or resumed) session reads. */
export function renderRelaunchBlock(verdict, { runId = null, checkLog } = {}) {
  const v = verdict || {};
  return `<verity-run-feedback${runId ? ` run="${runId}"` : ""} decision="${v.decision ?? "error"}">
Verity checked the workspace when the session ended. A finish counts only when the workspace itself passes: code changes need the trusted check to pass, tests are never deleted or renamed away, no credential text is written into files, and the check's own definition is not edited in the same change.
${renderFeedback(v, { checkLog })}
</verity-run-feedback>
`;
}
