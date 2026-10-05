const BUN_SUMMARY_LINE = /^(?:Ran \d+ tests? across|\d+ (?:pass|fail)|\d+ expect\(\) calls)/;
const ACTIONABLE_FAILURE = /^(?:error:|ENOENT:|E[A-Z]+:)|Cannot find module|timed? ?out/i;
/**
 * Selftests that narrate their own checks print passing lines that collide with
 * the actionable-failure vocabulary — `pool-selftest` emits
 * "✅ timeout → stale + retry + redispatch same cycle", which the unanchored
 * `timed? ?out` alternation matches. Reporting a green check as the abort reason
 * hid the failing check from the operator entirely, so a passing line is never a
 * failure detail regardless of the words in it.
 */
const SUCCESS_LINE = /^[\s>]*(?:✅|✓|√|\[ok\]|PASS\b)/i;
const FAILURE_LINE = /^[\s>]*(?:❌|✗|✘|×|\[fail\]|FAIL\b)/i;

export interface SpawnFailureContext {
  error?: (Error & { code?: string }) | null;
  signal?: NodeJS.Signals | string | null;
  timeoutMs?: number;
}

export function spawnFailureDetail(context?: SpawnFailureContext): string | null {
  if (!context) return null;
  const errorCode = context.error?.code?.toUpperCase();
  const signal = context.signal ? `; signal ${context.signal}` : "";
  if (errorCode === "ETIMEDOUT") {
    const duration = context.timeoutMs === undefined ? "" : ` after ${context.timeoutMs} ms`;
    return `subprocess timed out${duration}${signal}`;
  }
  if (context.error) {
    const code = errorCode ? ` ${errorCode}` : "";
    return `subprocess spawn error${code}: ${context.error.message}${signal}`.slice(0, 600);
  }
  if (context.signal) return `subprocess terminated by signal ${context.signal}`;
  return null;
}

export function bunTestFailureDetail(
  code: number,
  out: string,
  err: string,
  processFailure?: SpawnFailureContext,
): string {
  const processDetail = spawnFailureDetail(processFailure);
  if (processDetail) return processDetail;
  const lines = `${err}\n${out}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const reportable = (line: string): boolean => !BUN_SUMMARY_LINE.test(line) && !SUCCESS_LINE.test(line);
  const actionableIndex = lines.findIndex((line) => reportable(line) && ACTIONABLE_FAILURE.test(line));
  if (actionableIndex >= 0) {
    return lines
      .slice(actionableIndex, actionableIndex + 4)
      .filter(reportable)
      .slice(0, 3)
      .join(" | ")
      .slice(0, 600);
  }
  const failedCheck = lines.find((line) => line.startsWith("(fail)") || FAILURE_LINE.test(line));
  if (failedCheck) return failedCheck.slice(0, 600);
  const fallback = [...lines].reverse().find(reportable);
  return fallback?.slice(0, 600) ?? `exit ${code}`;
}

/**
 * The conveyor evaluates `runtime-config.ts export-env` before the smoke gate, so
 * every probe the harness spawns inherits live production flags. The self-tests are
 * written against the unset defaults they see standalone and in CI, so a flag flip
 * silently rewrites their behaviour: `FACTORY_PERSONA_ROUTING_MODE=shadow` makes
 * `factory-review-gate.test.ts` resolve the *live* persona directory over the network,
 * and it plus `FACTORY_REVIEW_GATE_MODE=enforce` each break `pool-selftest` dispatch.
 * Both fail closed and abort the cycle with no code defect anywhere. Flags are stripped
 * by namespace rather than an enumerated list so a newly added flag cannot reintroduce
 * the leak.
 */
const RUNTIME_FLAG_NAMESPACE = /^(?:FACTORY_|SF_|SF\d+_|PLAN_GATE_|OUTCOME_EVIDENCE_|ZOUROBOROS_PLAN_GATE_)/;

export function hermeticSmokeProbeEnv(
  stateRoot: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (RUNTIME_FLAG_NAMESPACE.test(key)) continue;
    env[key] = value;
  }
  return {
    ...env,
    FACTORY_STATE_DIR: stateRoot,
    FACTORY_STATE_MODE: "test",
    FACTORY_STATE_ALLOW_OUTSIDE_ROOT: "1",
    FACTORY_CODING_CASCADE: "off",
  };
}
