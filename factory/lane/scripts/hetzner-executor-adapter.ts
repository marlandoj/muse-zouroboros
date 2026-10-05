import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadManifest,
  runEphemeralWorker,
  type EphemeralWorkerEvidence,
  type ExternalComputeManifest,
} from "../../../packages/hetzner-exec/src/ephemeral-worker";
import {
  CODING_CASCADE_MODELS,
  CascadeDispatchError,
  classifyCascadeFailure,
  decideCascadeRetry,
  effectiveCodingModelChain,
  httpFailureKind,
  resolveCodingCascadeMode,
  type CascadeDecision,
  type CascadeFailure,
  type CascadeFailureKind,
} from "./coding-cascade";
import type { ExecutionPolicy } from "./model-policy";
import {
  changeQuizAnswerInstructions,
  extractChangeQuizAnswers,
  resolveChangeQuizMode,
  type ChangeQuizAnswers,
  type ChangeQuizMode,
} from "./change-quiz";
import {
  resolveHetznerExecutionRoute,
  type HetznerExecutionRoute,
} from "./hetzner-executor-policy";

export interface HetznerExecutorTicket {
  identifier: string;
  title: string;
  description: string;
}

export interface HetznerCascadeAttempt {
  attempt: number;
  model: string;
  label: string;
  status: "passed" | "failed";
  failure: CascadeFailure | null;
  decision: CascadeDecision | null;
  evidence_path: string | null;
  estimated_compute_cost_usd: number | null;
}

export interface HetznerExecutorResult {
  requested: true;
  pass: boolean;
  summary: string;
  route: HetznerExecutionRoute;
  evidence_path: string | null;
  artifact_archive: string | null;
  patch_path: string | null;
  patch_applied: boolean;
  evidence: EphemeralWorkerEvidence | null;
  implementation_provider: "zo-byok";
  implementation_model: string | null;
  implementation_trail: string;
  cascade_attempts: HetznerCascadeAttempt[];
  change_quiz_answers?: ChangeQuizAnswers;
}

interface WorkerInput {
  workdir: string;
  manifest: ExternalComputeManifest;
  evidenceDir: string;
  env: Record<string, string | undefined>;
  remoteEnv: Record<string, string | undefined>;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ByokExecutorInput {
  prompt: string;
  model: string;
  token: string;
  timeoutMs: number;
}

export interface ByokExecutorResult {
  output: string;
  model: string;
}

export interface HetznerExecutorOptions {
  executionId: string;
  ticket: HetznerExecutorTicket;
  decision: "DIRECT" | "SUGGEST" | "SWARM" | "FORCE_SWARM";
  workdir: string;
  route?: HetznerExecutionRoute;
  executionPolicy?: ExecutionPolicy | null;
  env?: Record<string, string | undefined>;
  stateDir?: string;
  evidenceDir?: string;
  now?: () => Date;
  workerRun?: (input: WorkerInput) => Promise<EphemeralWorkerEvidence>;
  commandRun?: (command: string, args: string[], cwd?: string) => CommandResult;
  activeWorkerProbe?: (env: Record<string, string | undefined>) => boolean;
  byokRun?: (input: ByokExecutorInput) => Promise<ByokExecutorResult>;
}

interface LeaseOwner {
  version: 1;
  execution_id: string;
  ticket: string;
  pid: number;
  acquired_at: string;
  expires_at: string;
}

const FACTORY_ROOT = join(import.meta.dir, "..");
const DEFAULT_STATE_DIR = factoryStatePath("hetzner-executor");
const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
const DEFAULT_MODEL_TIMEOUT_MS = 30 * 60_000;

function runCommand(command: string, args: string[], cwd?: string): CommandResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function requireCommandOk(result: CommandResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`${operation} failed: ${(result.stderr || result.stdout).trim().slice(0, 500)}`);
  }
}

function activeEphemeralWorker(env: Record<string, string | undefined>): boolean {
  const result = spawnSync(
    "hcloud",
    ["server", "list", "-l", "zouroboros_worker=ephemeral", "-o", "json"],
    { env: { ...process.env, ...env }, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
  );
  if (result.status !== 0) throw new Error(`cannot verify Hetzner global capacity: ${(result.stderr || "").trim()}`);
  const servers = JSON.parse(result.stdout || "[]") as unknown[];
  return servers.length > 0;
}

function acquireLease(options: {
  stateDir: string;
  executionId: string;
  ticket: string;
  ttlMinutes: number;
  now: Date;
  activeWorkerProbe: () => boolean;
}): () => void {
  mkdirSync(options.stateDir, { recursive: true });
  const lockDir = join(options.stateDir, "active.lock");
  const ownerPath = join(lockDir, "owner.json");

  try {
    mkdirSync(lockDir);
  } catch {
    const owner = existsSync(ownerPath)
      ? JSON.parse(readFileSync(ownerPath, "utf8")) as Partial<LeaseOwner>
      : null;
    const expired = typeof owner?.expires_at === "string"
      && Date.parse(owner.expires_at) <= options.now.getTime();
    if (expired && !options.activeWorkerProbe()) {
      rmSync(lockDir, { recursive: true, force: true });
      mkdirSync(lockDir);
    } else {
      const holder = owner?.execution_id ? `${owner.execution_id}/${owner.ticket ?? "unknown"}` : "unknown";
      throw new Error(`Hetzner executor capacity is occupied by ${holder}`);
    }
  }

  const owner: LeaseOwner = {
    version: 1,
    execution_id: options.executionId,
    ticket: options.ticket,
    pid: process.pid,
    acquired_at: options.now.toISOString(),
    expires_at: new Date(options.now.getTime() + options.ttlMinutes * 60_000).toISOString(),
  };
  writeFileSync(ownerPath, `${JSON.stringify(owner, null, 2)}\n`, { flag: "wx" });
  return () => rmSync(lockDir, { recursive: true, force: true });
}

function modelTimeoutMs(env: Record<string, string | undefined>): number {
  const raw = env.SF_HETZNER_MODEL_TIMEOUT_MS;
  if (!raw) return DEFAULT_MODEL_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 60_000 || value > 60 * 60_000) {
    throw new Error("SF_HETZNER_MODEL_TIMEOUT_MS must be an integer between 60000 and 3600000");
  }
  return value;
}

async function runByok(input: ByokExecutorInput): Promise<ByokExecutorResult> {
  let response: Response;
  try {
    response = await fetch(ZO_ASK_URL, {
      method: "POST",
      headers: {
        Authorization: input.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ input: input.prompt, model_name: input.model }),
      signal: AbortSignal.timeout(input.timeoutMs),
    });
  } catch (error) {
    throw new CascadeDispatchError(
      `Zo BYOK transport failed: ${error instanceof Error ? error.message : String(error)}`,
      "transport",
    );
  }
  const body = await response.text();
  if (!response.ok) {
    throw new CascadeDispatchError(
      `Zo BYOK executor returned HTTP ${response.status}: ${body.slice(0, 300)}`,
      httpFailureKind(response.status),
    );
  }
  let parsed: { output?: unknown; model_name?: unknown; model?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new CascadeDispatchError("Zo BYOK executor returned invalid JSON", "transport");
  }
  return {
    output: typeof parsed.output === "string" ? parsed.output : "",
    model: typeof parsed.model_name === "string"
      ? parsed.model_name
      : typeof parsed.model === "string"
        ? parsed.model
        : input.model,
  };
}

function buildByokPrompt(input: {
  ticket: HetznerExecutorTicket;
  decision: HetznerExecutorOptions["decision"];
  workdir: string;
  model: string;
  attempt: number;
  changeQuizMode: ChangeQuizMode;
}): string {
  return [
    "You are the implementation executor for one Zouroboros Software Factory ticket.",
    `Operate only in the clean isolated worktree at ${input.workdir}.`,
    "Implement the requested ticket completely in that worktree.",
    "Do not run broad install, typecheck, test, browser, build, render, or asset-processing commands locally; an ephemeral Hetzner worker will run the repository-declared verification commands after implementation.",
    "Do not commit, push, open or merge a pull request, publish, deploy, or create automation.",
    "Leave all successful implementation changes in the worktree for independent remote verification and factory review.",
    "Do not read, print, copy, or persist credentials.",
    "",
    `Cascade model: ${input.model}`,
    `Cascade attempt: ${input.attempt + 1}`,
    `Factory decision: ${input.decision}`,
    `Linear issue: ${input.ticket.identifier}`,
    `Title: ${input.ticket.title}`,
    "",
    "Linear description:",
    input.ticket.description,
    "",
    "Completion requirement: finish the implementation, leave the worktree changed, and report a concise summary.",
    ...(input.changeQuizMode === "off" ? [] : changeQuizAnswerInstructions()),
    "",
  ].join("\n");
}

function verificationCommands(workdir: string): string[] {
  const path = join(workdir, ".factory", "external-compute.json");
  if (!existsSync(path)) {
    throw new Error("Hetzner cascade requires .factory/external-compute.json with remote verification commands");
  }
  const commands = loadManifest(path).commands;
  if (commands.length === 0) throw new Error("Hetzner cascade requires at least one remote verification command");
  return commands;
}

function cleanGitPreflight(
  workdir: string,
  commandRun: (command: string, args: string[], cwd?: string) => CommandResult,
): string {
  const inside = commandRun("git", ["rev-parse", "--is-inside-work-tree"], workdir);
  requireCommandOk(inside, "verify Hetzner executor git worktree");
  if (inside.stdout.trim() !== "true") throw new Error("Hetzner executor target is not a git worktree");
  const status = commandRun("git", ["status", "--porcelain=v1", "--untracked-files=all"], workdir);
  requireCommandOk(status, "inspect Hetzner executor worktree");
  if (status.stdout.trim()) {
    throw new Error("Hetzner executor requires a clean isolated worktree; refusing to mix remote changes with local edits");
  }
  const head = commandRun("git", ["rev-parse", "HEAD"], workdir);
  requireCommandOk(head, "resolve Hetzner executor base commit");
  const commit = head.stdout.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("Hetzner executor base commit is invalid");
  return commit;
}

function requireImplementationChanges(
  workdir: string,
  commandRun: (command: string, args: string[], cwd?: string) => CommandResult,
): void {
  const status = commandRun("git", ["status", "--porcelain=v1", "--untracked-files=all"], workdir);
  requireCommandOk(status, "inspect BYOK implementation worktree");
  if (!status.stdout.trim()) throw new Error("Zo BYOK executor returned without implementation changes");
}

function restoreCleanBase(
  workdir: string,
  baseCommit: string,
  commandRun: (command: string, args: string[], cwd?: string) => CommandResult,
): void {
  requireCommandOk(commandRun("git", ["reset", "--hard", baseCommit], workdir), "restore rejected cascade attempt");
  requireCommandOk(commandRun("git", ["clean", "-ffd"], workdir), "remove rejected cascade artifacts");
  const status = commandRun("git", ["status", "--porcelain=v1", "--untracked-files=all"], workdir);
  requireCommandOk(status, "verify restored cascade base");
  if (status.stdout.trim()) throw new Error(`cascade base restoration left changes: ${status.stdout.trim().slice(0, 300)}`);
}

function modelLabel(model: string): string {
  return CODING_CASCADE_MODELS.find((entry) => entry.id === model)?.label ?? model;
}

function failureFromWorker(evidence: EphemeralWorkerEvidence): CascadeFailure {
  if (!evidence.teardown.server_deleted || !evidence.teardown.ssh_key_deleted) {
    return classifyCascadeFailure({
      cause: "worker_failure",
      detail: "Hetzner teardown evidence is incomplete",
    });
  }
  const failedCommand = evidence.commands.find((command) => command.exit_code !== 0);
  if (failedCommand) {
    return classifyCascadeFailure({
      cause: "mechanical_validation",
      detail: `${failedCommand.timed_out ? "remote validation timed out" : "remote validation failed"}: ${failedCommand.command}`,
    });
  }
  return classifyCascadeFailure({
    cause: "worker_failure",
    detail: evidence.error ?? "Hetzner worker failed before deterministic validation completed",
  });
}

function formatAttemptTrail(attempts: readonly HetznerCascadeAttempt[]): string {
  return attempts.map((attempt) => {
    const result = attempt.status === "passed" ? "ok" : attempt.failure?.kind ?? "failed";
    return `${attempt.label}=${result}`;
  }).join(" -> ");
}

function failureResult(input: {
  summary: string;
  route: HetznerExecutionRoute;
  attempts?: HetznerCascadeAttempt[];
  evidence?: EphemeralWorkerEvidence | null;
  evidencePath?: string | null;
}): HetznerExecutorResult {
  const attempts = input.attempts ?? [];
  return {
    requested: true,
    pass: false,
    summary: `Hetzner execution failed closed: ${input.summary}`,
    route: input.route,
    evidence_path: input.evidencePath ?? null,
    artifact_archive: input.evidence?.artifact_archive ?? null,
    patch_path: null,
    patch_applied: false,
    evidence: input.evidence ?? null,
    implementation_provider: "zo-byok",
    implementation_model: attempts.at(-1)?.model ?? null,
    implementation_trail: formatAttemptTrail(attempts),
    cascade_attempts: attempts,
  };
}

export async function runHetznerExecutor(options: HetznerExecutorOptions): Promise<HetznerExecutorResult> {
  const env = { ...process.env, ...(options.env ?? {}) };
  const route = options.route ?? resolveHetznerExecutionRoute(options.ticket, env);
  if (!route.requested) throw new Error("runHetznerExecutor called without a binding Hetzner request");
  if (!route.supported || !route.profile || !route.profile_name || !route.location || !route.image) {
    return failureResult({ summary: route.reason, route });
  }

  let cascadeMode;
  try {
    cascadeMode = resolveCodingCascadeMode(env);
  } catch (error) {
    return failureResult({ summary: error instanceof Error ? error.message : String(error), route });
  }
  if (cascadeMode !== "enforce") {
    return failureResult({ summary: "binding Hetzner execution requires FACTORY_CODING_CASCADE=enforce", route });
  }
  const modelChain = effectiveCodingModelChain(
    cascadeMode,
    options.executionPolicy,
    CODING_CASCADE_MODELS.map((model) => model.id),
  );
  const nonByok = modelChain.find((model) => !model.startsWith("byok:"));
  if (nonByok) {
    return failureResult({ summary: `Hetzner cascade refuses non-BYOK model route ${nonByok}`, route });
  }
  const zoToken = env.ZO_CLIENT_IDENTITY_TOKEN?.trim() || env.ZO_TOKEN?.trim();
  if (!zoToken) {
    return failureResult({ summary: "ZO_CLIENT_IDENTITY_TOKEN / ZO_TOKEN is unavailable for the BYOK cascade", route });
  }

  const workdir = resolve(options.workdir);
  const commandRun = options.commandRun ?? runCommand;
  const workerRun = options.workerRun ?? runEphemeralWorker;
  const byokRun = options.byokRun ?? runByok;
  const stateDir = resolve(options.stateDir ?? DEFAULT_STATE_DIR);
  const evidenceDir = resolve(options.evidenceDir ?? join(FACTORY_ROOT, "evaluations", "hetzner-executor", options.executionId));
  const now = options.now?.() ?? new Date();
  const changeQuizMode = resolveChangeQuizMode(env);
  const attempts: HetznerCascadeAttempt[] = [];
  let release: (() => void) | null = null;
  let evidence: EphemeralWorkerEvidence | null = null;
  let evidencePath: string | null = null;
  let baseCommit: string | null = null;

  try {
    baseCommit = cleanGitPreflight(workdir, commandRun);
    const commands = verificationCommands(workdir);
    const timeoutMs = modelTimeoutMs(env);
    mkdirSync(evidenceDir, { recursive: true });
    const probe = options.activeWorkerProbe ?? activeEphemeralWorker;
    if (probe(env)) throw new Error("Hetzner executor capacity is occupied by an active ephemeral worker");
    release = acquireLease({
      stateDir,
      executionId: options.executionId,
      ticket: options.ticket.identifier,
      ttlMinutes: (route.profile.ttl_minutes * modelChain.length) + Math.ceil(timeoutMs / 60_000),
      now,
      activeWorkerProbe: () => probe(env),
    });

    for (let attemptIndex = 0; attemptIndex < modelChain.length; attemptIndex++) {
      const requestedModel = modelChain[attemptIndex];
      const label = modelLabel(requestedModel);
      const attemptDir = join(evidenceDir, `attempt-${attemptIndex + 1}`);
      evidencePath = join(attemptDir, "evidence.json");
      evidence = null;
      let resolvedModel = requestedModel;
      let failure: CascadeFailure | null = null;
      let changeQuizAnswers: ChangeQuizAnswers | undefined;

      try {
        const result = await byokRun({
          prompt: buildByokPrompt({
            ticket: options.ticket,
            decision: options.decision,
            workdir,
            model: requestedModel,
            attempt: attemptIndex,
            changeQuizMode,
          }),
          model: requestedModel,
          token: zoToken,
          timeoutMs,
        });
        resolvedModel = result.model || requestedModel;
        if (changeQuizMode !== "off") {
          changeQuizAnswers = extractChangeQuizAnswers(result.output) ?? undefined;
        }
      } catch (error) {
        const kind: CascadeFailureKind = error instanceof CascadeDispatchError ? error.failureKind : "transport";
        failure = classifyCascadeFailure({ cause: kind, detail: error instanceof Error ? error.message : String(error) });
      }

      if (!failure) {
        try {
          requireImplementationChanges(workdir, commandRun);
        } catch (error) {
          failure = classifyCascadeFailure({
            cause: "mechanical_validation",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!failure) {
        const manifest: ExternalComputeManifest = {
          version: 1,
          commands: [
            "git init -q && git config user.email factory@zouroboros.invalid && git config user.name Zouroboros-Factory && git add -A && git commit -qm 'factory BYOK implementation snapshot'",
            ...commands,
          ],
          verification: "remote-required",
          artifacts: [],
          server_type: route.profile.server_type,
          image: route.image,
          location: route.location,
          ttl_minutes: route.profile.ttl_minutes,
          max_cost_usd: route.profile.max_cost_usd,
        };
        try {
          evidence = await workerRun({ workdir, manifest, evidenceDir: attemptDir, env, remoteEnv: {} });
          if (evidence.status !== "passed" || !evidence.teardown.server_deleted || !evidence.teardown.ssh_key_deleted) {
            failure = failureFromWorker(evidence);
          }
        } catch (error) {
          failure = classifyCascadeFailure({
            cause: "worker_failure",
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (!failure) {
        const attempt: HetznerCascadeAttempt = {
          attempt: attemptIndex,
          model: resolvedModel,
          label,
          status: "passed",
          failure: null,
          decision: null,
          evidence_path: evidencePath,
          estimated_compute_cost_usd: evidence?.estimated_cost_usd ?? null,
        };
        attempts.push(attempt);
        const trail = formatAttemptTrail(attempts);
        return {
          requested: true,
          pass: true,
          summary: `Zo BYOK cascade passed via ${label}; Hetzner ${route.profile_name}/${route.profile.server_type} verification passed; estimated $${(evidence?.estimated_cost_usd ?? 0).toFixed(4)}; worker deleted`,
          route,
          evidence_path: evidencePath,
          artifact_archive: evidence?.artifact_archive ?? null,
          patch_path: null,
          patch_applied: false,
          evidence,
          implementation_provider: "zo-byok",
          implementation_model: resolvedModel,
          implementation_trail: trail,
          cascade_attempts: attempts,
          ...(changeQuizAnswers ? { change_quiz_answers: changeQuizAnswers } : {}),
        };
      }

      const decision = decideCascadeRetry({
        mode: cascadeMode,
        failure,
        attempts_made: attemptIndex + 1,
        max_attempts: modelChain.length,
      });
      attempts.push({
        attempt: attemptIndex,
        model: resolvedModel,
        label,
        status: "failed",
        failure,
        decision,
        evidence_path: evidence && existsSync(evidencePath) ? evidencePath : null,
        estimated_compute_cost_usd: evidence?.estimated_cost_usd ?? null,
      });
      restoreCleanBase(workdir, baseCommit, commandRun);
      if (decision.action !== "retry") {
        return failureResult({
          summary: `${label} ${failure.kind}: ${failure.detail}; cascade ${decision.action}`,
          route,
          attempts,
          evidence,
          evidencePath: evidence && existsSync(evidencePath) ? evidencePath : null,
        });
      }
    }

    return failureResult({ summary: "BYOK cascade exhausted without a terminal result", route, attempts, evidence, evidencePath });
  } catch (error) {
    if (baseCommit) {
      try {
        restoreCleanBase(workdir, baseCommit, commandRun);
      } catch (restoreError) {
        return failureResult({
          summary: `${error instanceof Error ? error.message : String(error)}; clean-base restoration failed: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
          route,
          attempts,
          evidence,
          evidencePath,
        });
      }
    }
    return failureResult({
      summary: error instanceof Error ? error.message : String(error),
      route,
      attempts,
      evidence,
      evidencePath,
    });
  } finally {
    release?.();
  }
}

export function syntheticHetznerExecutionId(ticket: string): string {
  return `hetzner-${ticket.toLowerCase()}-${randomUUID().slice(0, 8)}`;
}
