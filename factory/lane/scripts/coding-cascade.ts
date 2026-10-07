#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { appendWorktreeLedger } from "./execution-repository";
import { factoryWorktreesRoot, loadFactoryPathProfile } from "../../../packages/zo-swarm-orchestrator/src/transport/factory-path-profile";
import type { ExecutionPolicy } from "./model-policy";

export type CodingCascadeMode = "off" | "shadow" | "enforce";

export const CODING_CASCADE_MODELS = [
  { id: "byok:b74479bc-ec30-494d-a8c8-b2ff6218e1c0", label: "Claude Code - Opus" },
  { id: "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f", label: "Codex GPT 5.6 Sol" },
  { id: "byok:463350ac-4a49-4ceb-8653-042ecffa513f", label: "Kimi K2.7-Code" },
] as const;

export type CascadeFailureKind =
  | "timeout"
  | "transport"
  | "mechanical_validation"
  | "governance"
  | "authorization"
  | "policy"
  | "unsafe_scope"
  | "worker_failure"
  | "dispatch"
  | "unknown";

export interface CascadeFailure {
  kind: CascadeFailureKind;
  retryable: boolean;
  detail: string;
}

export interface CascadeValidationCommand {
  label: string;
  command: string;
  args: string[];
  timeout_ms?: number;
}

export interface CascadeValidationCheck {
  label: string;
  command: string;
  args: string[];
  status: number | null;
  pass: boolean;
  summary: string;
}

export interface CascadeValidationResult {
  pass: boolean;
  checks: CascadeValidationCheck[];
  validated_at: string;
}

const DEFAULT_ZOUROBOROS_ROOT = resolve(import.meta.dir, "../../..");

function configuredWorkspaceRoot(): string {
  const profile = loadFactoryPathProfile();
  if (profile) return profile.source_root;
  return resolve(process.env.ZOUROBOROS_WORKSPACE ?? DEFAULT_ZOUROBOROS_ROOT);
}

export const CANONICAL_CONSTITUTION_GATE = resolve(
  process.env.ZOUROBOROS_CONSTITUTION_GATE
    ?? join(configuredWorkspaceRoot(), "Skills", "zouroboros-governance", "scripts", "constitution-gate.ts"),
);
const REPOSITORY_CONSTITUTION_GATE = "Skills/zouroboros-governance/scripts/constitution-gate.ts";

export interface CascadeIntegrationReceipt {
  version: 1;
  assignment_id: string;
  campaign_id: string;
  task_id: string;
  source_worktree: string;
  target_repository: string;
  base_commit: string;
  target_parent_commit: string;
  implementation_commit: string;
  patch_sha256: string;
  patch_path: string;
  validation: CascadeValidationResult;
  integrated_at: string;
}

export type CascadeDecisionAction = "legacy" | "would_retry" | "retry" | "terminal" | "exhausted";

export interface CascadeDecision {
  mode: CodingCascadeMode;
  action: CascadeDecisionAction;
  trigger: CascadeFailureKind;
  retryable: boolean;
  attempts_made: number;
  max_attempts: number;
  decided_at: string;
}

export interface ReviewFailureInput {
  blocking?: boolean;
  deterministic?: { pass: boolean; summary: string };
  consensus?: { pass: boolean; summary: string } | null;
  persona_reviews?: { mode: string; pass: boolean; summary: string; invoked_count?: number } | null;
}

export function resolveCodingCascadeMode(
  env: Record<string, string | undefined> = process.env,
): CodingCascadeMode {
  const mode = env.FACTORY_CODING_CASCADE ?? "off";
  if (mode !== "off" && mode !== "shadow" && mode !== "enforce") {
    throw new Error(`FACTORY_CODING_CASCADE must be off|shadow|enforce, got ${mode}`);
  }
  return mode;
}

export function effectiveCodingModelChain(
  mode: CodingCascadeMode,
  policy: ExecutionPolicy | null | undefined,
  incumbent: readonly string[],
): string[] {
  if (policy?.model_chain.length) return [...policy.model_chain];
  return mode === "enforce" ? CODING_CASCADE_MODELS.map((model) => model.id) : [...incumbent];
}

export function maxCodingAttempts(
  mode: CodingCascadeMode,
  policy: ExecutionPolicy | null | undefined,
  incumbent: readonly string[],
): number {
  if (policy?.model_chain.length) return policy.model_chain.length;
  return mode === "off" ? incumbent.length : CODING_CASCADE_MODELS.length;
}

export function classifyCascadeFailure(input: {
  cause: CascadeFailureKind;
  detail?: string;
  review?: ReviewFailureInput | null;
}): CascadeFailure {
  if (input.cause === "timeout") {
    return { kind: "timeout", retryable: true, detail: input.detail ?? "assignment timed out" };
  }
  if (input.cause === "transport") {
    return { kind: "transport", retryable: true, detail: input.detail ?? "provider transport failed" };
  }
  if (input.cause === "mechanical_validation") {
    return { kind: "mechanical_validation", retryable: true, detail: input.detail ?? "mechanical validation failed" };
  }
  if (input.cause === "worker_failure" && input.review?.blocking) {
    if (input.review.deterministic?.pass === false) {
      return {
        kind: "mechanical_validation",
        retryable: true,
        detail: input.review.deterministic.summary || input.detail || "mechanical validation failed",
      };
    }
    if (input.review.consensus?.pass === false) {
      return {
        kind: "governance",
        retryable: false,
        detail: input.review.consensus.summary || input.detail || "consensus review did not pass",
      };
    }
    if (input.review.persona_reviews?.mode === "enforce" && input.review.persona_reviews.pass === false) {
      // ZOU-1576 defect 3: a persona gate that blocked without a single
      // reviewer running is a transport failure wearing a governance label.
      // The same underlying abort arriving as cause "timeout" is retryable;
      // classifying it as governance burned a cascade attempt and made a
      // phantom rejection terminal.
      if (input.review.persona_reviews.invoked_count === 0) {
        return {
          kind: "transport",
          retryable: true,
          detail:
            input.detail
            || input.review.persona_reviews.summary
            || "persona diversity review blocked with no reviewer invoked",
        };
      }
      return {
        kind: "governance",
        retryable: false,
        detail: input.review.persona_reviews.summary || input.detail || "persona diversity review did not pass",
      };
    }
    // ZOU-1573: a blocking review with a green deterministic battery and no
    // persona/consensus evidence (the no_review deadlock) previously fell
    // through and echoed the deterministic summary ("git diff --check
    // passed"), making a terminal failure read like a pass.
    return {
      kind: "governance",
      retryable: false,
      detail: input.detail ?? "factory review gate blocked the implementation without review evidence",
    };
  }
  if (input.cause === "dispatch") {
    return { kind: "dispatch", retryable: true, detail: input.detail ?? "dispatch-time failure" };
  }
  return {
    kind: input.cause,
    retryable: false,
    detail: input.detail ?? `${input.cause} failure`,
  };
}

export function decideCascadeRetry(input: {
  mode: CodingCascadeMode;
  failure: CascadeFailure;
  attempts_made: number;
  max_attempts: number;
  now?: () => string;
}): CascadeDecision {
  let action: CascadeDecisionAction;
  if (input.mode === "off") action = "legacy";
  else if (!input.failure.retryable) action = "terminal";
  else if (input.attempts_made >= input.max_attempts) action = "exhausted";
  else action = input.mode === "shadow" ? "would_retry" : "retry";
  return {
    mode: input.mode,
    action,
    trigger: input.failure.kind,
    retryable: input.failure.retryable,
    attempts_made: input.attempts_made,
    max_attempts: input.max_attempts,
    decided_at: (input.now ?? (() => new Date().toISOString()))(),
  };
}

export class CascadeDispatchError extends Error {
  constructor(
    message: string,
    readonly failureKind: CascadeFailureKind,
  ) {
    super(message);
    this.name = "CascadeDispatchError";
  }
}

export function httpFailureKind(status: number): CascadeFailureKind {
  if (status === 401 || status === 403) return "authorization";
  if (status === 400 || status === 404 || status === 409 || status === 422) return "policy";
  return status === 408 || status === 425 || status === 429 || status >= 500 ? "transport" : "unknown";
}

interface CommandResult {
  status: number | null;
  stdout: string;
  stderr: string;
  error?: Error;
}

interface CascadeCommandOptions {
  cwd: string;
  timeoutMs?: number;
}

export type CascadeCommandRunner = (
  command: string,
  args: string[],
  options: CascadeCommandOptions,
) => CommandResult;

export interface CascadeWorktreeOptions {
  workspaceRoot?: string;
  worktreesRoot?: string;
  exists?: (path: string) => boolean;
  realpath?: (path: string) => string;
  run?: (command: string, args: string[]) => CommandResult;
}

function defaultRun(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function defaultCascadeRun(command: string, args: string[], options: CascadeCommandOptions): CommandResult {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error,
  };
}

function commandError(result: CommandResult): string {
  return result.error?.message || result.stderr.trim() || result.stdout.trim() || `exit ${result.status ?? "unknown"}`;
}

function requireInside(path: string, parent: string): string {
  const child = relative(parent, path);
  if (child.startsWith("..") || isAbsolute(child)) throw new Error(`path is outside workspace root: ${path}`);
  return path;
}

function canonicalizeProspectivePath(
  path: string,
  options: Pick<CascadeWorktreeOptions, "exists" | "realpath"> = {},
): string {
  const exists = options.exists ?? existsSync;
  const canonicalize = options.realpath ?? realpathSync;
  let ancestor = resolve(path);
  const suffix: string[] = [];

  while (!exists(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) throw new Error(`cannot resolve prospective path without an existing ancestor: ${path}`);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }

  return resolve(canonicalize(ancestor), ...suffix);
}

function sanitize(value: string): string {
  return value.trim().replace(/[^A-Za-z0-9_-]/g, "_") || "assignment";
}

export function captureRepositoryBaseCommit(
  repository: string,
  options: Pick<CascadeWorktreeOptions, "run"> = {},
): string {
  const run = options.run ?? defaultRun;
  const status = run("git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error(`cannot inspect repository cleanliness: ${commandError(status)}`);
  if (status.stdout.trim()) throw new Error(`repository is not clean: ${status.stdout.trim().slice(0, 300)}`);
  const result = run("git", ["-C", repository, "rev-parse", "HEAD"]);
  const commit = result.stdout.trim();
  if (result.status !== 0 || !/^[0-9a-f]{40}$/i.test(commit)) {
    throw new Error(`cannot resolve repository base commit: ${commandError(result)}`);
  }
  return commit.toLowerCase();
}

export function planCascadeWorktree(
  repository: string,
  assignmentId: string,
  options: CascadeWorktreeOptions = {},
): string {
  const workspaceRoot = canonicalizeProspectivePath(options.workspaceRoot ?? configuredWorkspaceRoot(), options);
  const worktreesRoot = canonicalizeProspectivePath(
    factoryWorktreesRoot(options.worktreesRoot, join(workspaceRoot, ".factory-worktrees")),
    options,
  );
  requireInside(worktreesRoot, loadFactoryPathProfile()?.worktrees_root ?? workspaceRoot);
  return join(worktreesRoot, `cascade-${sanitize(basename(repository))}-${sanitize(assignmentId)}`);
}

export function prepareCascadeWorktree(input: {
  repository: string;
  base_commit: string;
  assignment_id: string;
  options?: CascadeWorktreeOptions;
}): string {
  if (!/^[0-9a-f]{40}$/i.test(input.base_commit)) throw new Error("base commit must be a full 40-character git SHA");
  const options = input.options ?? {};
  const exists = options.exists ?? existsSync;
  const canonicalize = options.realpath ?? realpathSync;
  const run = options.run ?? defaultRun;
  const workspaceRoot = canonicalizeProspectivePath(options.workspaceRoot ?? configuredWorkspaceRoot(), options);
  const repository = requireInside(canonicalize(input.repository), workspaceRoot);
  const outputRoot = loadFactoryPathProfile()?.worktrees_root ?? workspaceRoot;
  const sourceRoot = loadFactoryPathProfile()?.source_root;
  if (sourceRoot) requireInside(repository, sourceRoot);
  let worktree = requireInside(
    canonicalizeProspectivePath(
      planCascadeWorktree(repository, input.assignment_id, { ...options, workspaceRoot }),
      options,
    ),
    outputRoot,
  );

  if (!exists(worktree)) {
    mkdirSync(dirname(worktree), { recursive: true });
    worktree = requireInside(canonicalizeProspectivePath(worktree, options), outputRoot);
    const added = run("git", ["-C", repository, "worktree", "add", "--detach", worktree, input.base_commit]);
    if (added.status !== 0) throw new Error(`cannot create clean cascade worktree: ${commandError(added)}`);
  }

  const head = run("git", ["-C", worktree, "rev-parse", "HEAD"]);
  if (head.status !== 0 || head.stdout.trim().toLowerCase() !== input.base_commit.toLowerCase()) {
    throw new Error(`cascade worktree base mismatch: expected ${input.base_commit}, got ${head.stdout.trim() || commandError(head)}`);
  }
  const status = run("git", ["-C", worktree, "status", "--porcelain", "--untracked-files=all"]);
  if (status.status !== 0) throw new Error(`cannot prove cascade worktree cleanliness: ${commandError(status)}`);
  if (status.stdout.trim()) throw new Error(`cascade worktree is not clean: ${status.stdout.trim().slice(0, 300)}`);
  appendWorktreeLedger(
    {
      ts: new Date().toISOString(),
      repoPath: repository,
      ticketId: input.assignment_id,
      worktreePath: worktree,
      baseRef: input.base_commit.toLowerCase(),
      baseCommit: input.base_commit.toLowerCase(),
      status: "active",
    },
    { workspaceRoot },
  );
  return worktree;
}

export function runCascadeValidation(input: {
  worktree: string;
  commands: readonly CascadeValidationCommand[];
  run?: CascadeCommandRunner;
  now?: () => string;
}): CascadeValidationResult {
  if (input.commands.length === 0) throw new Error("coding cascade enforce requires factory-owned validation commands");
  const run = input.run ?? defaultCascadeRun;
  const checks: CascadeValidationCheck[] = [];
  for (const command of input.commands) {
    const result = run(command.command, command.args, {
      cwd: input.worktree,
      timeoutMs: command.timeout_ms ?? 10 * 60_000,
    });
    const summary = commandError(result).slice(0, 2_000);
    checks.push({
      label: command.label,
      command: command.command,
      args: [...command.args],
      status: result.status,
      pass: result.status === 0,
      summary: result.status === 0 ? `${command.label} passed` : summary,
    });
    if (result.status !== 0) break;
  }
  return {
    pass: checks.length === input.commands.length && checks.every((check) => check.pass),
    checks,
    validated_at: (input.now ?? (() => new Date().toISOString()))(),
  };
}

function fullCommit(value: string, label: string): string {
  const commit = value.trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${label} is not a full commit SHA`);
  return commit;
}

function requireCleanRepository(repository: string, run: CascadeCommandRunner): void {
  const status = run("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: repository });
  if (status.status !== 0) throw new Error(`cannot inspect integration target: ${commandError(status)}`);
  if (status.stdout.trim()) throw new Error(`integration target is not clean: ${status.stdout.trim().slice(0, 300)}`);
}

export function integrateCascadeWorktree(input: {
  assignment_id: string;
  campaign_id: string;
  task_id: string;
  source_worktree: string;
  target_repository: string;
  base_commit: string;
  receipt_path: string;
  validation: CascadeValidationResult;
  run?: CascadeCommandRunner;
  now?: () => string;
}): CascadeIntegrationReceipt {
  if (!input.validation.pass) throw new Error("refusing to integrate an assignment that failed validation");
  const run = input.run ?? defaultCascadeRun;
  const workspaceRoot = realpathSync(configuredWorkspaceRoot());
  const target = requireInside(realpathSync(input.target_repository), workspaceRoot);
  const baseCommit = fullCommit(input.base_commit, "assignment base commit");
  const receiptPath = requireInside(canonicalizeProspectivePath(input.receipt_path), workspaceRoot);
  const patchPath = requireInside(
    canonicalizeProspectivePath(receiptPath.endsWith(".json") ? `${receiptPath.slice(0, -5)}.patch` : `${receiptPath}.patch`),
    workspaceRoot,
  );
  if (existsSync(receiptPath)) {
    const existing = JSON.parse(readFileSync(receiptPath, "utf8")) as CascadeIntegrationReceipt;
    if (existing.assignment_id !== input.assignment_id || existing.target_repository !== target) {
      throw new Error(`integration receipt ownership mismatch: ${receiptPath}`);
    }
    const present = run("git", ["cat-file", "-e", `${existing.implementation_commit}^{commit}`], { cwd: target });
    if (present.status !== 0) throw new Error(`integration receipt commit is unavailable: ${existing.implementation_commit}`);
    const integrated = run("git", ["merge-base", "--is-ancestor", existing.implementation_commit, "HEAD"], { cwd: target });
    if (integrated.status !== 0) throw new Error(`integration receipt commit is not present at target HEAD: ${existing.implementation_commit}`);
    if (!existsSync(existing.patch_path)) throw new Error(`integration receipt patch is unavailable: ${existing.patch_path}`);
    const recordedPatchHash = createHash("sha256").update(readFileSync(existing.patch_path)).digest("hex");
    if (recordedPatchHash !== existing.patch_sha256) throw new Error(`integration receipt patch hash mismatch: ${existing.patch_path}`);
    return existing;
  }
  const source = requireInside(realpathSync(input.source_worktree), workspaceRoot);

  const ancestor = run("git", ["merge-base", "--is-ancestor", baseCommit, "HEAD"], { cwd: source });
  if (ancestor.status !== 0) throw new Error(`assignment worktree does not descend from ${baseCommit}`);
  const untracked = run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: source });
  if (untracked.status !== 0) throw new Error(`cannot inspect untracked assignment files: ${commandError(untracked)}`);
  if (untracked.stdout.trim()) throw new Error(`assignment contains untracked files that were not staged: ${untracked.stdout.trim().slice(0, 300)}`);

  const patch = run("git", ["diff", "--binary", "--full-index", baseCommit, "--", "."], { cwd: source });
  if (patch.status !== 0) throw new Error(`cannot create assignment patch: ${commandError(patch)}`);
  if (!patch.stdout.trim()) throw new Error("successful assignment produced no integrable patch");
  const patchSha256 = createHash("sha256").update(patch.stdout).digest("hex");
  mkdirSync(dirname(receiptPath), { recursive: true });
  writeFileSync(patchPath, patch.stdout);

  requireCleanRepository(target, run);
  const parent = run("git", ["rev-parse", "HEAD"], { cwd: target });
  const targetParentCommit = fullCommit(parent.stdout, "integration target HEAD");
  const check = run("git", ["apply", "--check", "--index", patchPath], { cwd: target });
  if (check.status !== 0) throw new Error(`assignment patch conflicts with integration target: ${commandError(check)}`);
  const apply = run("git", ["apply", "--index", patchPath], { cwd: target });
  if (apply.status !== 0) throw new Error(`assignment patch application failed: ${commandError(apply)}`);

  const commit = run("git", [
    "-c", "user.name=Zouroboros Factory",
    "-c", "user.email=zouroboros@local",
    "commit", "--no-gpg-sign", "-m", `factory(${input.campaign_id}): ${input.task_id}`,
  ], { cwd: target });
  if (commit.status !== 0) {
    const rollback = run("git", ["apply", "--reverse", "--index", patchPath], { cwd: target });
    if (rollback.status !== 0) {
      throw new Error(`integration commit failed and patch rollback failed: ${commandError(commit)}; ${commandError(rollback)}`);
    }
    throw new Error(`integration commit failed: ${commandError(commit)}`);
  }
  const head = run("git", ["rev-parse", "HEAD"], { cwd: target });
  const implementationCommit = fullCommit(head.stdout, "implementation commit");
  const receipt: CascadeIntegrationReceipt = {
    version: 1,
    assignment_id: input.assignment_id,
    campaign_id: input.campaign_id,
    task_id: input.task_id,
    source_worktree: source,
    target_repository: target,
    base_commit: baseCommit,
    target_parent_commit: targetParentCommit,
    implementation_commit: implementationCommit,
    patch_sha256: patchSha256,
    patch_path: patchPath,
    validation: input.validation,
    integrated_at: (input.now ?? (() => new Date().toISOString()))(),
  };
  const temp = `${receiptPath}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify(receipt, null, 2)}\n`);
  renameSync(temp, receiptPath);
  return receipt;
}
