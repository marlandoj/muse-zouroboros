import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export type RecoveryDisposition =
  | "preserved_in_place"
  | "preserved_copy"
  | "quarantined"
  | "removed_after_manifest";

export interface RecoveryArtifact {
  path: string;
  kind: "seed" | "seed_quarantine" | "worktree_patch" | "worktree_untracked" | "run_tmp";
  sha256: string;
  disposition: RecoveryDisposition;
  provenance: {
    execution_id: string;
    discovered_from: string;
    original_path?: string;
  };
  recovery_path?: string;
}

export interface WorktreeRecovery {
  repo_path: string;
  branch: string | null;
  dirty: boolean;
  status_digest: string;
  patch_path: string | null;
  untracked_root: string | null;
}

export interface RecoveryManifest {
  version: 1;
  execution_id: string;
  identifier: string;
  created_at: string;
  artifacts: RecoveryArtifact[];
  worktree: WorktreeRecovery | null;
  retry_decision: "retry" | "park" | "manual_review";
  retry_reason: string;
}

export interface RecoverableExecution {
  execution_id?: string;
  identifier?: string;
  seed_path?: string | null;
  branch_name?: string | null;
  repo_path?: string | null;
  repository_path?: string | null;
  target_repository?: string | null;
  worktree_path?: string | null;
  [key: string]: unknown;
}

export interface RecoveryOptions {
  recoveryRoot: string;
  repositoryRoots?: string[];
  temporaryRoots?: string[];
  now?: () => Date;
  dryRun?: boolean;
}

export interface RecoveryResult {
  manifestPath: string;
  manifest: RecoveryManifest;
  reused: boolean;
}

function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function fsyncDirectory(path: string): void {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    fsyncSync(fd);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function atomicWrite(
  targetPath: string,
  contents: string,
  validate: (contents: string) => void,
): void {
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | null = null;
  try {
    fd = openSync(tempPath, "wx", 0o600);
    writeFileSync(fd, contents, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    validate(readFileSync(tempPath, "utf8"));
    renameSync(tempPath, targetPath);
    fsyncDirectory(dirname(targetPath));
  } catch (error) {
    if (fd !== null) closeSync(fd);
    rmSync(tempPath, { force: true });
    throw error;
  }
}

export function parseSeedYaml(contents: string): Record<string, unknown> {
  const parsed = Bun.YAML.parse(contents);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("seed YAML must contain one top-level mapping");
  }
  return parsed as Record<string, unknown>;
}

/** Publish only a fully written, parseable seed. The previous live file survives every failure. */
export function atomicPublishSeed(seedPath: string, contents: string): void {
  atomicWrite(seedPath, contents, (candidate) => {
    parseSeedYaml(candidate);
  });
}

function atomicWriteJson(targetPath: string, value: unknown): void {
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  atomicWrite(targetPath, contents, (candidate) => {
    JSON.parse(candidate);
  });
}

function safeChildren(path: string): string[] {
  try {
    return readdirSync(path).map((name) => join(path, name));
  } catch {
    return [];
  }
}

function isWithin(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== "..");
}

function runGit(repoPath: string, args: string[]): string | null {
  const result = spawnSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout : null;
}

function isGitWorktree(path: string): boolean {
  return runGit(path, ["rev-parse", "--is-inside-work-tree"])?.trim() === "true";
}

function worktreesFor(root: string): Array<{ path: string; branch: string | null }> {
  const output = runGit(root, ["worktree", "list", "--porcelain"]);
  if (output === null) return [];
  const found: Array<{ path: string; branch: string | null }> = [];
  let current: { path: string; branch: string | null } | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current) found.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
    } else if (current && line.startsWith("branch refs/heads/")) {
      current.branch = line.slice("branch refs/heads/".length);
    }
  }
  if (current) found.push(current);
  return found;
}

function findWorktree(exec: RecoverableExecution, roots: string[]): { path: string; branch: string | null } | null {
  const explicitWorktrees = [exec.worktree_path]
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  for (const path of explicitWorktrees) {
    if (existsSync(path) && isGitWorktree(path)) {
      return { path: resolve(path), branch: exec.branch_name ?? runGit(path, ["branch", "--show-current"])?.trim() ?? null };
    }
  }

  const repositoryRoots = [exec.repo_path, exec.repository_path, exec.target_repository, ...roots]
    .filter((path): path is string => typeof path === "string" && path.length > 0);
  for (const root of repositoryRoots) {
    if (!existsSync(root) || !isGitWorktree(root)) continue;
    const worktrees = worktreesFor(root);
    const match = exec.branch_name ? worktrees.find((item) => item.branch === exec.branch_name) : null;
    if (match) return existsSync(match.path) && isGitWorktree(match.path) ? match : null;
  }

  for (const path of repositoryRoots) {
    if (!existsSync(path) || !isGitWorktree(path)) continue;
    const currentBranch = runGit(path, ["branch", "--show-current"])?.trim() ?? null;
    if (!exec.branch_name || currentBranch === exec.branch_name) {
      return { path: resolve(path), branch: currentBranch };
    }
  }
  return null;
}

function copyDurably(source: string, target: string): void {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  const fd = openSync(target, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  fsyncDirectory(dirname(target));
}

function preserveWorktree(
  executionId: string,
  worktree: { path: string; branch: string | null },
  archiveRoot: string,
  artifacts: RecoveryArtifact[],
  dryRun: boolean,
): WorktreeRecovery {
  const status = runGit(worktree.path, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "";
  const dirty = status.length > 0;
  const statusDigest = sha256Bytes(status);
  if (!dirty) {
    return { repo_path: worktree.path, branch: worktree.branch, dirty, status_digest: statusDigest, patch_path: null, untracked_root: null };
  }

  const patchPath = join(archiveRoot, "worktree.patch");
  const patch = runGit(worktree.path, ["diff", "--binary", "HEAD", "--"]) ?? "";
  if (!dryRun) atomicWrite(patchPath, patch, () => undefined);
  artifacts.push({
    path: patchPath,
    kind: "worktree_patch",
    sha256: sha256Bytes(patch),
    disposition: "preserved_copy",
    provenance: { execution_id: executionId, discovered_from: "git diff --binary HEAD", original_path: worktree.path },
  });

  const untrackedRoot = join(archiveRoot, "untracked");
  const untracked = (runGit(worktree.path, ["ls-files", "--others", "--exclude-standard", "-z"]) ?? "")
    .split("\0")
    .filter(Boolean);
  for (const rel of untracked) {
    const source = resolve(worktree.path, rel);
    if (!isWithin(source, worktree.path) || !existsSync(source) || !lstatSync(source).isFile()) continue;
    const target = join(untrackedRoot, rel);
    if (!dryRun) copyDurably(source, target);
    artifacts.push({
      path: source,
      recovery_path: target,
      kind: "worktree_untracked",
      sha256: sha256File(source),
      disposition: "preserved_copy",
      provenance: { execution_id: executionId, discovered_from: "git ls-files --others", original_path: source },
    });
  }

  return {
    repo_path: worktree.path,
    branch: worktree.branch,
    dirty,
    status_digest: statusDigest,
    patch_path: patchPath,
    untracked_root: untracked.length > 0 ? untrackedRoot : null,
  };
}

const TMP_SCAN_MAX_DEPTH = 4;

function matchingTemporaryFiles(roots: string[], tokens: string[], excludedRoot: string): string[] {
  const found = new Set<string>();
  const visit = (path: string, depth: number): void => {
    if (depth > TMP_SCAN_MAX_DEPTH || isWithin(path, excludedRoot)) return;
    let stat;
    try {
      stat = lstatSync(path);
    } catch {
      return;
    }
    const lower = path.toLowerCase();
    const matches = tokens.some((token) => token.length >= 5 && lower.includes(token));
    if (stat.isFile()) {
      if (matches) found.add(resolve(path));
      return;
    }
    if (!stat.isDirectory()) return;
    for (const child of safeChildren(path)) visit(child, depth + 1);
  };
  for (const root of roots) {
    if (existsSync(root)) visit(root, 0);
  }
  return [...found].sort();
}

function readExistingManifest(path: string): RecoveryManifest | null {
  if (!existsSync(path)) return null;
  const manifest = JSON.parse(readFileSync(path, "utf8")) as RecoveryManifest;
  if (manifest.version !== 1 || !manifest.execution_id || !Array.isArray(manifest.artifacts)) {
    throw new Error(`invalid recovery manifest: ${path}`);
  }
  return manifest;
}

function finalizeQuarantines(manifest: RecoveryManifest, dryRun: boolean): void {
  if (dryRun) return;
  for (const artifact of manifest.artifacts) {
    if (artifact.kind !== "seed_quarantine") continue;
    if (!existsSync(artifact.path)) continue;
    if (!artifact.recovery_path) {
      throw new Error(`seed_quarantine artifact has no recovery_path — manifest invariant violated: ${artifact.path}`);
    }
    if (!existsSync(artifact.recovery_path) || sha256File(artifact.recovery_path) !== artifact.sha256) {
      throw new Error(`quarantine copy is missing or has the wrong digest: ${artifact.recovery_path}`);
    }
    if (sha256File(artifact.path) === artifact.sha256) unlinkSync(artifact.path);
  }
}

export function recoverExecutionArtifacts(exec: RecoverableExecution, options: RecoveryOptions): RecoveryResult {
  const executionId = exec.execution_id?.trim();
  const identifier = exec.identifier?.trim();
  if (!executionId || !identifier) throw new Error("recovery requires execution_id and identifier");
  if (!/^[A-Za-z0-9._-]+$/.test(executionId)) throw new Error(`unsafe execution_id for recovery path: ${executionId}`);

  const archiveRoot = join(options.recoveryRoot, executionId);
  const manifestPath = join(options.recoveryRoot, `recovery-${executionId}.json`);
  const existing = readExistingManifest(manifestPath);
  if (existing) {
    finalizeQuarantines(existing, options.dryRun === true);
    return { manifestPath, manifest: existing, reused: true };
  }

  const dryRun = options.dryRun === true;
  const artifacts: RecoveryArtifact[] = [];
  let corruptSeedSource: string | null = null;
  if (exec.seed_path && existsSync(exec.seed_path)) {
    const digest = sha256File(exec.seed_path);
    try {
      parseSeedYaml(readFileSync(exec.seed_path, "utf8"));
      artifacts.push({
        path: resolve(exec.seed_path),
        kind: "seed",
        sha256: digest,
        disposition: "preserved_in_place",
        provenance: { execution_id: executionId, discovered_from: "execution.seed_path" },
      });
    } catch {
      corruptSeedSource = resolve(exec.seed_path);
      const quarantinePath = join(archiveRoot, "quarantine", `${basename(exec.seed_path)}.${digest}.corrupt`);
      if (!dryRun) copyDurably(exec.seed_path, quarantinePath);
      artifacts.push({
        path: corruptSeedSource,
        recovery_path: quarantinePath,
        kind: "seed_quarantine",
        sha256: digest,
        disposition: "quarantined",
        provenance: { execution_id: executionId, discovered_from: "execution.seed_path parse failure", original_path: corruptSeedSource },
      });
    }
  }

  const repositoryRoots = options.repositoryRoots ?? [];
  const worktree = findWorktree(exec, repositoryRoots);
  const worktreeRecovery = worktree
    ? preserveWorktree(executionId, worktree, archiveRoot, artifacts, dryRun)
    : null;

  const tokens = [executionId, identifier, exec.branch_name ?? ""].map((token) => token.toLowerCase());
  const temporaryRoots = options.temporaryRoots ?? [join(dirname(options.recoveryRoot), "tmp"), tmpdir()];
  for (const path of matchingTemporaryFiles(temporaryRoots, tokens, options.recoveryRoot)) {
    artifacts.push({
      path,
      kind: "run_tmp",
      sha256: sha256File(path),
      disposition: "preserved_in_place",
      provenance: { execution_id: executionId, discovered_from: "run token in configured temporary root" },
    });
  }

  const dirty = worktreeRecovery?.dirty === true;
  const manifest: RecoveryManifest = {
    version: 1,
    execution_id: executionId,
    identifier,
    created_at: (options.now ?? (() => new Date()))().toISOString(),
    artifacts,
    worktree: worktreeRecovery,
    retry_decision: dirty ? "manual_review" : "retry",
    retry_reason: dirty
      ? "dirty worktree preserved; operator review required before retry"
      : corruptSeedSource
        ? "corrupt seed quarantined; retry may regenerate it"
        : "artifacts inventoried; retry may proceed",
  };

  if (!dryRun) {
    atomicWriteJson(manifestPath, manifest);
    finalizeQuarantines(manifest, false);
  }
  return { manifestPath, manifest, reused: false };
}
