#!/usr/bin/env bun
/**
 * Conveyor pre-flight smoke test — step 0 of the [SYS] Factory Conveyor.
 *
 * A fast health gate. If this exits NON-ZERO the conveyor aborts the cycle
 * BEFORE any pull/validate/dispatch/execute and emails the operator. It must
 * never hit Linear, call the decision gate, or spend.
 *
 * ONE intentional state write, up front: a best-effort pre-flight REAP of
 * provably-dead orphaned exec records (reap-stale-execs.ts). This runs before
 * the checks — and, critically, before the conveyor's later in-flight cap counts
 * those ghosts — so a process that died mid-run (Zo 30-min cap, turn end, crash)
 * can't halt dispatch forever. The reaper only closes records that are BOTH
 * stale AND have no live process, is idempotent, and its outcome NEVER changes
 * this script's exit code. (ZOU-462 stalled this way 2026-07-05.)
 *
 * The health checks themselves stay side-effect-free. They only:
 *   1. checks required env (LINEAR_API_KEY — the puller exits 2 without it),
 *   2. runs each pipeline script's `--help`/`status` (exits before any real
 *      work, so a syntax/import error surfaces here instead of mid-cycle),
 *   3. feeds an empty { valid, rejected } wrapper to the dispatcher to prove it
 *      still unwraps ticket-contract's output shape (regression guard for the
 *      "undefined is not a function (…ticket of tickets…)" dispatch failure),
 *   4. confirms shadow-state reports a recognized phase.
 *
 * Usage: bun conveyor-smoke-test.ts   (exit 0 = healthy, exit 1 = abort cycle)
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDeployRootFreshness } from "./deploy-root-freshness";
import { ensureDeployRootReady, findWorkspaceRoot } from "./deploy-root-readiness";
import { normalizeExecutionLifecycle } from "./execution-lifecycle";
import { bunTestFailureDetail, hermeticSmokeProbeEnv } from "./smoke-diagnostics";

const HERE = import.meta.dir;
const POOL_SELFTEST_TIMEOUT_MS = 60_000;
const failures: string[] = [];

function check(name: string, ok: boolean, detail = ""): void {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${ok || !detail ? "" : ` — ${detail}`}`);
  if (!ok) failures.push(detail ? `${name}: ${detail}` : name);
}

/** Run a script with cheap args that exit before side effects. */
function runProbe(script: string, args: string[], stdin?: string): { code: number; out: string; err: string } {
  const r = spawnSync("bun", [join(HERE, script), ...args], {
    encoding: "utf-8",
    input: stdin,
    timeout: 20_000,
  });
  return { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
}

function runHermeticProbe(
  script: string,
  args: string[],
  stdin?: string,
  timeout = 20_000,
): { code: number; out: string; err: string; detail: string } {
  const stateRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-smoke-"));
  try {
    const r = spawnSync("bun", [join(HERE, script), ...args], {
      encoding: "utf-8",
      env: hermeticSmokeProbeEnv(stateRoot),
      input: stdin,
      timeout,
    });
    const result = { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
    return {
      ...result,
      detail: bunTestFailureDetail(result.code, result.out, result.err, {
        error: r.error,
        signal: r.signal,
        timeoutMs: timeout,
      }),
    };
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

/**
 * `bun test` applies a 5s per-test default, so a probe the harness budgets 20s
 * for could abort the whole cycle on a single test that merely waited on a
 * contended 9p stat or Git lock — the exact contention `defaultDeterministicReview`
 * already budgets 120s for. The spawn cap below stays the real contract; the
 * per-test cap is raised to match it instead of silently preempting it.
 *
 * The spawn cap is a whole-suite budget, so it has to cover the slowest suite, not
 * the slowest test. `ship-ready-runner.test.ts` drives 39 git-backed cases and
 * measures 7.4s idle but 19.4s under load on the single-CPU host — inside the old
 * 20s cap by a margin thin enough to abort a live cycle. 60s restores headroom
 * while the 15s per-test cap stays the guard against a genuinely hung test.
 */
const TEST_PROBE_TIMEOUT_MS = 60_000;
const PER_TEST_TIMEOUT_MS = 15_000;

function runTestProbe(script: string): { code: number; out: string; err: string; detail: string } {
  const stateRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-smoke-"));
  try {
    const r = spawnSync("bun", ["test", "--timeout", String(PER_TEST_TIMEOUT_MS), join(HERE, script)], {
      encoding: "utf-8",
      env: hermeticSmokeProbeEnv(stateRoot),
      timeout: TEST_PROBE_TIMEOUT_MS,
    });
    const result = { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
    return {
      ...result,
      detail: bunTestFailureDetail(result.code, result.out, result.err, {
        error: r.error,
        signal: r.signal,
        timeoutMs: TEST_PROBE_TIMEOUT_MS,
      }),
    };
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

/**
 * ZOU-1581: the 2026-09-01 cycle aborted on a fixture defect that main had
 * already fixed, because the release-bound root it ran from was four commits
 * behind. Nothing surfaced that, so triage chased a phantom regression.
 *
 * This is deliberately advisory and offline. It reads only the local
 * remote-tracking ref — no fetch, no network — so it can never fail-close the
 * gate or stall it on a dead remote. A stale local ref yields a false negative
 * (silence), never a false positive: if the local ref is genuinely ahead of
 * HEAD, this root is definitively behind.
 */
function reportCheckoutFreshness(): void {
  const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: HERE, encoding: "utf-8", timeout: 10_000 });
  if (head.status !== 0) return;
  for (const ref of ["zbr/main", "origin/main"]) {
    const behind = spawnSync("git", ["rev-list", "--count", `HEAD..${ref}`], {
      cwd: HERE,
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (behind.status !== 0) continue;
    const count = Number.parseInt((behind.stdout ?? "").trim(), 10);
    if (!Number.isFinite(count)) continue;
    // Same-lineage proof. `/home/workspace` carries a disabled meta-repo `origin`
    // whose main shares no history with the factory repo, so a bare commit count
    // against the wrong ref would be noise. Warn only when HEAD is a true
    // ancestor of the ref — that is unambiguously "behind", never divergent.
    const sameLineage = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", ref], {
      cwd: HERE,
      encoding: "utf-8",
      timeout: 10_000,
    });
    if (sameLineage.status !== 0) continue;
    if (count > 0) {
      console.log(
        `  ⚠ release-bound checkout is ${count} commit(s) behind ${ref} `
        + `(${head.stdout.trim().slice(0, 9)}) — a failure below may already be fixed on main`,
      );
    }
    return;
  }
}

console.log("conveyor smoke test");
reportCheckoutFreshness();

const readiness = ensureDeployRootReady(HERE);
check(
  "deploy root is dependency-ready (node_modules + built dist entrypoints)",
  readiness.ok,
  readiness.detail,
);
if (readiness.healed && readiness.ok) console.log(`  … ${readiness.detail}`);

// The conveyor automation binds this root by path, not by commit, so nothing
// advances it when canonical main moves. Advisory by default — a hard gate here
// would halt the conveyor on every merge. FACTORY_ROOT_DRIFT_ENFORCE=1 blocks.
const freshness = checkDeployRootFreshness(findWorkspaceRoot(HERE) ?? HERE);
if (freshness.applicable) {
  check("deploy root freshness vs canonical main", freshness.ok, freshness.detail);
  if (freshness.ok) {
    const drifted = freshness.upstream !== null && freshness.upstream !== freshness.head;
    console.log(`  ${drifted || freshness.nameMatchesHead === false ? "⚠" : "…"} ${freshness.detail}`);
  }
}

check(
  "canonical lifecycle resolver normalizes legacy conveyor records",
  normalizeExecutionLifecycle({ status: "complete" }).state === "implementation_complete"
    && normalizeExecutionLifecycle({ status: "pending-implementation", stage: "executing" }).state === "executing"
    && normalizeExecutionLifecycle({ status: "pool-enqueued", stage: "pool-enqueued" }).state === "pool_enqueued",
);

const swarmExecSrc = existsSync(join(HERE, "swarm-exec.ts")) ? readFileSync(join(HERE, "swarm-exec.ts"), "utf-8") : "";
check(
  "pool enqueue guarantees a reconciled or visibly held handoff",
  swarmExecSrc.includes("await reconcilePoolHandoff(")
    && swarmExecSrc.includes('transitionExecution(exec, "held", "pool-handoff"')
    && swarmExecSrc.includes("exec.pool_handoff = handoff"),
  "pool-enqueued must not rely on an unwired future reconcile",
);
check(
  "new executions write canonical state without a pending implementation handoff",
  swarmExecSrc.includes("...createExecutionLifecycle")
    && swarmExecSrc.includes('status: dryRun ? "dry-run" : "executing"')
    && !swarmExecSrc.includes('status: dryRun ? "dry-run" : "pending-implementation"')
    && swarmExecSrc.includes("runExecutorChain({")
    && swarmExecSrc.includes('exec.status = "complete"'),
  "DIRECT/SUGGEST must execute through the harness chain and persist a terminal state",
);

check(
  "auto-merge requires verification and records the PR-to-merge lifecycle",
  swarmExecSrc.includes('if (lifecycle.state !== "verified" || !hasProvenDeliveryState(lifecycle, "verified")) return;')
    && swarmExecSrc.includes('if (result.decision === "merged")')
    && swarmExecSrc.includes('transitionExecution(exec, "pr_ready"')
    && swarmExecSrc.includes('transitionExecution(exec, "ci_green"')
    && swarmExecSrc.includes('transitionExecution(exec, "merged"'),
  "verified auto-merge lifecycle wiring missing",
);

const shadowValidateSrc = existsSync(join(HERE, "shadow-validate.ts")) ? readFileSync(join(HERE, "shadow-validate.ts"), "utf-8") : "";
check(
  "canonical summaries retain complete and pending compatibility aliases",
  shadowValidateSrc.includes("complete: implementationComplete")
    && shadowValidateSrc.includes("pending,")
    && swarmExecSrc.includes("complete: implementationComplete")
    && swarmExecSrc.includes("pending,"),
);

const mutationEvidenceSrc = existsSync(join(HERE, "factory-state-mutation-evidence.ts"))
  ? readFileSync(join(HERE, "factory-state-mutation-evidence.ts"), "utf-8")
  : "";
const laneSrc = existsSync(join(HERE, "lane-utilization.ts")) ? readFileSync(join(HERE, "lane-utilization.ts"), "utf-8") : "";
const productGateSrc = existsSync(join(HERE, "product-lifecycle-gate.ts")) ? readFileSync(join(HERE, "product-lifecycle-gate.ts"), "utf-8") : "";
const sloSrc = existsSync(join(HERE, "factory-slo.ts")) ? readFileSync(join(HERE, "factory-slo.ts"), "utf-8") : "";
const claimSrc = existsSync(join(HERE, "ticket-claim.ts")) ? readFileSync(join(HERE, "ticket-claim.ts"), "utf-8") : "";
const reaperSrc = existsSync(join(HERE, "reap-stale-execs.ts")) ? readFileSync(join(HERE, "reap-stale-execs.ts"), "utf-8") : "";
check(
  "typed singleton and claim mutation evidence is wired to every production owner",
  mutationEvidenceSrc.includes("recordFactoryStateAtomicReplacement")
    && laneSrc.includes("recordFactoryStateAtomicReplacement({")
    && productGateSrc.includes("recordFactoryStateAtomicReplacement({")
    && sloSrc.includes("recordFactoryStateAtomicReplacement({")
    && claimSrc.includes("releaseClaimWithEvidence(")
    && reaperSrc.includes("claim_evidence_receipts"),
  "lane, product, SLO, and claim owners must share the typed mutation evidence contract",
);

// 0. Pre-flight self-heal: close provably-dead orphaned exec records BEFORE the
//    checks (and before the conveyor's later in-flight cap counts them as ghosts
//    that halt dispatch). Best-effort: the reaper only closes stale records with
//    no live process, is idempotent, and its result NEVER affects our exit code.
try {
  const r = spawnSync("bun", [join(HERE, "reap-stale-execs.ts")], { encoding: "utf-8", timeout: 20_000 });
  const lastLine = (r.stdout ?? "").trim().split("\n").filter(Boolean).slice(-1)[0] ?? "";
  let reaped = 0;
  try {
    reaped = JSON.parse(lastLine).reaped ?? 0;
  } catch {
    /* non-JSON / reaper missing ⇒ treat as 0, never fail the gate */
  }
  console.log(`  ⟳ pre-flight reaper: closed ${reaped} orphaned exec record(s)`);
} catch (e) {
  console.log(`  ⟳ pre-flight reaper skipped — ${(e as Error).message} (non-fatal)`);
}

// 1. Required env.
check("LINEAR_API_KEY set", Boolean(process.env.LINEAR_API_KEY), "puller exits 2 without it");

// 2. Pipeline scripts exist and are runnable (--help exits before any real work).
const helpScripts = ["linear-puller.ts", "ticket-contract.ts", "dispatcher.ts", "swarm-exec.ts", "prespec-runner.ts"];
for (const s of helpScripts) {
  if (!existsSync(join(HERE, s))) {
    check(`${s} exists`, false, "missing pipeline script");
    continue;
  }
  const { code, err } = runProbe(s, ["--help"]);
  check(`${s} --help parses (exit 0)`, code === 0, err.trim().split("\n").slice(-1)[0]);
}

// 3. Dispatcher unwraps the { valid, rejected } wrapper ticket-contract emits.
//    Empty valid ⇒ [] ⇒ prints "[]" and exits 0 with NO gate call / network.
//    The pre-fix dispatcher crashed here ("undefined is not a function").
if (existsSync(join(HERE, "dispatcher.ts"))) {
  const { code, out, err } = runProbe("dispatcher.ts", ["--dry-run", "--tickets", "-"], '{"valid":[],"rejected":[]}');
  const combined = `${out}\n${err}`;
  check(
    "dispatcher unwraps {valid,rejected} (empty ⇒ exit 0)",
    code === 0 && !/undefined is not a function/.test(combined),
    err.trim().split("\n").slice(-1)[0],
  );
}

// 4. Puller emits COMPACT single-line JSON (conveyor pipes stdout to a file and
//    documents this shape; a pretty-printed queue reads as empty under `tail -1`).
const pullerSrc = existsSync(join(HERE, "linear-puller.ts")) ? readFileSync(join(HERE, "linear-puller.ts"), "utf-8") : "";
check(
  "linear-puller emits single-line JSON",
  /JSON\.stringify\(tickets\)\s*\)/.test(pullerSrc) && !/JSON\.stringify\(tickets,\s*null,\s*2\)/.test(pullerSrc),
  "expected console.log(JSON.stringify(tickets)) — not pretty-printed",
);

// 5. Shadow-state reports a recognized phase.
if (existsSync(join(HERE, "shadow-state.ts"))) {
  const { code, out } = runProbe("shadow-state.ts", ["status"]);
  const phaseOk = code === 0 && /\b(idle|dry-run|shadow-pr|live)\b/.test(out);
  check("shadow-state status reports a phase", phaseOk, `exit ${code}`);
}

// 6. ZOU-437 SF-P3 pre-spec self-test — fully sandboxed (injected fetch/gate/
//    interview, no Linear/no spend), so it is safe in the health gate. Guards the
//    always-on consume-guard + candidate selection + freshness logic against drift.
if (existsSync(join(HERE, "prespec-selftest.ts"))) {
  const { code, err } = runProbe("prespec-selftest.ts", []);
  check("prespec-selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}

// 7. ZOU-438 SF-P3 self-evolving pipeline self-test — fully hermetic (synthetic seeds
//    + injected I/O, no network/no spend, real evaluations/ + state/ untouched). Guards
//    the schema-tolerant pattern detectors, propose-don't-apply gap logic, and ledger
//    idempotency against drift.
if (existsSync(join(HERE, "pattern-promotion-selftest.ts"))) {
  const { code, err } = runProbe("pattern-promotion-selftest.ts", []);
  check("pattern-promotion-selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}

// 8. ZOU-436 SF-P3 multi-harness router self-test — fully hermetic (injected fake
// healthProbe, no ExecutorClient import, no binaries/network/spend). Guards the
// attempt-clamp + chain-walk / health-fallback / never-throw routing logic against drift.
if (existsSync(join(HERE, "harness-router-selftest.ts"))) {
  const { code, err } = runProbe("harness-router-selftest.ts", []);
  check("harness-router-selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}
if (existsSync(join(HERE, "executor-runner.test.ts"))) {
  const { code, detail } = runTestProbe("executor-runner.test.ts");
  check("executor-runner lifecycle tests pass (exit 0)", code === 0, detail);
}

// 9. SF-P4 expertise-router self-test — fully hermetic (injected fake healthProbe +
// fixture profiles, no ExecutorClient import, no binaries/network/spend). Guards the
// deterministic classifier (incl. invariant D2: a code leg never routes to a
// non-coder), registry-profile loading, and research-executor resolution against drift.
if (existsSync(join(HERE, "expertise-router-selftest.ts"))) {
  const { code, err } = runProbe("expertise-router-selftest.ts", []);
  check("expertise-router-selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}

// 10. ZOU-435 SF-P3 learned auto-approval self-test — hermetic (synthetic ledger
//    fixtures, no real ledger/Linear/network). Guards the per-archetype reputation
//    core + distinct-ticket dedup + autoPromoteEligible integration against drift.
//    Advisory flags (default-safe): SF002_REPUTATION (on = compute+log the earned-
//    credit baseline; never changes the decision) and SF002_REPUTATION_ENFORCE
//    (off = the per-archetype baseline replaces the flat global ≥20 baseline in the
//    auto-promote lane; itself doubly-gated behind SF002_AUTO_PROMOTE + SF002_ENFORCE).
if (existsSync(join(HERE, "reputation-selftest.ts"))) {
  const { code, err } = runProbe("reputation-selftest.ts", []);
  check("reputation-selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}

// 11. Observation Deck P0/P3 self-tests — fully hermetic (tmpdir journals /
//    synthetic events, no network/spend; real state/flight untouched). Guard the
//    fail-open recorder (journal round-trip, corrupt-line tolerance, retention)
//    and the pure flight-status aggregator (live/terminal classification,
//    executor rotation, torn-write guard, stale flagging) against drift.
if (existsSync(join(HERE, "flight-recorder-selftest.ts"))) {
  const { code, err } = runProbe("flight-recorder-selftest.ts", []);
  check("flight-recorder-selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}
if (existsSync(join(HERE, "flight-status-selftest.ts"))) {
  const { code, err } = runProbe("flight-status-selftest.ts", []);
  check("flight-status-selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}

// 12. L1 ship-ready scan self-test — fully hermetic (tmpdir synthetic exec records +
//    injected unshipped-identifier set; the --selftest path NEVER calls Linear/spends).
//    Guards the complete∩pullable-twin join (incl. the pr_number false-positive guard,
//    retry-supersedes-complete dedup, and Linear-outage fail-safe) against drift.
if (existsSync(join(HERE, "ship-ready-scan.ts"))) {
  const { code, err } = runProbe("ship-ready-scan.ts", ["--selftest"]);
  check("ship-ready-scan selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}
if (existsSync(join(HERE, "ship-ready-runner.ts"))) {
  const help = runProbe("ship-ready-runner.ts", ["--help"]);
  check("ship-ready-runner --help parses (exit 0)", help.code === 0, help.err.trim().split("\n").slice(-1)[0]);
  const { code, detail } = runTestProbe("ship-ready-runner.test.ts");
  check("ship-ready-runner durable handoff tests pass (exit 0)", code === 0, detail);
}

// 13. Wave 1 failure-cycle contract — hermetic tmpdir tests prove strike one
// retries, strike two parks/notifies once, and strike three never dispatches.
if (existsSync(join(HERE, "failure-fingerprint.test.ts"))) {
  const { code, detail } = runTestProbe("failure-fingerprint.test.ts");
  check("failure-fingerprint tests pass (exit 0)", code === 0, detail);
}

// 14. ZOU-599 policy/review production wiring — assert swarm-exec folds the
//     ZOU-528 Model Policy and ZOU-500 outcome route into a SINGLE ExecutionPolicy
//     scope (the double-apply is gone), threads that policy into the pool handoff,
//     invokes the factory review gate with an enforce-only verified advance, and
//     routes review through independent personas without a model-consensus call.
const policyPoolHandoff = /executePoolEnqueue\(\s*d\s*,\s*execution_id\s*,\s*executionPolicy\s*,\s*riskTier(?:\s*,\s*[A-Za-z_$][\w$]*)*\s*\)/
  .test(swarmExecSrc);
check(
  "ZOU-599 single-scope policy + review gate wired into swarm-exec",
  swarmExecSrc.includes("executionPolicy && !poolRoute")
    && swarmExecSrc.includes("applyModelPolicy(executionPolicy)")
    && policyPoolHandoff
    && swarmExecSrc.includes("runFactoryReviewGate({")
    && swarmExecSrc.includes("prepareFactoryDiversityReview({")
    && swarmExecSrc.includes('transitionExecution(exec, "held", "diversity-review"')
    && swarmExecSrc.includes("Do not invoke MoA or a model-based Consensus Gate")
    && swarmExecSrc.includes('transitionExecution(exec, "verified", "factory-review"')
    && !swarmExecSrc.includes("gateCompletedExecution(exec)")
    && !swarmExecSrc.includes("outcomePolicyApplied"),
  "swarm-exec must fold policy into one scope and route review through the bounded persona resolver",
);

// 15. ZOU-599 policy + review contracts — hermetic tests prove the single active
//     scope guard (double-apply throws) and the proportional review escalation
//     (deterministic plus bounded persona review, with model consensus absent).
if (existsSync(join(HERE, "model-policy.test.ts"))) {
  const { code, detail } = runTestProbe("model-policy.test.ts");
  check("model-policy tests pass (exit 0)", code === 0, detail);
}
if (existsSync(join(HERE, "factory-review-gate.test.ts"))) {
  const { code, detail } = runTestProbe("factory-review-gate.test.ts");
  check("factory-review-gate tests pass (exit 0)", code === 0, detail);
}
if (existsSync(join(HERE, "factory-diversity-review.test.ts"))) {
  const { code, detail } = runTestProbe("factory-diversity-review.test.ts");
  check("factory-diversity-review tests pass (exit 0)", code === 0, detail);
}
const personaHeldout = join(HERE, "..", "evaluations", "fixtures", "persona-routing", "persona-routing-heldout.test.ts");
if (existsSync(personaHeldout)) {
  const stateRoot = mkdtempSync(join(tmpdir(), "factory-conveyor-smoke-"));
  try {
    const r = spawnSync("bun", ["test", personaHeldout], {
      encoding: "utf-8",
      env: hermeticSmokeProbeEnv(stateRoot),
      timeout: 30_000,
    });
    const result = { code: r.status ?? 1, out: r.stdout ?? "", err: r.stderr ?? "" };
    check(
      "template-associated persona held-out tests pass (exit 0)",
      result.code === 0,
      bunTestFailureDetail(result.code, result.out, result.err, {
        error: r.error,
        signal: r.signal,
        timeoutMs: 30_000,
      }),
    );
  } finally {
    rmSync(stateRoot, { recursive: true, force: true });
  }
}

if (existsSync(join(HERE, "pool-selftest.ts"))) {
  const { code, detail } = runHermeticProbe("pool-selftest.ts", [], undefined, POOL_SELFTEST_TIMEOUT_MS);
  check("pool recovery and handoff selftest passes (exit 0)", code === 0, detail);
}
if (existsSync(join(HERE, "cycle-contract-selftest.ts"))) {
  const { code, err } = runProbe("cycle-contract-selftest.ts", []);
  check("cycle-contract handoff evidence selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}

// 16. ZOU-785 product lifecycle gate — hermetic context, Linear, audit, and
//     dispatcher/prespec wiring probes. No network, production state, or spend.
if (existsSync(join(HERE, "product-lifecycle-gate-selftest.ts"))) {
  const { code, err } = runProbe("product-lifecycle-gate-selftest.ts", []);
  check("product-lifecycle-gate selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}
if (existsSync(join(HERE, "lane-utilization.ts"))) {
  const { code, detail } = runHermeticProbe("lane-utilization.ts", ["selftest"]);
  check("lane mutation evidence selftest passes (exit 0)", code === 0, detail);
}
if (existsSync(join(HERE, "slo-selftest.ts"))) {
  const { code, detail } = runHermeticProbe("slo-selftest.ts", []);
  check("SLO mutation evidence selftest passes (exit 0)", code === 0, detail);
}

// 17. PCG-008 recovery — hermetic proof that generated factory seeds reach the
// shared gate, write qualifying shadow evidence, and never block while shadowed.
if (existsSync(join(HERE, "factory-plan-gate.test.ts"))) {
  const { code, detail } = runTestProbe("factory-plan-gate.test.ts");
  check("factory plan-gate tests pass (exit 0)", code === 0, detail);
}

// 18. Factory autonomy hardening (FH-01…FH-07, FH-22). These modules gate
//     promotion, so a break here must abort the cycle rather than surface
//     mid-run as an unexplained hold. Hermetic: no network, no spend — the
//     capability probe and executor are injected in every test.
for (const suite of [
  "failure-policy.test.ts",
  "lane-halt.test.ts",
  "lifecycle-projection.test.ts",
  "consensus-capability.test.ts",
  "consensus-repair.test.ts",
  "project-preflight.test.ts",
]) {
  if (!existsSync(join(HERE, suite))) continue;
  const { code, detail } = runTestProbe(suite);
  check(`${suite.replace(".test.ts", "")} tests pass (exit 0)`, code === 0, detail);
}

// 19. The lifecycle projection must materialize from real on-disk evidence, not
//     just from injected fixtures. A degraded projection means consumers cannot
//     tell "nothing in flight" from "cannot tell", which is fail-open.
{
  const { code, out, err } = runProbe("lifecycle-projection.ts", ["--json", "--days", "2"]);
  let degraded = "projection emitted no machine result";
  try {
    degraded = JSON.parse(out.trim().split("\n").pop() ?? "{}").degraded_reason ?? "";
  } catch { /* keep the default detail */ }
  check("lifecycle projection materializes (exit 0)", code === 0, degraded || err.trim().split("\n").slice(-1)[0]);
}

// 20. Preflight must run end to end on an empty queue. The seat probe is
//     skipped here — it costs a real provider call — so this proves the CLI
//     contract, and `--skip-seat-probe` correctly reports as NOT ok.
{
  const { code, out } = runProbe("project-preflight.ts", [
    "check", "--project", "SMOKE", "--queue", "-", "--skip-seat-probe", "--json",
  ], "[]");
  let skipped: string[] = [];
  try {
    skipped = JSON.parse(out.trim().split("\n").pop() ?? "{}").checks_skipped ?? [];
  } catch { /* reported below */ }
  check(
    "project-preflight treats a skipped check as blocking (exit 1)",
    code === 1 && skipped.includes("consensus_seats"),
    `exit ${code}, skipped=[${skipped.join(",")}]`,
  );
}

// 21. P1 autonomy hardening (FH-11…FH-15). These gate promotion, branch
//     writes, PR creation and project completion, so a break must abort the
//     cycle rather than surface later as a duplicate twin or a wrong PR title.
for (const suite of [
  "delivery-evidence.test.ts",
  "branch-ownership.test.ts",
  "pr-provenance.test.ts",
  "handoff-contract.test.ts",
  "receipt-advance.test.ts",
  "run-receipt-contract.test.ts",
  "run-edge-proof.test.ts",
  "run-edge-proof-adapters.test.ts",
  "run-operation-journal.test.ts",
  "run-receipt-shadow.test.ts",
  "run-receipt-shadow-accept.test.ts",
  "run-receipt-shadow-harvest.test.ts",
  "runtime-config.test.ts",
  "persona-shadow-qualification.test.ts",
  "factory-state-mutation-evidence.test.ts",
  "ticket-claim.test.ts",
  "recovery-artifacts.test.ts",
]) {
  if (!existsSync(join(HERE, suite))) continue;
  const { code, detail } = runTestProbe(suite);
  check(`${suite.replace(".test.ts", "")} tests pass (exit 0)`, code === 0, detail);
}

{
  const smokeDb = `/dev/shm/conveyor-operation-journal-${process.pid}.sqlite`;
  const { code, err } = runHermeticProbe("run-operation-journal.ts", ["--selftest", "--db", smokeDb]);
  check("operation journal explicit-path selftest passes (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
  for (const path of [smokeDb, `${smokeDb}-wal`, `${smokeDb}-shm`]) rmSync(path, { force: true });
}

// 22. Receipt advancement must be safe to run every cycle. --dry-run proves the
//     plan computes over real on-disk receipts without writing to any of them.
{
  const { code, out, err } = runProbe("receipt-advance.ts", ["--json", "--dry-run"]);
  let degraded = "receipt advance emitted no machine result";
  try {
    degraded = JSON.parse(out.trim().split("\n").pop() ?? "{}").degraded_reason ?? "";
  } catch { /* keep the default detail */ }
  check("receipt advance dry-run computes (exit 0)", code === 0, degraded || err.trim().split("\n").slice(-1)[0]);
}

// 23. Stale branch claims are reported, never auto-released. Exit 0 either way
//     — quarantine is an operator report, not a gate.
{
  const { code, err } = runProbe("branch-ownership.ts", ["quarantine", "--json"]);
  check("branch-ownership quarantine reports (exit 0)", code === 0, err.trim().split("\n").slice(-1)[0]);
}

console.log(`\nconveyor smoke test: ${failures.length === 0 ? "HEALTHY" : `${failures.length} FAILURE(S)`}`);
if (failures.length > 0) {
  for (const f of failures) console.error(`  ! ${f}`);
  process.exit(1);
}
process.exit(0);
