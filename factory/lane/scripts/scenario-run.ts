#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-009 T3 — Scenario runner (ephemeral verification environments).
 *
 * Executes a ScenarioSpec's steps in a throwaway mkdtemp workdir under the
 * P0-3 hermetic sandbox env (secret-stripped allowlist + egress-refusing proxy
 * sink). When the spec declares a twin, an in-process Linear contract-mock is
 * started on 127.0.0.1:0 and steps reach it via LINEAR_API_URL + a
 * loopback-ONLY NO_PROXY overlay — all other egress stays pinned to the sink.
 *
 * Env layering (order matters, later wins):
 *   1. buildHoldoutSandboxEnv(parent)      — allowlist + proxy pins
 *   2. spec.env literals                   — secret/reserved names refused at parse
 *   3. twin overlay (LINEAR_API_URL, NO_PROXY=127.0.0.1,localhost) — runner-owned
 *
 * Ledger: append-only ScenarioRunRecord rows (state/scenario-runs.jsonl,
 * SF009_RUNS_PATH-injectable); `status` derives on read, torn-line tolerant.
 *
 * CLI (requires SF009_SCENARIOS=1; silent exit 0 before any read/write when off):
 *   bun scenario-run.ts run <spec.yaml> [--json]     # exit 0 passed / 1 failed
 *   bun scenario-run.ts status [--json]
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildHoldoutSandboxEnv } from "../../../packages/selfheal/src/introspect/holdout-sandbox.ts";
import {
  loadActorSystemContract,
  startActorSystemTwin,
  type ActorResponse,
  type ActorSystemTwinHandle,
  type LoadedActorContract,
} from "./actor-system-twin.ts";
import { readJsonlTolerant } from "./fleet-spec.ts";
import { type LinearTwinFixture, loadTwinFixture, startTwin, type TwinHandle } from "./linear-twin.ts";
import { buildActorRunReceipt } from "./scenario-run-receipt.ts";
import { actorTwinsEnabled, parseScenarioSpec, scenarioRunsPath, type ScenarioLineage, type ScenarioSpec, scenariosEnabled, type StepExpect, trajectoryVerifierEnabled } from "./scenario-spec.ts";
import {
  trajectoryClaimEvidenceHash,
  trajectorySha256,
  type TrajectoryClaim,
  type TrajectoryReplayObservation,
  type TrajectoryVerifierReport,
} from "./trajectory-verifier-contract.ts";
import { runTrajectoryVerifier } from "./trajectory-verifier-runtime.ts";

const DEFAULT_STEP_TIMEOUT_MS = 60_000;
const MAX_STEP_OUTPUT_BYTES = 10 * 1024 * 1024;

// ─── Env assembly (exported for the selftest) ─────────────────────────────────

/** Names the runner owns — parse refuses them; skipping here is defense-in-depth. */
const RESERVED_ENV = /^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|LINEAR_API_URL|ACTOR_SYSTEM_TWIN_URL|FACTORY_STATE_DIR|FACTORY_STATE_MODE|FACTORY_STATE_ALLOW_OUTSIDE_ROOT)$/i;

export function buildScenarioEnv(
  parent: NodeJS.ProcessEnv,
  spec: ScenarioSpec,
  twinUrl: string | null,
  factoryStateDir: string | null = null,
): NodeJS.ProcessEnv {
  const env = buildHoldoutSandboxEnv(parent);
  for (const [name, value] of Object.entries(spec.env ?? {})) {
    if (RESERVED_ENV.test(name)) continue;
    env[name] = value;
  }
  if (twinUrl) {
    // Runner-owned overlay LAST — a spec can never repoint or unpin these
    // (parse also refuses the names; this ordering is defense-in-depth).
    if (spec.twin?.kind === "actor-system") env.ACTOR_SYSTEM_TWIN_URL = twinUrl;
    else env.LINEAR_API_URL = twinUrl;
    env.NO_PROXY = "127.0.0.1,localhost";
    env.no_proxy = "127.0.0.1,localhost";
  }
  if (factoryStateDir) {
    env.FACTORY_STATE_DIR = factoryStateDir;
    env.FACTORY_STATE_MODE = "test";
    env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
  }
  return env;
}

// ─── Step execution + expectation checks ─────────────────────────────────────

export interface StepOutcome {
  exit_code: number | null;
  timed_out: boolean;
  /** Non-timeout spawn failure (e.g. ENOBUFS output overflow) — always fails the step loudly. */
  spawn_error: string | null;
  stdout: string;
  stderr: string;
}

/** Spawn one step. maxBuffer overflow (ENOBUFS) and other spawn errors land in
 *  spawn_error instead of crashing — but they are never silent (see checkExpectations). */
export async function executeStep(
  cmd: string,
  workdir: string,
  env: NodeJS.ProcessEnv,
  opts: { timeoutMs?: number; maxBuffer?: number } = {},
): Promise<StepOutcome> {
  const envArgs = Object.entries(env).flatMap(([name, value]) => value === undefined ? [] : [`${name}=${value}`]);
  return await new Promise((resolve) => {
    execFile("bash", ["--noprofile", "--norc", "-p", "-c", [
      'scenario_cmd="$1"',
      "shift",
      'for name in $(compgen -e); do unset "$name"; done',
      'for assignment in "$@"; do export "$assignment"; done',
      'eval "$scenario_cmd"',
    ].join("\n"), "scenario-env", cmd, ...envArgs], {
      cwd: workdir,
      env: {},
      timeout: opts.timeoutMs ?? DEFAULT_STEP_TIMEOUT_MS,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: opts.maxBuffer ?? MAX_STEP_OUTPUT_BYTES,
    }, (error, stdout, stderr) => {
      const code = error && "code" in error ? error.code : undefined;
      const timedOut = Boolean(error && "killed" in error && error.killed && "signal" in error && error.signal === "SIGKILL");
      const overflow = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || Boolean(error?.message.includes("maxBuffer"));
      resolve({
        exit_code: error ? (typeof code === "number" ? code : null) : 0,
        timed_out: timedOut,
        spawn_error: error && !timedOut && typeof code !== "number" ? (overflow ? "ENOBUFS" : String(code ?? error.message)) : null,
        stdout: stdout ?? "",
        stderr: stderr ?? "",
      });
    });
  });
}

/** Pure expectation evaluation — file existence injected for the selftest. */
export function checkExpectations(
  expect: StepExpect,
  outcome: StepOutcome,
  fileExists: (workdirRelative: string) => boolean,
): string[] {
  const failures: string[] = [];
  if (outcome.timed_out) failures.push("step timed out");
  // A truncated-output step must never pass on whatever survived the cutoff.
  if (outcome.spawn_error) failures.push(`spawn error: ${outcome.spawn_error}`);
  if (expect.exit_code !== undefined && outcome.exit_code !== expect.exit_code) {
    failures.push(`exit_code ${outcome.exit_code ?? "null"} !== expected ${expect.exit_code}`);
  }
  for (const s of expect.stdout_contains ?? []) {
    if (!outcome.stdout.includes(s)) failures.push(`stdout missing: ${JSON.stringify(s)}`);
  }
  for (const s of expect.stderr_contains ?? []) {
    if (!outcome.stderr.includes(s)) failures.push(`stderr missing: ${JSON.stringify(s)}`);
  }
  for (const f of expect.files_exist ?? []) {
    if (!fileExists(f)) failures.push(`file missing in workdir: ${f}`);
  }
  return failures;
}

export function materializeRun(run: string, scriptsDir: string, workdir: string): string {
  return run.replaceAll("{scripts_dir}", scriptsDir).replaceAll("{workdir}", workdir);
}

// ─── Run record (append-only ledger row) ──────────────────────────────────────

export interface ScenarioRunRecord {
  scenario_id: string;
  seed: number;
  verdict: "passed" | "failed";
  steps_total: number;
  steps_passed: number;
  failed_step: string | null;
  failures: string[];
  twin: "linear" | "actor-system" | null;
  twin_requests: number;
  twin_transcript_sha256: string | null;
  scenario_spec_sha256: string;
  scenario_manifest_sha256: string | null;
  evaluated_commit: string | null;
  duration_ms: number;
  ts: string;
  lineage?: ScenarioLineage;
  run_receipt_id?: string;
  run_receipt_hash?: string;
  run_receipt_events?: number;
  run_receipt_attempts?: number;
  run_receipt_outcome?: string;
  trajectory_report_id?: string;
  trajectory_report_hash?: string;
  trajectory_reproduction_ratio?: number;
  trajectory_disposition?: "PASS" | "HOLD";
  trajectory_uncertainty_count?: number;
}

export function scenarioSpecSha256(specPath: string): string {
  return createHash("sha256").update(readFileSync(specPath)).digest("hex");
}

export function appendRunRecord(record: ScenarioRunRecord, path = scenarioRunsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(record)}\n`);
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runScenario(specPath: string): Promise<ScenarioRunRecord> {
  const spec = parseScenarioSpec(specPath);
  if (spec.twin?.kind === "actor-system" && !actorTwinsEnabled()) {
    throw new Error("actor-system twin is disabled; set SF009_ACTOR_TWINS=1 in a disposable test process");
  }
  const started = Date.now();
  const workdir = mkdtempSync(join(tmpdir(), `sf009-${spec.scenario_id}-`));
  let twin: TwinHandle | ActorSystemTwinHandle | null = null;
  let loadedActor: LoadedActorContract | null = null;
  try {
    let fixture: LinearTwinFixture | null = null;
    if (spec.twin?.kind === "linear") {
      fixture = loadTwinFixture(spec.twin.fixture);
      twin = startTwin(fixture, spec.seed);
    } else if (spec.twin?.kind === "actor-system") {
      loadedActor = loadActorSystemContract(spec.twin.fixture, spec.twin.contract_id, {
        kind: spec.twin.authority_kind,
        manifestHash: spec.twin.manifest_sha256,
        contractHash: spec.twin.contract_sha256,
        reviewHash: spec.twin.review_sha256,
      });
      twin = startActorSystemTwin(loadedActor, spec.seed);
    }
    const factoryStateDir = join(workdir, "factory-state");
    mkdirSync(factoryStateDir, { recursive: true });
    const env = buildScenarioEnv(process.env, spec, twin?.url ?? null, factoryStateDir);

    let stepsPassed = 0;
    let failedStep: string | null = null;
    let failures: string[] = [];
    for (const step of spec.steps) {
      const cmd = materializeRun(step.run, import.meta.dir, workdir);
      const outcome = await executeStep(cmd, workdir, env, { timeoutMs: step.timeout_ms });
      const stepFailures = checkExpectations(step.expect, outcome, (rel) => existsSync(join(workdir, rel)));
      if (stepFailures.length > 0) {
        // Fail-fast: later steps assume earlier ones held their contract.
        failedStep = step.name;
        failures = stepFailures;
        break;
      }
      stepsPassed++;
    }

    const transcript = twin?.transcript() ?? null;
    const actorHandle = spec.twin?.kind === "actor-system" ? twin as ActorSystemTwinHandle | null : null;
    const actorReviewHash = spec.twin?.kind === "actor-system" ? spec.twin.review_sha256 : null;
    const sourceActorReceipt = spec.twin?.kind === "actor-system" && loadedActor && actorHandle
      ? buildActorRunReceipt({
        loaded: loadedActor,
        seed: spec.seed,
        transcript: actorHandle.transcript(),
        state: actorHandle.state(),
        approvalReceiptRef: `sha256:${spec.twin.review_sha256}`,
      })
      : null;
    let trajectoryReport: TrajectoryVerifierReport | null = null;
    if (trajectoryVerifierEnabled() && spec.trajectory_verifier && sourceActorReceipt && actorHandle) {
      const actorTranscript = actorHandle.transcript();
      const entry = actorTranscript.entries.at(-1);
      if (!entry) throw new Error("trajectory verifier requires an actor transcript entry");
      const observed: TrajectoryReplayObservation = {
        terminal: entry.response.terminal,
        attempts: entry.response.attempts,
        delay_ms: entry.response.delayMs,
        committed: entry.response.committed,
        compensated: entry.response.compensated,
        resumed: entry.response.resumed,
        state_version: entry.response.stateVersion,
      };
      const claims = Object.entries(observed).map(([field, expected]): TrajectoryClaim => ({
        claim_id: `${spec.scenario_id}-${field}`,
        field: field as TrajectoryClaim["field"],
        expected,
        evidence_sha256: trajectoryClaimEvidenceHash(field as TrajectoryClaim["field"], expected, sourceActorReceipt.receipt_hash),
      }));
      const declaration = spec.trajectory_verifier;
      trajectoryReport = await runTrajectoryVerifier({
        generatorRoot: workdir,
        request: {
          schema_version: 1,
          request_id: `trajectory-${spec.scenario_id}-${spec.seed}`,
          scenario_id: spec.scenario_id,
          seed: spec.seed,
          claims,
          redacted_observations: {
            transcript_sha256: actorTranscript.sha256,
            initial_response_sha256: trajectorySha256(observed),
            generator_root_sha256: trajectorySha256({ role: "generator-root", scenario_id: spec.scenario_id, seed: spec.seed }),
            verifier_root_sha256: "0".repeat(64),
            qualitative_evidence: {
              artifact_id: `qualitative-${spec.scenario_id}-${spec.seed}`,
              verifier_model_id: declaration.verifier_model_id,
              verifier_prompt_sha256: declaration.verifier_prompt_sha256,
              verifier_history_sha256: declaration.verifier_history_sha256,
              rubric_sha256: declaration.rubric_sha256,
              request_sha256: "0".repeat(64),
              score: declaration.qualitative_score,
              confidence: declaration.qualitative_confidence,
              rationale_sha256: declaration.qualitative_rationale_sha256,
            },
          },
          source_receipt_id: sourceActorReceipt.receipt_id,
          source_receipt_hash: sourceActorReceipt.receipt_hash,
          generator_model_id: declaration.generator_model_id,
          generator_prompt_sha256: declaration.generator_prompt_sha256,
          generator_history_sha256: declaration.generator_history_sha256,
          verifier_model_id: declaration.verifier_model_id,
          verifier_prompt_sha256: declaration.verifier_prompt_sha256,
          verifier_history_sha256: declaration.verifier_history_sha256,
          rubric_sha256: declaration.rubric_sha256,
        },
        replay: async () => {
          const response = await fetch(actorHandle.url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(entry.request),
          });
          if (!response.ok) throw new Error(`actor replay returned HTTP ${response.status}`);
          const replayed = await response.json() as ActorResponse;
          return {
            terminal: replayed.terminal,
            attempts: replayed.attempts,
            delay_ms: replayed.delayMs,
            committed: replayed.committed,
            compensated: replayed.compensated,
            resumed: replayed.resumed,
            state_version: replayed.stateVersion,
          };
        },
      });
    }
    const actorReceipt = sourceActorReceipt && loadedActor && actorHandle && actorReviewHash && trajectoryReport
      ? buildActorRunReceipt({
        loaded: loadedActor,
        seed: spec.seed,
        transcript: actorHandle.transcript(),
        state: actorHandle.state(),
        approvalReceiptRef: `sha256:${actorReviewHash}`,
        trajectoryReport,
      })
      : sourceActorReceipt;
    const record: ScenarioRunRecord = {
      scenario_id: spec.scenario_id,
      seed: spec.seed,
      verdict: failedStep === null ? "passed" : "failed",
      steps_total: spec.steps.length,
      steps_passed: stepsPassed,
      failed_step: failedStep,
      failures,
      twin: spec.twin?.kind ?? null,
      twin_requests: transcript?.entries.length ?? 0,
      twin_transcript_sha256: transcript?.sha256 ?? null,
      scenario_spec_sha256: scenarioSpecSha256(specPath),
      scenario_manifest_sha256: process.env.SF009_SCENARIO_MANIFEST_SHA256 ?? null,
      evaluated_commit: process.env.SF009_EVALUATED_COMMIT ?? null,
      duration_ms: Date.now() - started,
      ts: new Date().toISOString(),
      ...(spec.lineage ? { lineage: structuredClone(spec.lineage) } : {}),
      ...(actorReceipt ? {
        run_receipt_id: actorReceipt.receipt_id,
        run_receipt_hash: actorReceipt.receipt_hash,
        run_receipt_events: actorReceipt.events.length,
        run_receipt_attempts: actorReceipt.attempts.length,
        run_receipt_outcome: actorReceipt.terminal.outcome,
      } : {}),
      ...(trajectoryReport ? {
        trajectory_report_id: trajectoryReport.report_id,
        trajectory_report_hash: trajectoryReport.report_hash,
        trajectory_reproduction_ratio: trajectoryReport.reproduction_ratio,
        trajectory_disposition: trajectoryReport.disposition,
        trajectory_uncertainty_count: trajectoryReport.unresolved_uncertainty.length,
      } : {}),
    };
    appendRunRecord(record);
    return record;
  } finally {
    twin?.stop();
    rmSync(workdir, { recursive: true, force: true });
  }
}


// ─── Status (derive-on-read, torn-line tolerant) ──────────────────────────────

export interface ScenarioStatus {
  runs_total: number;
  by_verdict: Record<string, number>;
  torn_lines: number;
  scenarios: Array<{
    scenario_id: string;
    runs: number;
    last_verdict: string;
    last_ts: string;
    last_transcript_sha256: string | null;
  }>;
}

export function deriveStatus(path = scenarioRunsPath()): ScenarioStatus {
  const { rows, torn_lines } = readJsonlTolerant<ScenarioRunRecord>(path);
  const byVerdict: Record<string, number> = {};
  const byScenario = new Map<string, { runs: number; last: ScenarioRunRecord }>();
  for (const row of rows) {
    if (!row || typeof row.scenario_id !== "string") continue;
    byVerdict[row.verdict] = (byVerdict[row.verdict] ?? 0) + 1;
    const cur = byScenario.get(row.scenario_id);
    if (cur) {
      cur.runs++;
      cur.last = row;
    } else {
      byScenario.set(row.scenario_id, { runs: 1, last: row });
    }
  }
  return {
    runs_total: rows.length,
    by_verdict: byVerdict,
    torn_lines,
    scenarios: [...byScenario.entries()].map(([id, s]) => ({
      scenario_id: id,
      runs: s.runs,
      last_verdict: s.last.verdict,
      last_ts: s.last.ts,
      last_transcript_sha256: s.last.twin_transcript_sha256,
    })),
  };
}

// ─── SF-009 snapshot (shadow-validate section — never throws) ─────────────────

export interface SF009Snapshot {
  scenarios_enabled: boolean;
  runs_total: number;
  by_verdict: Record<string, number>;
  torn_lines: number;
  last_run: { scenario_id: string; verdict: string; ts: string; twin_transcript_sha256: string | null } | null;
  /** Corrupt-ledger notes — tolerated and surfaced, never thrown. */
  invalid: string[];
}

export function sf009Snapshot(): SF009Snapshot {
  const empty: SF009Snapshot = {
    scenarios_enabled: scenariosEnabled(),
    runs_total: 0,
    by_verdict: {},
    torn_lines: 0,
    last_run: null,
    invalid: [],
  };
  try {
    const status = deriveStatus();
    let last: SF009Snapshot["last_run"] = null;
    for (const s of status.scenarios) {
      if (!last || s.last_ts > last.ts) {
        last = {
          scenario_id: s.scenario_id,
          verdict: s.last_verdict,
          ts: s.last_ts,
          twin_transcript_sha256: s.last_transcript_sha256,
        };
      }
    }
    return {
      ...empty,
      runs_total: status.runs_total,
      by_verdict: status.by_verdict,
      torn_lines: status.torn_lines,
      last_run: last,
    };
  } catch (err) {
    return { ...empty, invalid: [`scenario ledger unreadable: ${String(err)}`] };
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  if (!scenariosEnabled()) {
    // Exit before ANY read/write when the flag is off (byte-identity AC).
    process.exit(0);
  }
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const cmd = args[0];

  if (cmd === "run") {
    const specPath = args.slice(1).find((a) => !a.startsWith("--"));
    if (!specPath) {
      console.error("usage: scenario-run.ts run <spec.yaml> [--json]");
      process.exit(2);
    }
    const record = await runScenario(specPath);
    if (json) {
      console.log(JSON.stringify(record, null, 2));
    } else {
      const hash = record.twin_transcript_sha256 ? ` twin-sha=${record.twin_transcript_sha256.slice(0, 12)}` : "";
      console.log(
        `scenario ${record.scenario_id}: ${record.verdict.toUpperCase()} ${record.steps_passed}/${record.steps_total} steps` +
          `${record.failed_step ? ` (failed at ${record.failed_step}: ${record.failures.join("; ")})` : ""}${hash}`,
      );
    }
    process.exit(record.verdict === "passed" ? 0 : 1);
  }

  if (cmd === "status") {
    const status = deriveStatus();
    if (json) {
      console.log(JSON.stringify(status, null, 2));
    } else {
      console.log(
        `scenario runs: ${status.runs_total} (${Object.entries(status.by_verdict).map(([v, n]) => `${v}=${n}`).join(", ") || "none"})` +
          `${status.torn_lines > 0 ? ` torn=${status.torn_lines}` : ""}`,
      );
      for (const s of status.scenarios) {
        console.log(`  ${s.scenario_id}: ${s.runs} run(s), last=${s.last_verdict} @ ${s.last_ts}`);
      }
    }
    process.exit(0);
  }

  console.error("usage: scenario-run.ts run <spec.yaml> [--json] | status [--json]   (requires SF009_SCENARIOS=1)");
  process.exit(2);
}
