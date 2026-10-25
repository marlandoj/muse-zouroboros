// Verity × Swarm (Stage 2b): the orchestrator-run, two-phase verify gate.
//
//   snapshot  — before the task's first attempt: record the pre-task state of
//               every git repo in the workspace (a tree object written through
//               a TEMPORARY index, so the real index is never touched and
//               .gitignore / info/exclude are honoured) plus a path/size/hash
//               manifest of loose files when the workspace root is not a repo.
//   verify    — after a declared success: build the ledger from the diff
//               between that base and the current state (committed, staged,
//               unstaged AND untracked work all count), apply the engine's
//               rules (code change, test deletion, secrets, check definition
//               tampering, hollow pass), run the TRUSTED check itself as a
//               child of the caller, and print one verdict JSON.
//
// The gate is harness-agnostic: it never reads what the agent claimed, only
// what the workspace contains. Verdicts hold provenance only — paths, labels,
// fingerprints, the trusted command, exit codes and hashes — never file
// contents, command output, or the text of a detected credential.
//
// Exit codes (cli.js): 0 pass, 1 fail (a rule was violated), 2 unverifiable
// (code changed, no check, --require-check off), 64 usage error, 70 internal
// error (the gate cannot answer). The orchestrator treats 64, 70, any other
// code, a timeout, unparseable stdout or a missing CLI as `error`, which
// fails closed in live mode.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { findSecrets, findSkipMarkers, isCodeFile, isVerify, looksLikeTestFile, repoHasTestFiles, stripModifiers } from "./checks.js";
import { decideStop } from "./rules.js";
import { globMatch, hash16, stripQuotesAndComments } from "./util.js";

export const BASE_SCHEMA = "verity.swarm.base/1";
export const VERDICT_SCHEMA = "verity.swarm.verdict/1";
export const EXIT = { PASS: 0, FAIL: 1, UNVERIFIABLE: 2, USAGE: 64, INTERNAL: 70 };
/** git's well-known empty tree: the base for a repo the agent created with `git init`. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const DEFAULT_CHECK_TIMEOUT_S = 900;
export const DEFAULT_MAX_DEPTH = 3;

/** Lockfiles never count as code changes (basename or glob match). */
export const DEFAULT_IGNORE = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "*.lock", "*.lockb"];
/** Loose-file manifest: never scanned (orchestrator/dispatcher artefacts; the gate's own state). */
const LOOSE_EXCLUDE_NAMES = new Set(["run.log", "TASK.md", ".verity", ".factory-seed.json"]);
const SKIP_DIRS = new Set([".git", "node_modules", ".verity"]);
export const MAX_LOOSE_FILES = 5000;
const MAX_LOOSE_SCAN_BYTES = 2 * 1024 * 1024;
const MAX_HASH_BYTES = 64 * 1024 * 1024;
const MAX_EXCLUDE_BYTES = 64 * 1024;
export const MAX_DIFF_BYTES = 128 * 1024 * 1024;
const MAX_ADDED_BYTES_PER_FILE = 4 * 1024 * 1024;
const MAX_CHECK_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Config files whose change redefines the check they configure. */
const CHECK_CONFIG_RE = /^(?:bunfig\.toml|pyproject\.toml|pytest\.ini|setup\.cfg|tox\.ini|\.mocharc(?:\.[a-z]+)?|(?:jest|vitest|vite|karma|playwright|cypress)\.config\.[cm]?[jt]s|(?:jest|vitest)\.config\.json)$/;
const MAKEFILE_RE = /^(?:Makefile|GNUmakefile|makefile)$/;
const ENV_SECRET_RE = /KEY|TOKEN|SECRET|PASSW|CREDENTIAL|AUTH|COOKIE/i;

export class GateError extends Error {
  constructor(message, code = EXIT.INTERNAL) {
    super(message);
    this.code = code;
  }
}
export class UsageError extends GateError {
  constructor(message) {
    super(message, EXIT.USAGE);
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sha256(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Shadow-git work trees (Phase 2, `verity run` on a non-git workspace): the
 * absolute work-tree root → its git dir under the Verity home. Every git call
 * on that root runs with GIT_DIR / GIT_WORK_TREE pointed there, so the
 * workspace itself never gains a .git.
 */
const SHADOW_GIT = new Map();
export function registerShadowGit(workTree, gitDir) {
  SHADOW_GIT.set(path.resolve(workTree), path.resolve(gitDir));
}

function git(repo, args, opts = {}) {
  const shadow = SHADOW_GIT.get(path.resolve(repo));
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: opts.binary ? "buffer" : "utf8",
    maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", ...(shadow ? { GIT_DIR: shadow, GIT_WORK_TREE: path.resolve(repo) } : {}), ...(opts.env || {}) },
    timeout: opts.timeoutMs ?? 120_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.error) throw new GateError(`git ${args[0]} failed in ${repo}: ${r.error.message}`);
  return r;
}

function gitOk(repo, args, opts = {}) {
  const r = git(repo, args, opts);
  if (r.status !== 0) {
    const err = String(r.stderr || "").trim().split("\n").slice(-3).join(" ");
    throw new GateError(`git ${args.join(" ")} failed in ${repo} (exit ${r.status}): ${err}`);
  }
  return r;
}

export function gitTry(repo, args, opts = {}) {
  try {
    const r = git(repo, args, opts);
    return r.status === 0 ? String(r.stdout).trim() : null;
  } catch {
    return null;
  }
}

function isRepoDir(dir) {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Repo directories (cwd-relative, "." for the root) up to maxDepth; a repo is not descended into. */
export function discoverRepos(root, maxDepth = DEFAULT_MAX_DEPTH) {
  const out = [];
  const walk = (dir, rel, depth) => {
    if (isRepoDir(dir)) {
      out.push(rel || ".");
      return;
    }
    if (depth >= maxDepth) return;
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      if (!d.isDirectory() || SKIP_DIRS.has(d.name)) continue;
      walk(path.join(dir, d.name), rel ? `${rel}/${d.name}` : d.name, depth + 1);
    }
  };
  walk(root, "", 0);
  return out;
}

function gitPath(repo, what) {
  const p = gitOk(repo, ["rev-parse", "--git-path", what]).stdout.trim();
  return path.isAbsolute(p) ? p : path.resolve(repo, p);
}

/**
 * The tree of the repo's CURRENT working state (tracked, staged, unstaged and
 * untracked files; .gitignore and info/exclude honoured), written through a
 * temporary copy of the index. The real index is never read-locked, written
 * or otherwise touched.
 */
export function writeWorkingTree(repo, { timeoutMs } = {}) {
  const indexPath = gitPath(repo, "index");
  const tmp = path.join(os.tmpdir(), `verity-swarm-index-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  try {
    if (fs.existsSync(indexPath)) {
      fs.copyFileSync(indexPath, tmp);
      // Keep git's racy-clean check honest: a fresh mtime on the copy would
      // make a same-size edit from the index's own timestamp window look
      // clean, so the copy carries the original's mtime (1 ms earlier errs
      // toward re-hashing, never toward trusting stale stat data).
      const st = fs.statSync(indexPath);
      fs.utimesSync(tmp, st.atimeMs / 1000, (st.mtimeMs - 1) / 1000);
    }
    const env = { GIT_INDEX_FILE: tmp };
    gitOk(repo, ["add", "-A", "--ignore-errors", "--", "."], { env, timeoutMs: timeoutMs ?? 600_000 });
    return gitOk(repo, ["write-tree"], { env, ...(timeoutMs ? { timeoutMs } : {}) }).stdout.trim();
  } finally {
    for (const f of [tmp, `${tmp}.lock`]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best effort
      }
    }
  }
}

function excludeRecord(repo) {
  let content = "";
  try {
    const p = gitPath(repo, "info/exclude");
    if (fs.existsSync(p)) content = fs.readFileSync(p, "utf8");
  } catch {
    content = "";
  }
  return { sha256: sha256(content), content: content.length <= MAX_EXCLUDE_BYTES ? content : null };
}

export function treeExists(repo, tree) {
  return git(repo, ["cat-file", "-e", `${tree}^{tree}`]).status === 0;
}

/** Remote URL → "host/owner/repo" (lowercase, no scheme/user/.git). */
export function normalizeRemote(url) {
  let s = String(url || "").trim();
  if (!s) return null;
  s = s.replace(/^[a-z+]+:\/\//i, "");
  s = s.replace(/^[^@/]+@/, "");
  s = s.replace(/^([^/:]+):(?!\/\/)/, "$1/");
  s = s.replace(/\/+$/, "").replace(/\.git$/i, "");
  return s.toLowerCase();
}

/** Base for a repo that appeared during the run: upstream merge-base, else the remote default branch, else the empty tree. */
function appearedRepoBase(repo) {
  const head = gitTry(repo, ["rev-parse", "--verify", "-q", "HEAD"]);
  if (!head) return { tree: EMPTY_TREE, source: "empty" };
  const upstream = gitTry(repo, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream) {
    const mb = gitTry(repo, ["merge-base", "HEAD", upstream]);
    const tree = mb ? gitTry(repo, ["rev-parse", `${mb}^{tree}`]) : null;
    if (tree) return { tree, source: "upstream-merge-base", ref: upstream, commit: mb };
  }
  const candidates = [];
  const originHead = gitTry(repo, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  if (originHead) candidates.push(originHead.replace(/^refs\/remotes\//, ""));
  candidates.push("origin/main", "origin/master");
  for (const ref of candidates) {
    if (!gitTry(repo, ["rev-parse", "--verify", "-q", `${ref}^{commit}`])) continue;
    const mb = gitTry(repo, ["merge-base", "HEAD", ref]);
    const tree = mb ? gitTry(repo, ["rev-parse", `${mb}^{tree}`]) : null;
    if (tree) return { tree, source: "remote-default-branch", ref, commit: mb };
  }
  return { tree: EMPTY_TREE, source: "empty" };
}

function hashFile(abs, size) {
  if (size > MAX_HASH_BYTES) return null;
  try {
    return sha256(fs.readFileSync(abs));
  } catch {
    return null;
  }
}

/** Loose files outside every repo (path, size, sha256), depth-bounded. */
export function looseManifest(root, { repos = [], exclude = [], maxDepth = 8 } = {}) {
  const repoRels = new Set(repos.filter((r) => r !== "."));
  const excludeAbs = new Set(exclude.map((p) => path.resolve(root, p)));
  const files = [];
  let truncated = false;
  const walk = (dir, rel, depth) => {
    if (truncated) return;
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    names.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of names) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (SKIP_DIRS.has(d.name) || LOOSE_EXCLUDE_NAMES.has(d.name) || excludeAbs.has(abs)) continue;
      if (d.isDirectory()) {
        if (repoRels.has(r) || isRepoDir(abs)) continue;
        if (depth < maxDepth) walk(abs, r, depth + 1);
      } else if (d.isFile()) {
        if (files.length >= MAX_LOOSE_FILES) {
          truncated = true;
          return;
        }
        let st;
        try {
          st = fs.statSync(abs);
        } catch {
          continue;
        }
        files.push({ path: r, size: st.size, sha256: hashFile(abs, st.size) });
      }
    }
  };
  walk(root, "", 0);
  return { files, truncated };
}

// ---------------------------------------------------------------------------
// shadow git (non-git workspace root under `verity run`)
// ---------------------------------------------------------------------------

/** Directories a shadow-git work tree never records (build output, dependency stores, caches). */
export const SHADOW_HEAVY_DIRS = ["node_modules", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", "dist", "build", "target", ".next", ".nuxt", ".turbo", ".cache", ".gradle", "coverage", ".verity"];
/** Shadow-git caps: the loose-file count cap and the diff byte cap, the same numbers the gate already applies. */
export const SHADOW_MAX_FILES = MAX_LOOSE_FILES;
export const SHADOW_MAX_BYTES = MAX_DIFF_BYTES;

/**
 * Create (or reuse) the shadow git dir for `root` and register it. The
 * exclude file holds the heavy directories, the dispatcher artefacts the
 * loose manifest skips, nested repositories (judged on their own) and any
 * extra workspace-relative paths.
 */
export function initShadowGit(root, gitDir, { nested = [], exclude = [] } = {}) {
  const abs = path.resolve(root);
  const dir = path.resolve(gitDir);
  if (!fs.existsSync(path.join(dir, "HEAD"))) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const r = spawnSync("git", ["init", "-q", "--bare", dir], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
    if (r.status !== 0) throw new GateError(`shadow git init failed at ${dir}: ${String(r.stderr || "").trim()}`);
    spawnSync("git", ["--git-dir", dir, "config", "core.bare", "false"], { stdio: "ignore" });
  }
  registerShadowGit(abs, dir);
  const lines = [
    "# Verity shadow git: never recorded",
    ...SHADOW_HEAVY_DIRS.map((d) => `${d}/`),
    ...[...LOOSE_EXCLUDE_NAMES].map((n) => `/${n}`),
    ...nested.filter((n) => n && n !== ".").map((n) => `/${n}/`),
    ...exclude.map((p) => path.relative(abs, path.resolve(abs, p))).filter((p) => p && !p.startsWith("..")).map((p) => `/${p}`),
  ];
  fs.mkdirSync(path.join(dir, "info"), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(dir, "info", "exclude"), lines.join("\n") + "\n", { mode: 0o600 });
  return dir;
}

/** null when the shadow work tree is within the caps, else { reason, files, bytes }. */
export function shadowCaps(root) {
  const raw = gitTry(root, ["ls-files", "--others", "--exclude-standard", "-z"], { maxBuffer: MAX_DIFF_BYTES });
  if (raw === null) return { reason: "untracked_unlisted", files: null, bytes: null };
  const files = raw.split("\0").filter(Boolean);
  if (files.length > SHADOW_MAX_FILES) return { reason: "files_over_cap", files: files.length, bytes: null };
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.lstatSync(path.join(root, f)).size;
    } catch {
      // vanished between listing and stat
    }
    if (bytes > SHADOW_MAX_BYTES) return { reason: "bytes_over_cap", files: files.length, bytes };
  }
  return null;
}

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

/**
 * Pre-task base record for a workspace. Lives OUTSIDE the workspace (the
 * orchestrator keeps it in its own state dir and its sha256 in memory).
 *
 * `shadowGitDir` (verity run): when the root is not a repository, record it
 * through a shadow git dir instead of the loose manifest, so code changes in
 * a non-git workspace are judged like any other. Above the caps the root
 * repo record is `unavailable` with the reason and the verdict will be
 * unverifiable (truncated), never a pass.
 */
export function snapshot({ cwd, maxDepth = DEFAULT_MAX_DEPTH, exclude = [], shadowGitDir = null }) {
  const root = path.resolve(String(cwd || ""));
  if (!cwd || !isDir(root)) throw new UsageError(`snapshot: --cwd is not a directory: ${cwd}`);
  const discovered = discoverRepos(root, maxDepth);
  if (shadowGitDir && !discovered.includes(".")) {
    initShadowGit(root, shadowGitDir, { nested: discovered, exclude });
    const caps = shadowCaps(root);
    const shadowRepo = caps
      ? { path: ".", shadowGitDir: path.resolve(shadowGitDir), unavailable: caps.reason, files: caps.files, bytes: caps.bytes, baseSource: "pre-task" }
      : { path: ".", shadowGitDir: path.resolve(shadowGitDir), baseTree: writeWorkingTree(root), baseSource: "pre-task", head: null, remote: null, exclude: excludeRecord(root) };
    const nestedRepos = discovered.map((rel) => {
      const abs = path.join(root, rel);
      return { path: rel, baseTree: writeWorkingTree(abs), baseSource: "pre-task", head: gitTry(abs, ["rev-parse", "--verify", "-q", "HEAD"]), remote: normalizeRemote(gitTry(abs, ["remote", "get-url", "origin"])), exclude: excludeRecord(abs) };
    });
    return { schema: BASE_SCHEMA, createdAt: new Date().toISOString(), cwd: root, maxDepth, exclude: [...exclude], repos: [shadowRepo, ...nestedRepos], loose: null };
  }
  const repos = discovered.map((rel) => {
    const abs = rel === "." ? root : path.join(root, rel);
    return {
      path: rel,
      baseTree: writeWorkingTree(abs),
      baseSource: "pre-task",
      head: gitTry(abs, ["rev-parse", "--verify", "-q", "HEAD"]),
      remote: normalizeRemote(gitTry(abs, ["remote", "get-url", "origin"])),
      exclude: excludeRecord(abs),
    };
  });
  const rootIsRepo = repos.some((r) => r.path === ".");
  const loose = rootIsRepo ? null : looseManifest(root, { repos: repos.map((r) => r.path), exclude });
  return {
    schema: BASE_SCHEMA,
    createdAt: new Date().toISOString(),
    cwd: root,
    maxDepth,
    exclude: [...exclude],
    repos,
    loose,
  };
}

// ---------------------------------------------------------------------------
// diff → ledger
// ---------------------------------------------------------------------------

function parseNameStatus(buf) {
  const parts = buf.split("\0");
  const entries = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i];
    if (!status) {
      i++;
      continue;
    }
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      entries.push({ status: kind, from: parts[i + 1], path: parts[i + 2] });
      i += 3;
    } else {
      entries.push({ status: kind, path: parts[i + 1] });
      i += 2;
    }
  }
  return entries.filter((e) => e.path !== undefined);
}

function unquoteGitPath(p) {
  let s = String(p);
  if (s.startsWith('"') && s.endsWith('"')) {
    s = s.slice(1, -1).replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))).replace(/\\(.)/g, "$1");
  }
  return s;
}

/** Added lines per path from a unified=0 diff (never persisted; scanned for secrets only). */
function parseAddedLines(text) {
  const out = new Map();
  let current = null;
  let bytes = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).split("\t")[0];
      current = target === "/dev/null" ? null : unquoteGitPath(target).replace(/^b\//, "");
      bytes = 0;
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git ") || line.startsWith("@@") || !current) continue;
    if (line.startsWith("+")) {
      if (bytes > MAX_ADDED_BYTES_PER_FILE) continue;
      const body = line.slice(1);
      bytes += body.length + 1;
      const arr = out.get(current) || [];
      arr.push(body);
      out.set(current, arr);
    }
  }
  return out;
}

export function diffRepo(abs, baseTree, postTree, { timeoutMs } = {}) {
  const t = timeoutMs ? { timeoutMs } : {};
  const ns = gitOk(abs, ["diff", "-M", "--name-status", "-z", baseTree, postTree], { maxBuffer: MAX_DIFF_BYTES, ...t }).stdout;
  const entries = parseNameStatus(ns);
  let added = new Map();
  let truncated = false;
  try {
    const u = gitOk(abs, ["diff", "--unified=0", "--no-color", "--no-ext-diff", "-M", baseTree, postTree], { maxBuffer: MAX_DIFF_BYTES, ...t }).stdout;
    added = parseAddedLines(u);
  } catch (e) {
    if (/maxBuffer|ENOBUFS/.test(String(e && e.message))) truncated = true;
    else throw e;
  }
  const untracked = new Set(
    (gitTry(abs, ["ls-files", "--others", "--exclude-standard", "-z"], t) || "").split("\0").filter(Boolean),
  );
  return { entries, added, untracked, truncated };
}

/** Files in the repo that the base rules left untracked but the current info/exclude ignores (newly hidden). */
function newlyIgnored(abs, baseExcludeContent) {
  if (baseExcludeContent === null || baseExcludeContent === undefined) return [];
  const tmp = path.join(os.tmpdir(), `verity-swarm-exclude-${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`);
  try {
    fs.writeFileSync(tmp, baseExcludeContent, { mode: 0o600 });
    const underBase = new Set((gitTry(abs, ["ls-files", "--others", "--exclude-per-directory=.gitignore", `--exclude-from=${tmp}`, "-z"]) || "").split("\0").filter(Boolean));
    const underNow = new Set((gitTry(abs, ["ls-files", "--others", "--exclude-standard", "-z"]) || "").split("\0").filter(Boolean));
    return [...underBase].filter((p) => !underNow.has(p));
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // best effort
    }
  }
}

function isIgnored(p, globs) {
  const base = p.split("/").pop();
  return globs.some((g) => globMatch(g, p) || globMatch(g, base));
}

/** The npm/bun/yarn/pnpm script a check command runs, if any ("npm test" → "test", "bun run lint" → "lint"). */
function scriptOfCommand(command) {
  const s = stripQuotesAndComments(String(command || ""));
  for (const seg of s.split(/&&|;|\|/)) {
    const toks = seg.trim().split(/\s+/).filter(Boolean);
    while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || toks[0] === "sudo" || toks[0] === "env" || toks[0] === "time")) toks.shift();
    const prog = (toks[0] || "").split("/").pop();
    if (!["npm", "bun", "yarn", "pnpm"].includes(prog)) continue;
    if (toks[1] === "run" || toks[1] === "run-script") return toks[2] || null;
    if (toks[1] === "test" || toks[1] === "start" || toks[1] === "build") return toks[1];
    if (prog === "bun" && toks[1] && !toks[1].startsWith("-") && !/[./]/.test(toks[1])) return toks[1];
  }
  return null;
}

function usesMake(command) {
  return /(^|[\s;&|])make(\s|$)/.test(stripQuotesAndComments(String(command || "")));
}

function readJsonAtTree(abs, tree, file) {
  const raw = gitTry(abs, ["show", `${tree}:${file}`]);
  if (raw === null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined; // present but unparseable
  }
}

/** Paths in the diff that redefine the check itself. */
function checkDefinitionChanges(abs, entries, baseTree, postTree, command) {
  const hits = [];
  const touched = new Set(entries.flatMap((e) => [e.path, e.from].filter(Boolean)));
  for (const p of touched) {
    const base = p.split("/").pop();
    if (base === ".verity.json") hits.push(p);
    else if (MAKEFILE_RE.test(base)) {
      if (usesMake(command)) hits.push(p);
    } else if (CHECK_CONFIG_RE.test(base)) hits.push(p);
  }
  if (touched.has("package.json")) {
    const before = readJsonAtTree(abs, baseTree, "package.json");
    const after = readJsonAtTree(abs, postTree, "package.json");
    const script = scriptOfCommand(command);
    const pick = (pkg) => {
      const scripts = pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
      return script ? JSON.stringify(scripts[script] ?? null) : JSON.stringify(scripts);
    };
    if (before === undefined || after === undefined || pick(before) !== pick(after)) hits.push("package.json");
  }
  return [...new Set(hits)];
}

// ---------------------------------------------------------------------------
// diff rules: the shared core (swarm verify gate and the hook Stop path)
// ---------------------------------------------------------------------------

/**
 * Apply the diff rules to one repo's base→post diff. Pure over its inputs
 * apart from reading package.json at both trees for the definition check.
 *
 *   test_deletion             a test file deleted (D) or renamed out of the tests (R)
 *   secret                    a credential shape on an added line (label + fingerprint, never the value)
 *   check_definition_changed  a path that redefines `command` (only when a command is known)
 *   test_skipped              a skip marker on a line added to a test file (severity info: recorded, never blocking)
 *
 * Returns the findings in that order plus the change ledger (code paths,
 * non-code count, deleted tests, untracked code, definition changes). Paths
 * are shown under `repoPath` ("." = no prefix).
 */
export function diffRules({ repoPath = ".", abs, entries, added, untracked = new Set(), baseTree, postTree, ignoreGlobs = DEFAULT_IGNORE, allowSecrets = false, allowTestDeletion = false, allowCheckEdits = false, command = null }) {
  const findings = [];
  const code = [];
  const deletedTests = [];
  const untrackedCode = [];
  const checkDefinitionChanged = [];
  let nonCodeCount = 0;
  for (const e of entries) {
    const disp = displayPath(repoPath, e.path);
    if (e.status === "D") {
      if (looksLikeTestFile(e.path) && !allowTestDeletion) {
        deletedTests.push(disp);
        findings.push({ rule: "test_deletion", path: disp });
      }
      if (isCodeFile(e.path) && !isIgnored(e.path, ignoreGlobs)) code.push(disp);
      else nonCodeCount++;
      continue;
    }
    if (e.status === "R" && e.from && looksLikeTestFile(e.from) && !looksLikeTestFile(e.path) && !allowTestDeletion) {
      const from = displayPath(repoPath, e.from);
      deletedTests.push(from);
      findings.push({ rule: "test_deletion", path: from, renamedTo: disp });
    }
    if (isCodeFile(e.path) && !isIgnored(e.path, ignoreGlobs)) {
      code.push(disp);
      if (untracked.has(e.path)) untrackedCode.push(disp);
    } else nonCodeCount++;
  }
  if (!allowSecrets) {
    for (const [p, lines] of added) {
      for (const s of findSecrets(lines.join("\n"))) {
        findings.push({ rule: "secret", path: displayPath(repoPath, p), label: s.label, fingerprint: hash16(s.value) });
      }
    }
  }
  if (command) {
    for (const p of checkDefinitionChanges(abs, entries, baseTree, postTree, command)) {
      const disp = displayPath(repoPath, p);
      checkDefinitionChanged.push(disp);
      findings.push({ rule: "check_definition_changed", path: disp, ...(allowCheckEdits ? { allowed: true } : {}) });
    }
  }
  for (const [p, lines] of added) {
    if (!looksLikeTestFile(p)) continue;
    for (const m of findSkipMarkers(lines)) findings.push({ rule: "test_skipped", path: displayPath(repoPath, p), label: m.label, severity: "info" });
  }
  return { findings, code, nonCodeCount, deletedTests, untrackedCode, checkDefinitionChanged };
}

/** Findings that decide a verdict: info-severity findings and allowed definition edits only inform. */
export function blockingFindings(findings) {
  return findings.filter((f) => f.severity !== "info" && !(f.rule === "check_definition_changed" && f.allowed));
}

/**
 * The done rule over one check outcome: code changed, and `check` (the
 * gate-run check, or the hook's last passing check still valid for the
 * current tree) either passed for real or did not. `exitCode` 124 = timed
 * out. Returns decideStop's { decision: allow|block, message, hollowPass }.
 */
export function decideDone({ code, command, exitCode, testFiles = null }) {
  const lines = [{ type: "event", fact: { kind: "edit", files: code, deleted: [], code } }];
  if (command) lines.push({ type: "event", fact: { kind: "command", command, exitCode, verify: true, code: [] } });
  return decideStop(lines, false, false, testFiles);
}

// ---------------------------------------------------------------------------
// check command
// ---------------------------------------------------------------------------

/**
 * Masked forms are usage errors: the trusted command's own exit status must
 * be the result. Rejected: `||`, any `;` (chain with `&&`), a trailing `&`,
 * `--help`/`--version`, and a pipe without `set -o pipefail` earlier in the
 * chain. Each `&&` part of the command is its own trusted prefix, so an
 * arbitrary (non-allowlisted) command is runnable once it passes the
 * masking analysis.
 */
export function assertRunnableCheck(command) {
  const cmd = String(command || "").trim();
  if (!cmd) throw new UsageError("check command is empty");
  const s = stripQuotesAndComments(cmd);
  if (s.includes(";")) throw new UsageError(`trusted check command uses \`;\` — chain with \`&&\` so the check's own exit status is the result: ${cmd}`);
  const parts = s.split("&&").map((p) => stripModifiers(p.trim())).filter((p) => p && !/^(set|cd)(\s|$)/.test(p)).map((p) => (p.includes("|") ? p.split("|")[0].trim() : p));
  if (!isVerify(cmd, parts)) {
    throw new UsageError(`trusted check command is masked or backgrounded (\`||\`, a trailing \`&\`, \`--help\`, or a pipe without \`set -o pipefail &&\`): ${cmd}`);
  }
}

function checkEnv(extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    if (ENV_SECRET_RE.test(k) && k !== "PATH") continue;
    env[k] = v;
  }
  return { ...env, CI: "1", FORCE_COLOR: "0", NO_COLOR: "1", VERITY_SWARM_CHECK: "1", ...extra };
}

/** Run the trusted check as a child: own process group, timeout, secrets stripped from env. */
export function runCheck({ command, cwd, timeoutS = DEFAULT_CHECK_TIMEOUT_S, logPath = null }) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const chunks = [];
    let bytes = 0;
    let timedOut = false;
    let settled = false;
    const push = (buf) => {
      bytes += buf.length;
      chunks.push(buf);
      // keep the tail only
      let total = chunks.reduce((n, c) => n + c.length, 0);
      while (total > MAX_CHECK_OUTPUT_BYTES && chunks.length > 1) total -= chunks.shift().length;
    };
    let child;
    try {
      child = spawn("bash", ["-o", "pipefail", "-c", command], { cwd, env: checkEnv(), stdio: ["ignore", "pipe", "pipe"], detached: true });
    } catch (e) {
      resolve({ exitCode: null, timedOut: false, durationMs: 0, output: Buffer.alloc(0), outputBytes: 0, spawnError: String(e && e.message) });
      return;
    }
    const killGroup = (sig) => {
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          // gone
        }
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup("SIGTERM");
      setTimeout(() => killGroup("SIGKILL"), 5000).unref();
    }, Math.max(1, timeoutS) * 1000);
    child.stdout.on("data", push);
    child.stderr.on("data", push);
    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const output = Buffer.concat(chunks);
      if (logPath) {
        try {
          fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
          fs.writeFileSync(logPath, output, { mode: 0o600 });
        } catch {
          // the verdict still carries the hash
        }
      }
      resolve({ exitCode: code, timedOut, durationMs: Date.now() - t0, output, outputBytes: bytes, ...(spawnError ? { spawnError } : {}) });
    };
    child.on("error", (e) => finish(null, String(e && e.message)));
    child.on("close", (code, sig) => finish(code === null ? (timedOut ? 124 : null) : code, sig && !timedOut ? `terminated by ${sig}` : undefined));
  });
}

// ---------------------------------------------------------------------------
// policy / check provenance
// ---------------------------------------------------------------------------

function loadJson(p) {
  if (!p) return null;
  const obj = typeof p === "object" ? p : JSON.parse(fs.readFileSync(p, "utf8"));
  return obj && typeof obj === "object" ? obj : null;
}

function normalizeCheckSpec(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s) return null;
    if (s.toLowerCase() === "none") return { waived: true };
    return { command: s };
  }
  if (typeof v === "object") {
    if (v.waived === true || String(v.command || "").trim().toLowerCase() === "none") return { waived: true };
    const command = String(v.command || "").trim();
    if (!command) return null;
    const out = { command };
    if (v.cwd !== undefined && v.cwd !== null) out.cwd = String(v.cwd);
    if (Number.isFinite(Number(v.timeoutS)) && Number(v.timeoutS) > 0) out.timeoutS = Number(v.timeoutS);
    for (const k of ["allowTestDeletion", "allowCheckEdits", "allowSecrets"]) if (v[k] === true) out[k] = true;
    if (Array.isArray(v.ignore)) out.ignore = v.ignore.filter((x) => typeof x === "string");
    return out;
  }
  return null;
}

/**
 * Resolve the check and its allowances. Highest source wins:
 *   1. the explicit --check (the dispatcher-written task field), or --waived
 *   2. the operator policy file: repos[<normalized remote>].check
 *   3. .verity.json at the BASE revision (field `check`; the working-tree copy
 *      and ~/.verity/trusted.json are ignored because the executor can write both)
 *   4. none → unverifiable
 * Policy and base `.verity.json` `ignore` globs are collected regardless.
 */
export function resolveCheckConfig({ explicit, explicitSource = "task", waived = false, policy, repos }) {
  const ignore = [];
  const allow = {};
  let check = null;
  let source = "none";
  const pol = policy || null;
  if (pol && Array.isArray(pol.ignore)) ignore.push(...pol.ignore.filter((x) => typeof x === "string"));
  // Repo-specific policy entry and base .verity.json for every repo (ignore globs union; the first check wins).
  let policyCheck = null;
  let baseCheck = null;
  for (const r of repos) {
    const entry = pol && pol.repos && typeof pol.repos === "object" && r.remote ? pol.repos[r.remote] : null;
    if (entry && typeof entry === "object") {
      if (Array.isArray(entry.ignore)) ignore.push(...entry.ignore.filter((x) => typeof x === "string"));
      if (entry.allowSecrets === true) allow.secrets = { source: "policy", repo: r.path };
      if (entry.allowTestDeletion === true) allow.testDeletion = { source: "policy", repo: r.path };
      if (entry.allowCheckEdits === true) allow.checkEdits = { source: "policy", repo: r.path };
      const c = normalizeCheckSpec(entry.check ?? entry);
      if (c && c.command && !policyCheck) policyCheck = { ...c, repo: r.path, cwd: c.cwd ?? r.path };
    }
    if (r.baseTree && r.baseTree !== EMPTY_TREE) {
      const cfg = readJsonAtTree(r.abs, r.baseTree, ".verity.json");
      if (cfg && typeof cfg === "object") {
        if (Array.isArray(cfg.ignore)) ignore.push(...cfg.ignore.filter((x) => typeof x === "string"));
        if (Array.isArray(cfg.allow) && cfg.allow.includes("secrets") && !allow.secrets) allow.secrets = { source: "verity-json-base", repo: r.path };
        const c = normalizeCheckSpec(cfg.check);
        if (c && c.command && !baseCheck) baseCheck = { ...c, repo: r.path, cwd: c.cwd ? path.posix.join(r.path, c.cwd) : r.path };
      }
    }
  }
  if (waived) {
    check = { waived: true };
    source = explicitSource;
  } else if (explicit) {
    const c = normalizeCheckSpec(explicit);
    if (c && c.waived) {
      check = c;
      source = explicitSource;
    } else if (c) {
      check = c;
      source = explicitSource;
    }
  }
  if (!check && policyCheck) {
    check = policyCheck;
    source = "policy";
  }
  if (!check && baseCheck) {
    check = baseCheck;
    source = "verity-json-base";
  }
  return { check, source, ignore: [...new Set(ignore)], allow };
}

// ---------------------------------------------------------------------------
// verify
// ---------------------------------------------------------------------------

function displayPath(repoRel, p) {
  return repoRel === "." ? p : `${repoRel}/${p}`;
}

/**
 * Judge the workspace against its base. Resolves with the verdict object
 * (decision pass | fail | unverifiable); throws GateError / UsageError.
 */
export async function verify(opts) {
  const t0 = Date.now();
  const root = path.resolve(String(opts.cwd || ""));
  if (!opts.cwd || !isDir(root)) throw new UsageError(`verify: --cwd is not a directory: ${opts.cwd}`);
  const base = loadJson(opts.base);
  if (!base || base.schema !== BASE_SCHEMA || !Array.isArray(base.repos)) throw new UsageError(`verify: --base is not a ${BASE_SCHEMA} record`);
  if (path.resolve(String(base.cwd)) !== root) throw new UsageError(`verify: base was taken for ${base.cwd}, not ${root}`);
  const maxDepth = Number.isFinite(Number(opts.maxDepth)) ? Number(opts.maxDepth) : base.maxDepth ?? DEFAULT_MAX_DEPTH;
  const exclude = [...(base.exclude || []), ...(opts.exclude || [])];
  let policy = null;
  try {
    policy = loadJson(opts.policy);
  } catch (e) {
    throw new GateError(`verify: policy file unreadable: ${e && e.message}`);
  }

  // 1. repos: union of the base's and today's.
  const nowRels = discoverRepos(root, maxDepth);
  const baseByPath = new Map(base.repos.map((r) => [r.path, r]));
  const repos = [];
  const findings = [];
  for (const rel of [...new Set([...base.repos.map((r) => r.path), ...nowRels])]) {
    const abs = rel === "." ? root : path.join(root, rel);
    const b = baseByPath.get(rel);
    if (b && b.shadowGitDir) {
      // Shadow-git root (verity run, non-git workspace): judged through its own git dir.
      registerShadowGit(abs, b.shadowGitDir);
      if (b.unavailable) {
        repos.push({ path: rel, abs, baseSource: b.baseSource, shadow: true, unavailable: b.unavailable, files: b.files ?? null, bytes: b.bytes ?? null });
        continue;
      }
      if (!fs.existsSync(path.join(b.shadowGitDir, "HEAD")) || !treeExists(abs, b.baseTree)) throw new GateError(`verify: base tree ${b.baseTree} for the shadow-git workspace is missing (the shadow store at ${b.shadowGitDir} was pruned or replaced)`);
      repos.push({ path: rel, abs, baseTree: b.baseTree, baseSource: b.baseSource, shadow: true, remote: null, baseExclude: b.exclude || null });
      continue;
    }
    const exists = nowRels.includes(rel);
    if (b && !exists) {
      findings.push({ rule: "repo_removed", path: rel });
      repos.push({ path: rel, abs, baseTree: b.baseTree, baseSource: b.baseSource, removed: true, remote: b.remote ?? null });
      continue;
    }
    if (b) {
      if (!treeExists(abs, b.baseTree)) throw new GateError(`verify: base tree ${b.baseTree} for ${rel} is missing from the repository (pruned or replaced)`);
      repos.push({ path: rel, abs, baseTree: b.baseTree, baseSource: b.baseSource, remote: normalizeRemote(gitTry(abs, ["remote", "get-url", "origin"])) ?? b.remote ?? null, baseExclude: b.exclude || null });
    } else {
      const ab = appearedRepoBase(abs);
      repos.push({ path: rel, abs, baseTree: ab.tree, baseSource: ab.source, baseRef: ab.ref ?? null, remote: normalizeRemote(gitTry(abs, ["remote", "get-url", "origin"])), appeared: true });
    }
  }

  // 2. check provenance (also yields the ignore globs and allowances).
  const resolved = resolveCheckConfig({ explicit: opts.check, explicitSource: opts.checkSource || "task", waived: opts.waived === true, policy, repos: repos.filter((r) => !r.removed) });
  const ignoreGlobs = [...new Set([...DEFAULT_IGNORE, ...resolved.ignore, ...(opts.ignore || [])])];
  const allowSecrets = opts.allowSecrets === true || !!resolved.allow.secrets || !!(resolved.check && resolved.check.allowSecrets);
  const allowTestDeletion = opts.allowTestDeletion === true || !!resolved.allow.testDeletion || !!(resolved.check && resolved.check.allowTestDeletion);
  const allowCheckEdits = opts.allowCheckEdits === true || !!resolved.allow.checkEdits || !!(resolved.check && resolved.check.allowCheckEdits);
  const command = resolved.check && resolved.check.command ? resolved.check.command : null;
  if (command) assertRunnableCheck(command);

  // 3. diff every repo → ledger.
  const code = [];
  const deletedTests = [];
  const untrackedCode = [];
  const checkDefinitionChanged = [];
  let nonCodeCount = 0;
  let truncated = false;
  let excludeChanged = false;
  const codeRepos = new Set();
  let shadowTruncated = null;
  for (const r of repos) {
    if (r.removed) continue;
    if (r.shadow) {
      const caps = r.unavailable ? { reason: r.unavailable, files: r.files, bytes: r.bytes, atBase: true } : shadowCaps(r.abs);
      if (caps) {
        shadowTruncated = caps;
        truncated = true;
        continue;
      }
    }
    r.postTree = writeWorkingTree(r.abs);
    // info/exclude edited during the run: files it newly hides are reported (info) even when the trees match.
    if (r.baseExclude && r.baseExclude.sha256 !== excludeRecord(r.abs).sha256) {
      excludeChanged = true;
      for (const p of newlyIgnored(r.abs, r.baseExclude.content)) {
        if (isCodeFile(p) && !isIgnored(p, ignoreGlobs)) findings.push({ rule: "ignored_new_code", path: displayPath(r.path, p), severity: "info" });
      }
    }
    if (r.postTree === r.baseTree) continue;
    const d = diffRepo(r.abs, r.baseTree, r.postTree);
    if (r.shadow) {
      // Nested repositories are judged on their own; their gitlinks in the shadow tree are not changes.
      const nested = repos.filter((x) => x !== r).map((x) => x.path).concat(nowRels.filter((x) => x !== "."));
      const inNested = (p) => nested.some((n) => p === n || p.startsWith(n + "/"));
      d.entries = d.entries.filter((e) => !inNested(e.path));
      for (const p of [...d.added.keys()]) if (inNested(p)) d.added.delete(p);
    }
    if (d.truncated) truncated = true;
    const dr = diffRules({ repoPath: r.path, abs: r.abs, entries: d.entries, added: d.added, untracked: d.untracked, baseTree: r.baseTree, postTree: r.postTree, ignoreGlobs, allowSecrets, allowTestDeletion, allowCheckEdits, command });
    findings.push(...dr.findings);
    code.push(...dr.code);
    if (dr.code.length) codeRepos.add(r.path);
    deletedTests.push(...dr.deletedTests);
    untrackedCode.push(...dr.untrackedCode);
    checkDefinitionChanged.push(...dr.checkDefinitionChanged);
    nonCodeCount += dr.nonCodeCount;
  }

  // 4. loose files (non-git workspace root): secrets only, never code.
  let loose = null;
  if (base.loose && Array.isArray(base.loose.files)) {
    const before = new Map(base.loose.files.map((f) => [f.path, f]));
    const now = looseManifest(root, { repos: nowRels, exclude });
    let changed = 0;
    let scanned = 0;
    for (const f of now.files) {
      const b = before.get(f.path);
      if (b && b.sha256 === f.sha256 && b.size === f.size) continue;
      changed++;
      if (allowSecrets || f.size > MAX_LOOSE_SCAN_BYTES) continue;
      let buf;
      try {
        buf = fs.readFileSync(path.join(root, f.path));
      } catch {
        continue;
      }
      if (buf.subarray(0, 8192).includes(0)) continue; // binary
      scanned++;
      for (const s of findSecrets(buf.toString("utf8"))) findings.push({ rule: "secret", path: f.path, label: s.label, fingerprint: hash16(s.value), loose: true });
    }
    loose = { files: now.files.length, changed, scanned, truncated: now.truncated || base.loose.truncated === true };
  }

  // 5. decide.
  const blocking = blockingFindings(findings);
  const messages = [];
  for (const f of blocking) {
    if (f.rule === "secret") messages.push(`Verity: ${f.path} would contain what looks like ${f.label}. Read the value from the environment or a git-ignored env file instead of writing it into the file.`);
    else if (f.rule === "test_deletion") messages.push(`Verity: ${f.path} was removed from the tests${f.renamedTo ? ` (moved to ${f.renamedTo})` : ""}. Tests are only removed or skipped when the user asked for it. Fix the code the test covers instead.`);
    else if (f.rule === "check_definition_changed") messages.push(`Verity: ${f.path} redefines the trusted check (\`${command}\`) in the same change it is meant to verify, so the check cannot vouch for this change. Leave the check's definition alone, or have the dispatcher record allowCheckEdits.`);
    else if (f.rule === "repo_removed") messages.push(`Verity: the repository at ${f.path} that existed before the task is gone.`);
  }
  const uniqMessages = [...new Set(messages)];

  let decision;
  let check = null;
  let waived = false;
  const checkCwdRel = (() => {
    const explicitCwd = opts.checkCwd ?? (resolved.check && resolved.check.cwd);
    if (explicitCwd) return explicitCwd;
    const candidates = codeRepos.size === 1 ? [...codeRepos] : repos.filter((r) => !r.removed).map((r) => r.path);
    return candidates.length === 1 ? candidates[0] : ".";
  })();
  const checkCwdAbs = path.resolve(root, checkCwdRel);
  if (!(checkCwdAbs === root || checkCwdAbs.startsWith(root + path.sep))) throw new UsageError(`verify: check cwd ${checkCwdRel} is outside the workspace`);

  if (blocking.length > 0) {
    decision = "fail";
    if (command) check = { command, source: resolved.source, cwd: checkCwdRel, skipped: "blocking_findings" };
  } else if (shadowTruncated) {
    decision = "unverifiable";
    const t = shadowTruncated;
    const size = t.reason === "files_over_cap" ? `${t.files} files, cap ${SHADOW_MAX_FILES}` : t.reason === "bytes_over_cap" ? `over ${SHADOW_MAX_BYTES} bytes across ${t.files} files` : "the file list could not be read";
    uniqMessages.push(`Verity: the workspace is above the shadow-git caps ${t.atBase ? "at the base" : "now"} (${size}), so the diff was truncated and the change is unverifiable, not passed.`);
    check = { command: null, source: resolved.source, skipped: "truncated" };
  } else if (code.length === 0) {
    decision = "pass";
    uniqMessages.push(`Verity: no code changed (${nonCodeCount} non-code change${nonCodeCount === 1 ? "" : "s"}); no check required.`);
  } else if (resolved.check && resolved.check.waived) {
    decision = "unverifiable";
    waived = true;
    uniqMessages.push(`Verity: ${code.join(", ")} changed with no trusted check; the dispatcher recorded an explicit waiver (verify: none).`);
    check = { command: null, source: resolved.source, waived: true };
  } else if (command) {
    const timeoutS = Number(opts.checkTimeoutS) > 0 ? Number(opts.checkTimeoutS) : (resolved.check && resolved.check.timeoutS) || DEFAULT_CHECK_TIMEOUT_S;
    if (!isDir(checkCwdAbs)) throw new UsageError(`verify: check cwd does not exist: ${checkCwdRel}`);
    const run = await runCheck({ command, cwd: checkCwdAbs, timeoutS, logPath: opts.checkLog || null });
    const testFiles = repoHasTestFiles(checkCwdAbs);
    const exitCode = run.exitCode;
    const d = decideDone({ code, command, exitCode: run.timedOut ? 124 : exitCode, testFiles });
    check = {
      command, source: resolved.source, cwd: checkCwdRel, exitCode: run.timedOut ? 124 : exitCode, timedOut: run.timedOut,
      durationMs: run.durationMs, outputSha256: sha256(run.output), outputBytes: run.outputBytes, hollow: d.hollowPass === true,
      timeoutS, ...(run.spawnError ? { spawnError: run.spawnError } : {}), ...(opts.checkLog ? { log: opts.checkLog } : {}),
    };
    if (run.spawnError && exitCode === null) throw new GateError(`verify: the check could not be started: ${run.spawnError}`);
    if (d.decision === "allow") {
      decision = "pass";
      uniqMessages.push(`Verity: ${code.length} code change${code.length === 1 ? "" : "s"} verified by \`${command}\` (exit 0, ${Math.round(run.durationMs / 1000)}s).`);
    } else {
      decision = "fail";
      findings.push({ rule: "no_passing_check", detail: run.timedOut ? `timed out after ${timeoutS}s` : d.hollowPass ? "hollow pass (no test files)" : `exit ${exitCode}` });
      uniqMessages.push(d.message);
    }
  } else if (opts.requireCheck) {
    decision = "fail";
    findings.push({ rule: "no_passing_check", detail: "no trusted check configured" });
    uniqMessages.push(`Verity: ${code.join(", ")} changed, but no trusted check is configured for this workspace (task verify field, operator policy, or .verity.json \`check\` at the base revision), and the gate requires one. Have the dispatcher set \`verify:\` (or record \`verify: none\` as a waiver).`);
    check = { command: null, source: "none" };
  } else {
    decision = "unverifiable";
    uniqMessages.push(`Verity: ${code.join(", ")} changed, but no trusted check is configured, so the change is unverifiable.`);
    check = { command: null, source: "none" };
  }

  return {
    schema: VERDICT_SCHEMA,
    decision,
    ...(waived ? { waived: true } : {}),
    cwd: root,
    base: {
      repos: repos.map((r) => ({ path: r.path, baseTree: r.baseTree, baseSource: r.baseSource, ...(r.baseRef ? { baseRef: r.baseRef } : {}), ...(r.postTree ? { postTree: r.postTree } : {}), ...(r.remote ? { remote: r.remote } : {}), ...(r.removed ? { removed: true } : {}), ...(r.appeared ? { appeared: true } : {}), ...(r.shadow ? { shadowGit: true } : {}), ...(r.unavailable ? { unavailable: r.unavailable } : {}) })),
      loose: loose ? { files: loose.files, changed: loose.changed, scanned: loose.scanned } : null,
    },
    changes: { code, nonCodeCount, deletedTests, untrackedCode, checkDefinitionChanged: checkDefinitionChanged.length > 0, excludeChanged, truncated: truncated || (loose ? loose.truncated : false), ...(shadowTruncated ? { truncatedReason: shadowTruncated.reason } : {}) },
    findings,
    check,
    allow: { secrets: allowSecrets, testDeletion: allowTestDeletion, checkEdits: allowCheckEdits },
    ignore: ignoreGlobs,
    message: uniqMessages.join(" "),
    durationMs: Date.now() - t0,
  };
}

export function exitCodeFor(decision) {
  if (decision === "pass") return EXIT.PASS;
  if (decision === "fail") return EXIT.FAIL;
  if (decision === "unverifiable") return EXIT.UNVERIFIABLE;
  return EXIT.INTERNAL;
}

/** sha256 over the engine's own sources (recorded on every verdict). */
export function engineFingerprint(dir = path.dirname(new URL(import.meta.url).pathname)) {
  const h = createHash("sha256");
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".js")).sort()) {
    h.update(f).update("\0").update(fs.readFileSync(path.join(dir, f))).update("\0");
  }
  return h.digest("hex");
}
