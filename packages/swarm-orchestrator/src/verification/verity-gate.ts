/**
 * Verity × Swarm (Stage 2b) — the orchestrator-run verify gate.
 *
 * The orchestrator (scripts/orchestrate-v5.ts, SwarmOrchestrator.executeTaskAttempts)
 * is the only process that both spawns the executor and decides `success`, so
 * it is the trust boundary. This module drives the Verity engine's two-phase
 * CLI (packages/verity/engine/cli.js `snapshot` / `verify`) as a child of the
 * orchestrator:
 *
 *   snapshot  once per task, before the first attempt is spawned (later
 *             attempts and resumes reuse the same base, so a retry cannot hide
 *             earlier edits by taking a fresh base);
 *   verify    when the bridge declares success, before the specialist review
 *             and before anything is credited (recordSuccess, recordHistory,
 *             memory, completedOutputs).
 *
 * The CLI builds the ledger from the workspace diff (committed, staged,
 * unstaged AND untracked work), applies the engine's rules, and runs the
 * TRUSTED check itself. The gate never reads what the agent claimed.
 *
 * Modes (Q5): off | shadow | live. Resolution, highest wins:
 *   SWARM_VERITY env (off|shadow|live; the kill switch) > the dispatcher's
 *   per-campaign override (task.verityMode, recorded on every verdict) >
 *   the root-owned operator policy /etc/zouroboros/verity-swarm.json
 *   ({mode, enabled, requireCheck, checkTimeoutS, ignore, repos}) > shadow.
 *   Live applies only to campaigns with concurrency 1 (every factory_dispatch
 *   run); a shared-workspace concurrent campaign is downgraded to shadow with
 *   attribution "shared" recorded. Shadow runs the whole gate (snapshot, diff,
 *   check) but never fails a task: verdicts carry applied:false.
 *
 * Exit codes (CLI): 0 pass, 1 fail, 2 unverifiable, 64 usage, 70 internal.
 * 64, 70, any other code, a timeout, unparseable stdout or a missing CLI are
 * `error` here — fail-closed in live mode (errorType verify_unavailable, no
 * retry), logged in shadow.
 *
 * Provenance only: verdicts hold paths, labels, fingerprints, the trusted
 * command, exit codes and hashes — never file contents, never check output,
 * never the text of a detected credential. The check's output goes to a
 * per-attempt log file outside the workspace; the verdict carries its hash.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const VERDICT_SCHEMA = "verity.swarm.verdict/1";
export const DEFAULT_POLICY_PATH = "/etc/zouroboros/verity-swarm.json";
export const DEFAULT_CHECK_TIMEOUT_S = 900;
/** Lines of check output fed back to the executor after a gate failure (never persisted in the verdict). */
export const FEEDBACK_TAIL_LINES = 40;
const GATE_OVERHEAD_S = 120;
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

export type VerityMode = "off" | "shadow" | "live";
export type VerityDecision = "pass" | "fail" | "unverifiable" | "error";
export type VerityModeSource = "env" | "campaign" | "policy" | "policy_kill_switch" | "default";

export const VERITY_MODES: ReadonlySet<string> = new Set(["off", "shadow", "live"]);

export interface VerifySpec {
  command: string;
  cwd?: string;
  timeoutS?: number;
  allowTestDeletion?: boolean;
  allowCheckEdits?: boolean;
  allowSecrets?: boolean;
}

/** The dispatcher-written trusted check: a command, an explicit waiver, or nothing. */
export type ResolvedVerify = { kind: "command"; spec: VerifySpec } | { kind: "waived" } | null;

export interface OperatorPolicy {
  path: string;
  exists: boolean;
  /** True when the file is owned by root (the only writer the gate trusts). */
  rootOwned: boolean;
  mode: VerityMode | null;
  enabled: boolean;
  requireCheck: boolean | null;
  checkTimeoutS: number | null;
  raw: Record<string, unknown> | null;
  error: string | null;
}

export interface ModeResolution {
  mode: VerityMode;
  source: VerityModeSource;
  /** The mode before the shared-workspace downgrade (live → shadow), when it applied. */
  requestedMode?: VerityMode;
  downgraded?: "shared_workspace";
  override: VerityMode | null;
  policyMode: VerityMode | null;
}

/** The additive `verity` key on an attempts[] record. */
export interface AttemptVeritySummary {
  decision: VerityDecision;
  applied: boolean;
  mode: VerityMode;
  exitCode: number | null;
  codeChanged: number;
  findings: Array<{ rule: string; path?: string; label?: string; inDiff?: boolean }>;
  allOutsideDiff?: boolean;
  verdictClass?: string;
  check: { command: string | null; source: string; exitCode?: number | null; durationMs?: number; timedOut?: boolean; hollow?: boolean; skipped?: string } | null;
  waived?: boolean;
  attribution?: "shared";
  durationMs: number;
  error?: string;
}

export interface GateOutcome {
  decision: VerityDecision;
  /** True when this verdict decides the attempt (live mode). */
  applied: boolean;
  waived: boolean;
  message: string;
  /** Prompt feedback for the next attempt: the Verity message + the check output tail (path/label only for secrets). */
  feedback: string;
  summary: AttemptVeritySummary;
  verdict: Record<string, unknown>;
}

export interface CampaignVeritySummary {
  mode: VerityMode;
  source: VerityModeSource;
  requestedMode?: VerityMode;
  downgraded?: string;
  override: VerityMode | null;
  policy: { path: string; exists: boolean; rootOwned: boolean; mode: VerityMode | null; enabled: boolean };
  cli: string;
  cliPresent: boolean;
  log: string;
  requireCheck: boolean;
  verdicts: number;
  byDecision: Record<VerityDecision, number>;
  applied: number;
  snapshots: number;
  snapshotErrors: number;
  checkLatencyMs: { count: number; max: number | null; p95: number | null };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function parseVerityMode(v: unknown): VerityMode | null {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "0" || s === "false" || s === "disabled" || s === "none") return "off";
  if (s === "enforce" || s === "on") return "live";
  return VERITY_MODES.has(s) ? (s as VerityMode) : null;
}

/** Normalize a task's `verify` field (string | object | "none") into the trusted check, a waiver, or nothing. */
export function resolveVerifySpec(v: unknown): ResolvedVerify {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (s.toLowerCase() === "none") return { kind: "waived" };
    return { kind: "command", spec: { command: s } };
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.waived === true || String(o.command ?? "").trim().toLowerCase() === "none") return { kind: "waived" };
    const command = String(o.command ?? "").trim();
    if (!command) return null;
    const spec: VerifySpec = { command };
    if (o.cwd !== undefined && o.cwd !== null && String(o.cwd).trim()) spec.cwd = String(o.cwd).trim();
    const t = Number(o.timeoutS);
    if (Number.isFinite(t) && t > 0) spec.timeoutS = Math.round(t);
    for (const k of ["allowTestDeletion", "allowCheckEdits", "allowSecrets"] as const) if (o[k] === true) spec[k] = true;
    return { kind: "command", spec };
  }
  return null;
}

export function loadOperatorPolicy(path = DEFAULT_POLICY_PATH): OperatorPolicy {
  const out: OperatorPolicy = { path, exists: false, rootOwned: false, mode: null, enabled: true, requireCheck: null, checkTimeoutS: null, raw: null, error: null };
  let st;
  try { st = statSync(path); } catch { return out; }
  out.exists = true;
  out.rootOwned = st.uid === 0;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("policy is not a JSON object");
    out.raw = raw as Record<string, unknown>;
    out.mode = parseVerityMode(raw.mode);
    if (raw.enabled === false) out.enabled = false;
    if (typeof raw.requireCheck === "boolean") out.requireCheck = raw.requireCheck;
    const t = Number(raw.checkTimeoutS);
    if (Number.isFinite(t) && t > 0) out.checkTimeoutS = Math.round(t);
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
  }
  return out;
}

/**
 * Resolve the campaign's gate mode (see the header). `concurrency` > 1 means
 * the tasks share one workspace: live is downgraded to shadow.
 */
export function resolveVerityMode(inp: {
  env?: Record<string, string | undefined>;
  policy: OperatorPolicy;
  campaignOverride?: VerityMode | null;
  concurrency?: number;
}): ModeResolution {
  const env = inp.env ?? process.env;
  const override = inp.campaignOverride ?? null;
  let mode: VerityMode;
  let source: VerityModeSource;
  const envMode = parseVerityMode(env.SWARM_VERITY);
  if (env.SWARM_VERITY !== undefined && env.SWARM_VERITY !== "" && envMode) {
    mode = envMode; source = "env";
  } else if (override) {
    mode = override; source = "campaign";
  } else if (inp.policy.exists && !inp.policy.enabled) {
    mode = "off"; source = "policy_kill_switch";
  } else if (inp.policy.mode) {
    mode = inp.policy.mode; source = "policy";
  } else {
    mode = "shadow"; source = "default";
  }
  const res: ModeResolution = { mode, source, override, policyMode: inp.policy.mode };
  if (mode === "live" && (inp.concurrency ?? 1) > 1) {
    res.requestedMode = "live";
    res.downgraded = "shared_workspace";
    res.mode = "shadow";
  }
  return res;
}

/** The Verity engine CLI the gate runs: $SWARM_VERITY_CLI, else the canonical workshop copy under the orchestrator home. */
export function locateVerityCli(orchestratorHome: string, env: Record<string, string | undefined> = process.env): string {
  const o = env.SWARM_VERITY_CLI?.trim();
  return o ? o : join(orchestratorHome, "packages", "verity", "engine", "cli.js");
}

function sha256File(path: string): string | null {
  try { return createHash("sha256").update(readFileSync(path)).digest("hex"); } catch { return null; }
}

function tailLines(text: string, n: number): string {
  const lines = text.replace(/\r/g, "").split("\n");
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(-n).join("\n");
}

/** Attempt summary from a CLI verdict (paths, rules, labels and the check record only). */
export function summarizeVerdict(v: Record<string, any>, mode: VerityMode, applied: boolean, durationMs: number): AttemptVeritySummary {
  const findings = Array.isArray(v.findings) ? v.findings.slice(0, 20).map((f: any) => ({
    rule: String(f.rule ?? "unknown"), ...(f.path ? { path: String(f.path) } : {}), ...(f.label ? { label: String(f.label) } : {}),
    ...(f.inDiff !== undefined ? { inDiff: Boolean(f.inDiff) } : {}),
  })) : [];
  const allOutsideDiff = v.allOutsideDiff !== undefined
    ? Boolean(v.allOutsideDiff)
    : (findings.length > 0 && findings.every((f) => f.inDiff === false));
  const verdictClass = v.verdictClass ?? (allOutsideDiff ? "contamination" : undefined);
  const check = v.check && typeof v.check === "object" ? {
    command: v.check.command ?? null, source: String(v.check.source ?? "none"),
    ...(v.check.exitCode !== undefined ? { exitCode: v.check.exitCode } : {}),
    ...(v.check.durationMs !== undefined ? { durationMs: v.check.durationMs } : {}),
    ...(v.check.timedOut !== undefined ? { timedOut: !!v.check.timedOut } : {}),
    ...(v.check.hollow !== undefined ? { hollow: !!v.check.hollow } : {}),
    ...(v.check.skipped ? { skipped: String(v.check.skipped) } : {}),
  } : null;
  return {
    decision: (["pass", "fail", "unverifiable"].includes(v.decision) ? v.decision : "error") as VerityDecision,
    applied, mode,
    exitCode: typeof v.exitCode === "number" ? v.exitCode : null,
    codeChanged: Array.isArray(v.changes?.code) ? v.changes.code.length : 0,
    findings,
    ...(v.allOutsideDiff !== undefined ? { allOutsideDiff: Boolean(v.allOutsideDiff) } : (allOutsideDiff ? { allOutsideDiff: true } : {})),
    ...(verdictClass ? { verdictClass } : {}),
    check,
    ...(v.waived ? { waived: true } : {}),
    durationMs,
    ...(v.decision === "error" && v.error ? { error: String(v.error).slice(0, 300) } : {}),
  };
}

function runNode(cli: string, args: string[], opts: { cwd: string; timeoutMs: number; env: Record<string, string | undefined> }): Promise<{ code: number | null; stdout: string; stderrBytes: number; timedOut: boolean; spawnError?: string }> {
  return new Promise((resolveP) => {
    const nodeBin = opts.env.SWARM_VERITY_NODE?.trim() || "node";
    let child;
    try {
      child = spawn(nodeBin, [cli, ...args], { cwd: opts.cwd, env: opts.env as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolveP({ code: null, stdout: "", stderrBytes: 0, timedOut: false, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    let stdout = "";
    let stderrBytes = 0;
    let timedOut = false;
    let settled = false;
    const kill = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); else child.kill(sig); } catch { try { child.kill(sig); } catch {} } };
    const timer = setTimeout(() => { timedOut = true; kill("SIGTERM"); setTimeout(() => kill("SIGKILL"), 5000).unref(); }, opts.timeoutMs);
    child.stdout?.on("data", (b: Buffer) => { if (stdout.length < MAX_STDOUT_BYTES) stdout += b.toString("utf8"); });
    child.stderr?.on("data", (b: Buffer) => { stderrBytes += b.length; });
    const finish = (code: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveP({ code, stdout, stderrBytes, timedOut, ...(spawnError ? { spawnError } : {}) });
    };
    child.on("error", (e) => finish(null, e.message));
    child.on("close", (code) => finish(code));
  });
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface VerityGateOptions {
  swarmId: string;
  orchestratorHome: string;
  swarmDir: string;
  workspace: string;
  concurrency: number;
  /** The dispatcher's per-campaign override (first task.verityMode seen). */
  campaignOverride?: VerityMode | null;
  env?: Record<string, string | undefined>;
  policyPath?: string;
  /** Files the orchestrator itself writes inside the workspace (run.log etc.); excluded from the loose-file manifest. */
  selfOutputFiles?: string[];
  log?: (line: string) => void;
}

export class VerityGate {
  readonly resolution: ModeResolution;
  readonly policy: OperatorPolicy;
  readonly cli: string;
  readonly cliPresent: boolean;
  readonly stateDir: string;
  readonly logPath: string;
  readonly requireCheck: boolean;
  private readonly env: Record<string, string | undefined>;
  private readonly bases = new Map<string, { path: string; sha256: string }>();
  private readonly snapshotFailed = new Set<string>();
  private counts: Record<VerityDecision, number> = { pass: 0, fail: 0, unverifiable: 0, error: 0 };
  private applied = 0;
  private snapshots = 0;
  private snapshotErrors = 0;
  private checkLatencies: number[] = [];
  private readonly out: (line: string) => void;

  constructor(private readonly o: VerityGateOptions) {
    this.env = o.env ?? process.env;
    this.policy = loadOperatorPolicy(o.policyPath ?? this.env.SWARM_VERITY_POLICY?.trim() ?? DEFAULT_POLICY_PATH);
    this.resolution = resolveVerityMode({ env: this.env, policy: this.policy, campaignOverride: o.campaignOverride ?? null, concurrency: o.concurrency });
    this.cli = locateVerityCli(o.orchestratorHome, this.env);
    this.cliPresent = existsSync(this.cli);
    this.stateDir = join(o.swarmDir, "verity", o.swarmId);
    this.logPath = join(o.swarmDir, "verity", `${o.swarmId}.jsonl`);
    // Live default: a code change without a trusted check fails unless the dispatcher recorded a waiver.
    this.requireCheck = this.policy.requireCheck === null ? true : this.policy.requireCheck;
    this.out = o.log ?? ((l) => console.log(l));
  }

  get mode(): VerityMode { return this.resolution.mode; }
  get enabled(): boolean { return this.mode !== "off"; }
  get live(): boolean { return this.mode === "live"; }

  describe(): string {
    const r = this.resolution;
    const bits = [`mode=${r.mode} (${r.source})`];
    if (r.downgraded) bits.push(`requested ${r.requestedMode}, downgraded: ${r.downgraded} (concurrency ${this.o.concurrency})`);
    if (r.override) bits.push(`campaign override ${r.override}`);
    bits.push(`policy=${this.policy.path}${this.policy.exists ? (this.policy.rootOwned ? "" : " (NOT root-owned)") : " (absent)"}${this.policy.error ? ` (unreadable: ${this.policy.error})` : ""}`);
    bits.push(`cli=${this.cli}${this.cliPresent ? "" : " (MISSING)"}`);
    if (r.mode === "live") bits.push(`require-check=${this.requireCheck ? "on" : "off"}`);
    return bits.join(" | ");
  }

  hasBase(taskId: string): boolean { return this.bases.has(taskId) || this.snapshotFailed.has(taskId); }

  private basePath(taskId: string): string { return join(this.stateDir, `${taskId.replace(/[^A-Za-z0-9_.-]/g, "_")}.base.json`); }

  private appendVerdict(v: Record<string, unknown>): void {
    try {
      mkdirSync(join(this.o.swarmDir, "verity"), { recursive: true, mode: 0o700 });
      appendFileSync(this.logPath, JSON.stringify(v) + "\n", { mode: 0o600 });
    } catch {}
  }

  private envelope(extra: Record<string, unknown>): Record<string, unknown> {
    const r = this.resolution;
    return {
      schema: VERDICT_SCHEMA, ts: new Date().toISOString(), swarmId: this.o.swarmId,
      mode: r.mode, modeSource: r.source, ...(r.requestedMode ? { requestedMode: r.requestedMode, downgraded: r.downgraded } : {}),
      ...(r.override ? { override: r.override } : {}), ...(this.o.concurrency > 1 ? { attribution: "shared" } : {}),
      cli: this.cli, ...extra,
    };
  }

  /**
   * Run the pre-flight contamination scan before the first executor attempt.
   * If contamination is found outside the candidate base, returns ok: false with paths and error.
   */
  async preflight(): Promise<{ ok: true; report: Record<string, any> | null } | { ok: false; error: string; paths: string[]; findings: any[] }> {
    if (!this.enabled || !this.cliPresent) return { ok: true, report: null };
    const args = ["preflight", "--cwd", this.o.workspace, "--json"];
    for (const f of this.o.selfOutputFiles ?? []) args.push("--exclude", f);
    const r = await runNode(this.cli, args, { cwd: this.o.orchestratorHome, timeoutMs: 30_000, env: this.env });
    if (r.spawnError || r.timedOut) {
      if (this.live) return { ok: false, error: r.spawnError || "preflight timed out", paths: [], findings: [] };
      return { ok: true, report: null };
    }
    let parsed: any = null;
    try {
      const last = r.stdout.trim().split("\n").filter(Boolean).pop();
      parsed = last ? JSON.parse(last) : null;
    } catch {
      return { ok: true, report: null };
    }
    if (parsed && parsed.contaminated) {
      const paths = Array.isArray(parsed.paths) ? parsed.paths : [];
      const error = parsed.message || `workspace contaminated: ${paths.join(", ")}`;
      this.appendVerdict(this.envelope({ phase: "preflight", decision: "fail", errorKind: "contamination", applied: this.live, paths, error: error.slice(0, 500) }));
      return { ok: false, error, paths, findings: parsed.findings || [] };
    }
    return { ok: true, report: parsed };
  }

  /**
   * Record the pre-task base for a task. Returns ok:false (with the error) when
   * the gate cannot answer; the caller fails closed in live mode.
   */
  async snapshot(taskId: string): Promise<{ ok: true; path: string; sha256: string } | { ok: false; error: string }> {
    if (!this.enabled) return { ok: false, error: "gate off" };
    const known = this.bases.get(taskId);
    if (known) return { ok: true, ...known };
    const path = this.basePath(taskId);
    const fail = (error: string) => {
      this.snapshotErrors++;
      this.snapshotFailed.add(taskId);
      this.appendVerdict(this.envelope({ taskId, phase: "snapshot", decision: "error", applied: this.live, error: error.slice(0, 500) }));
      return { ok: false as const, error };
    };
    if (!this.cliPresent) return fail(`Verity CLI missing: ${this.cli}`);
    try { mkdirSync(this.stateDir, { recursive: true, mode: 0o700 }); rmSync(path, { force: true }); } catch (e) { return fail(`cannot prepare ${this.stateDir}: ${e}`); }
    const args = ["snapshot", "--cwd", this.o.workspace, "--out", path];
    for (const f of this.o.selfOutputFiles ?? []) args.push("--exclude", f);
    const r = await runNode(this.cli, args, { cwd: this.o.orchestratorHome, timeoutMs: 15 * 60 * 1000, env: this.env });
    if (r.spawnError) return fail(`Verity snapshot could not start: ${r.spawnError}`);
    if (r.timedOut) return fail("Verity snapshot timed out");
    if (r.code !== 0) {
      let detail = "";
      try { detail = String(JSON.parse(r.stdout.trim().split("\n").pop() || "{}").error ?? ""); } catch {}
      return fail(`Verity snapshot exited ${r.code}${detail ? `: ${detail}` : ""}`);
    }
    const sha256 = sha256File(path);
    if (!sha256) return fail(`Verity snapshot wrote no base record at ${path}`);
    this.bases.set(taskId, { path, sha256 });
    this.snapshots++;
    return { ok: true, path, sha256 };
  }

  /**
   * Judge a declared success. Never throws: an unanswerable gate is decision
   * "error" (applied in live → the caller fails the task with verify_unavailable).
   */
  async verify(inp: { taskId: string; attempt: number; executor: string; verify: ResolvedVerify; checkTimeoutS?: number | null }): Promise<GateOutcome> {
    const t0 = Date.now();
    const applied = this.live;
    const finishError = (error: string, extra: Record<string, unknown> = {}): GateOutcome => {
      const durationMs = Date.now() - t0;
      const verdict = this.envelope({ taskId: inp.taskId, attempt: inp.attempt, executor: inp.executor, phase: "verify", decision: "error", applied, error: error.slice(0, 500), durationMs, ...extra });
      this.counts.error++;
      if (applied) this.applied++;
      this.appendVerdict(verdict);
      const message = `Verity gate error: ${error}`;
      return {
        decision: "error", applied, waived: false, message, feedback: message,
        summary: { decision: "error", applied, mode: this.mode, exitCode: typeof extra.exitCode === "number" ? extra.exitCode : null, codeChanged: 0, findings: [], check: null, durationMs, error: error.slice(0, 300), ...(this.o.concurrency > 1 ? { attribution: "shared" as const } : {}) },
        verdict,
      };
    };
    if (!this.enabled) return finishError("gate off");
    if (!this.cliPresent) return finishError(`Verity CLI missing: ${this.cli}`);
    const base = this.bases.get(inp.taskId);
    if (!base) return finishError(this.snapshotFailed.has(inp.taskId) ? "no pre-task base (snapshot failed)" : "no pre-task base recorded for this task");
    const now = sha256File(base.path);
    if (now !== base.sha256) return finishError(`base record tampered or missing (${base.path})`);

    const args = ["verify", "--cwd", this.o.workspace, "--base", base.path, "--json"];
    if (this.policy.exists && !this.policy.error) args.push("--policy", this.policy.path);
    for (const f of this.o.selfOutputFiles ?? []) args.push("--exclude", f);
    let timeoutS = inp.checkTimeoutS && inp.checkTimeoutS > 0 ? inp.checkTimeoutS : (this.policy.checkTimeoutS ?? DEFAULT_CHECK_TIMEOUT_S);
    if (inp.verify?.kind === "waived") {
      args.push("--waived");
    } else if (inp.verify?.kind === "command") {
      const s = inp.verify.spec;
      args.push("--check", s.command, "--check-source", "task");
      if (s.cwd) args.push("--check-cwd", s.cwd);
      if (s.timeoutS) timeoutS = s.timeoutS;
      if (s.allowTestDeletion) args.push("--allow-test-deletion");
      if (s.allowCheckEdits) args.push("--allow-check-edits");
      if (s.allowSecrets) args.push("--allow-secrets");
    }
    args.push("--check-timeout", String(timeoutS));
    if (this.live && this.requireCheck) args.push("--require-check");
    const checkLog = join(this.stateDir, `${inp.taskId.replace(/[^A-Za-z0-9_.-]/g, "_")}.a${inp.attempt}.check.log`);
    args.push("--check-log", checkLog);

    const r = await runNode(this.cli, args, { cwd: this.o.orchestratorHome, timeoutMs: (timeoutS + GATE_OVERHEAD_S) * 1000, env: this.env });
    if (r.spawnError) return finishError(`Verity verify could not start: ${r.spawnError}`);
    if (r.timedOut) return finishError(`Verity verify timed out after ${timeoutS + GATE_OVERHEAD_S}s`);
    let parsed: Record<string, any> | null = null;
    try {
      const last = r.stdout.trim().split("\n").filter(Boolean).pop();
      parsed = last ? JSON.parse(last) : null;
    } catch { parsed = null; }
    if (!parsed || typeof parsed !== "object" || parsed.schema !== VERDICT_SCHEMA) return finishError(`Verity verify produced no verdict (exit ${r.code}, ${r.stdout.length} stdout bytes)`, { exitCode: r.code });
    const okCodes: Record<number, VerityDecision> = { 0: "pass", 1: "fail", 2: "unverifiable" };
    const decision = r.code !== null && okCodes[r.code] !== undefined ? okCodes[r.code] : "error";
    if (decision === "error" || parsed.decision !== decision) {
      return finishError(`Verity verify exited ${r.code}${parsed.error ? `: ${String(parsed.error).slice(0, 300)}` : ""}`, { exitCode: r.code, errorKind: parsed.errorKind ?? null });
    }

    const durationMs = Date.now() - t0;
    const waived = parsed.waived === true;
    const verdict = this.envelope({
      taskId: inp.taskId, attempt: inp.attempt, executor: inp.executor, phase: "verify", applied, exitCode: r.code,
      // The CLI verdict: decision, base, changes, findings (rule/path/label/fingerprint), check (command, exit, hash), message, engine, durationMs.
      ...parsed, gateDurationMs: durationMs, checkLog: parsed.check && parsed.check.command ? checkLog : null,
    });
    this.counts[decision]++;
    if (applied) this.applied++;
    if (parsed.check && typeof parsed.check.durationMs === "number") this.checkLatencies.push(parsed.check.durationMs);
    this.appendVerdict(verdict);

    const message = String(parsed.message ?? `Verity: ${decision}`);
    let feedback = message;
    if (parsed.check && parsed.check.command && existsSync(checkLog) && decision !== "pass") {
      try {
        const tail = tailLines(readFileSync(checkLog, "utf8"), FEEDBACK_TAIL_LINES);
        if (tail) feedback += `\n\nLast ${FEEDBACK_TAIL_LINES} lines of the trusted check (\`${parsed.check.command}\`, exit ${parsed.check.exitCode}):\n${tail}`;
      } catch {}
    }
    const summary = summarizeVerdict({ ...parsed, exitCode: r.code }, this.mode, applied, durationMs);
    if (this.o.concurrency > 1) summary.attribution = "shared";
    return { decision, applied, waived, message, feedback, summary, verdict };
  }

  campaignSummary(): CampaignVeritySummary {
    const lat = [...this.checkLatencies].sort((a, b) => a - b);
    const p95 = lat.length ? lat[Math.min(lat.length - 1, Math.ceil(lat.length * 0.95) - 1)] : null;
    return {
      mode: this.mode, source: this.resolution.source,
      ...(this.resolution.requestedMode ? { requestedMode: this.resolution.requestedMode, downgraded: this.resolution.downgraded } : {}),
      override: this.resolution.override,
      policy: { path: this.policy.path, exists: this.policy.exists, rootOwned: this.policy.rootOwned, mode: this.policy.mode, enabled: this.policy.enabled },
      cli: this.cli, cliPresent: this.cliPresent, log: this.logPath, requireCheck: this.requireCheck,
      verdicts: this.counts.pass + this.counts.fail + this.counts.unverifiable + this.counts.error,
      byDecision: { ...this.counts }, applied: this.applied,
      snapshots: this.snapshots, snapshotErrors: this.snapshotErrors,
      checkLatencyMs: { count: lat.length, max: lat.length ? lat[lat.length - 1] : null, p95 },
    };
  }
}

/** Prompt block for the attempt after a gate failure (same-executor resume or a reroute). */
export function verifyFeedbackBlock(feedback: string, attemptNo: number, executorId: string, resumedSameExecutor: boolean): string {
  const who = resumedSameExecutor
    ? `This is a RESUME of attempt ${attemptNo} on the same executor (${executorId}): its work in the task workspace is still there. Do not start over.`
    : `Attempt ${attemptNo} (${executorId}) declared success but its workspace did not pass; its work is still in the task workspace.`;
  return `<verity-gate-feedback>
The orchestrator's Verity gate rejected the declared success of attempt ${attemptNo}. ${who}
A declared success counts only when the workspace itself passes: code changes need the trusted check to pass (the orchestrator runs it), tests are never deleted or renamed away, no credential text is written into files, and the check's own definition is not edited in the same change.
${feedback}
</verity-gate-feedback>

`;
}

/** Absolute paths under `workspace` (the only exclusions the snapshot needs). */
export function workspaceSelfOutputs(files: string[], workspace: string): string[] {
  const root = resolve(workspace);
  return files.filter((f) => { const a = resolve(f); return a === root || a.startsWith(root + "/"); });
}
