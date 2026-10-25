// Verity hybrid Phase 2: `verity run` (the supervising wrapper), `verity gate`
// (the read-only checkpoint) and `verity feedback` (the relaunch block).
//
// run      snapshot → spawn → verify → feedback → record. No second rules
//          engine: the base is swarm.js `snapshot`, the verdict is swarm.js
//          `verify` (the shared diff core from Phase 1), the feedback is
//          feedback.js, the record is record.js.
//            - the base lands in <verity-home>/runs/<run-id>/base.json, outside
//              the workspace; its sha256 is held in this process's memory and
//              re-checked before verify (the orchestrator's snapshot contract);
//            - the child inherits stdio (TUIs keep working), receives every
//              INT/TERM/HUP/QUIT the wrapper gets, and runs with VERITY_RUN_ID
//              and the git guard (GIT_CONFIG_COUNT/KEY/VALUE → core.hooksPath =
//              the run's Verity-owned hooks dir, which chains to the repo's own);
//            - a non-git workspace is recorded through a shadow git dir at
//              <verity-home>/shadow-git/<sha256(root)[:16]>, pruned when the
//              last run on that root completes;
//            - a second live run on the same root marks the tree shared: both
//              record attribution "shared" and any live posture drops to shadow.
// gate     verify the tree now against an active run's base (VERITY_RUN_ID, a
//          live run lock on this root, or --run) or a named --base. It takes
//          NO allowance input: every allowance, waiver, ignore, policy and
//          check flag verify accepts is a usage error here (kill criterion K7).
//          Check and allowances come from the trusted project config only.
// feedback render the relaunch block for a verdict file.
//
// Posture: engine/mode.js resolveMode, the hooks' resolver. Phase 2 ships
// shadow-only: a resolved `live` is honoured only when the Verity config also
// carries `run.promoted: true` (the Phase 3 switch, set nowhere by this
// phase), and is recorded as downgraded "not_promoted" otherwise.
//
// Exit codes (no new ones):
//   gate / verify               0 pass, 1 fail, 2 unverifiable, 64 usage, 70 internal
//   run, live                   the gate's code for the final verdict (a non-zero child
//                               exit with a passing workspace is 0; the child's code is
//                               recorded in the verdict)
//   run, shadow                 the child's own exit code
//   run, INT/TERM to wrapper    verify and record, never relaunch, 128 + signal number
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { EXIT, GateError, UsageError, DEFAULT_CHECK_TIMEOUT_S, engineFingerprint, exitCodeFor, gitTry, snapshot, verify } from "./swarm.js";
import { loadTrustedConfig } from "./config.js";
import { resolveHome } from "./home.js";
import { readModeConfig, resolveMode } from "./mode.js";
import { appendCliVerdict, verityHome } from "./record.js";
import { renderFeedback, renderRelaunchBlock } from "./feedback.js";

export const RUN_SCHEMA = "verity.run/1";
export const DEFAULT_RELAUNCH_BUDGET = 1;
const CLI = path.join(path.dirname(new URL(import.meta.url).pathname), "cli.js");

/**
 * Flags `verify` accepts that hand the gate an allowance, a waiver, a check or
 * a narrower view of the tree. `gate` and `run` reject every one (K7).
 */
export const ALLOWANCE_FLAGS = ["--check", "--check-source", "--check-cwd", "--check-timeout", "--check-log", "--waived", "--allow-test-deletion", "--allow-secrets", "--allow-check-edits", "--ignore", "--exclude", "--policy", "--require-check", "--max-depth"];

/**
 * Relaunch presets: shipped only where the resume invocation was verified
 * against the installed harness (its --help documents resume-by-session-id and
 * a one-shot prompt in the same invocation). {session} and {feedbackFile} are
 * replaced shell-quoted. Gemini has none: its --resume takes "latest" or an
 * index, not a session id.
 */
export const RELAUNCH_PRESETS = {
  claude: { template: 'claude -p --resume {session} "$(cat {feedbackFile})"', verifiedAgainst: "claude 2.1.306 (Claude Code): -r/--resume <session-id>, -p/--print" },
  codex: { template: "codex exec resume {session} - < {feedbackFile}", verifiedAgainst: "codex-cli 0.160.0: `codex exec resume [SESSION_ID] [PROMPT]`, `-` reads the prompt from stdin" },
  kimi: { template: 'kimi -S {session} -p "$(cat {feedbackFile})"', verifiedAgainst: "kimi 0.43.1: -S/--session <id>, -p/--prompt" },
  opencode: { template: 'opencode run --session {session} "$(cat {feedbackFile})"', verifiedAgainst: "opencode 1.18.31: `opencode run [message..]` with -s/--session" },
  pi: { template: 'pi --session {session} -p "$(cat {feedbackFile})"', verifiedAgainst: "pi 0.85.1: --session <path|id>, --print/-p" },
  hermes: { template: "hermes chat --resume {session} --query-file {feedbackFile} --oneshot", verifiedAgainst: "Hermes Agent v0.22.2: `hermes chat --resume SESSION_ID --query-file PATH --oneshot`" },
};
export const HARNESSES_WITHOUT_PRESET = ["gemini"];

/** Client-side hook names the guard dir answers for; each chains to the repo's own hook of that name. */
export const GUARD_HOOKS = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-push", "reference-transaction", "pre-auto-gc", "post-rewrite", "sendemail-validate", "post-index-change", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit"];

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sha256File(p) {
  try {
    return createHash("sha256").update(fs.readFileSync(p)).digest("hex");
  } catch {
    return null;
  }
}

export function rootKey(root) {
  return createHash("sha256").update(path.resolve(root)).digest("hex").slice(0, 16);
}

function newRunId() {
  const t = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  return `r-${t}-${randomBytes(3).toString("hex")}`;
}

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", { mode: 0o600 });
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function say(msg) {
  process.stderr.write(`verity run: ${msg}\n`);
}

/** The workspace a run or gate judges: the enclosing repository's top level, else the directory itself. */
export function workspaceRoot(cwd) {
  const abs = path.resolve(cwd);
  const top = gitTry(abs, ["rev-parse", "--show-toplevel"]);
  return top ? path.resolve(top) : abs;
}

export function runsDir(env = process.env) {
  return path.join(verityHome(env), "runs");
}

function locksDir(root, env = process.env) {
  return path.join(verityHome(env), "locks", rootKey(root));
}

export function shadowGitDir(root, env = process.env) {
  return path.join(verityHome(env), "shadow-git", rootKey(root));
}

/** Live run locks on this root, other than `exceptRunId`; dead ones are removed. */
export function liveLocks(root, exceptRunId = null, env = process.env) {
  const dir = locksDir(root, env);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => n.endsWith(".lock"));
  } catch {
    return [];
  }
  const out = [];
  for (const n of names) {
    const lock = readJson(path.join(dir, n));
    if (!lock || !alive(lock.pid)) {
      try {
        fs.rmSync(path.join(dir, n), { force: true });
      } catch {
        // someone else's
      }
      continue;
    }
    if (lock.runId !== exceptRunId) out.push(lock);
  }
  return out.sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
}

/** The run config block of the Verity config (the same file the mode resolver reads). */
export function runConfig(env = process.env) {
  const { cfg } = readModeConfig(env);
  const r = cfg && typeof cfg === "object" && cfg.run && typeof cfg.run === "object" ? cfg.run : {};
  const budget = Number.isInteger(r.relaunchBudget) && r.relaunchBudget >= 0 ? r.relaunchBudget : DEFAULT_RELAUNCH_BUDGET;
  return { promoted: r.promoted === true, relaunch: r.relaunch && typeof r.relaunch === "object" ? r.relaunch : {}, relaunchBudget: budget };
}

/** Effective posture for a harness: the shared resolver, then the Phase 2 promotion rule. */
export function runPosture(harness, env = process.env) {
  const p = resolveMode(harness, env);
  const rc = runConfig(env);
  const requested = p.mode === "live" ? "live" : "shadow";
  if (requested === "live" && !rc.promoted) return { mode: "shadow", requestedMode: "live", downgraded: "not_promoted", source: p.source.mode, disabled: p.disabled };
  return { mode: requested, source: p.source.mode, disabled: p.disabled };
}

/** The trusted project config's check and allowances (null fields when absent or untrusted). */
export function trustedRunConfig(root) {
  const t = loadTrustedConfig(resolveHome(), root);
  if (!t) return { file: null, check: undefined, allowSecrets: false, ignore: [] };
  const cfg = t.cfg;
  return {
    file: t.file,
    check: cfg.check === undefined || cfg.check === null ? undefined : cfg.check,
    allowSecrets: Array.isArray(cfg.allow) && cfg.allow.includes("secrets"),
    ignore: Array.isArray(cfg.ignore) ? cfg.ignore.filter((x) => typeof x === "string") : [],
  };
}

/** Verify `root` against a base record whose sha256 must still be `baseSha`. Returns a verdict; never throws. */
export async function verifyAgainst({ root, basePath, baseSha, trusted, checkLog }) {
  const t0 = Date.now();
  const errorVerdict = (message, code = EXIT.INTERNAL) => ({ schema: "verity.swarm.verdict/1", decision: "error", errorKind: code === EXIT.USAGE ? "usage" : "internal", exitCode: code, message: `Verity: the gate could not answer: ${message}`, error: message, findings: [], durationMs: Date.now() - t0 });
  if (baseSha && sha256File(basePath) !== baseSha) return errorVerdict(`base record tampered or missing (${basePath})`);
  try {
    const opts = { cwd: root, base: basePath, checkLog, allowSecrets: trusted.allowSecrets === true, ignore: trusted.ignore || [] };
    if (trusted.check !== undefined) {
      opts.check = trusted.check;
      opts.checkSource = "verity-json-trusted";
      if (trusted.check && typeof trusted.check === "object" && Number(trusted.check.timeoutS) > 0) opts.checkTimeoutS = Number(trusted.check.timeoutS);
    }
    opts.checkTimeoutS = opts.checkTimeoutS ?? DEFAULT_CHECK_TIMEOUT_S;
    const v = await verify(opts);
    v.engine = engineFingerprint();
    return v;
  } catch (e) {
    return errorVerdict(String(e && e.message ? e.message : e).slice(0, 1000), e instanceof GateError ? e.code : EXIT.INTERNAL);
  }
}

// ---------------------------------------------------------------------------
// git guard
// ---------------------------------------------------------------------------

/** The dispatcher every guard hook name runs (one copy per name; the name is $0's basename). */
export function guardScript() {
  return `#!/usr/bin/env bash
# Verity git guard for one \`verity run\` session (generated by engine/run.js).
# Chains to the repository's own hook of the same name, resolved exactly as git
# would without the session's core.hooksPath entry (husky and kin included),
# so the repo's hooks still run, in their order, with their exit status. For
# pre-push it then records Verity's push check (engine/cli.js prepush).
hook="\${0##*/}"
guard="$(cd "\${0%/*}" && pwd -P)"
orig="\${VERITY_GUARD_ORIG_COUNT:-0}"
if [ "$orig" = 0 ]; then
  repo_hooks="$(env -u GIT_CONFIG_COUNT git rev-parse --git-path hooks 2>/dev/null)"
else
  repo_hooks="$(GIT_CONFIG_COUNT="$orig" git rev-parse --git-path hooks 2>/dev/null)"
fi
chain=none
target=""
if [ -z "$repo_hooks" ]; then
  chain="unverifiable:hooks_path_unresolved"
else
  case "$repo_hooks" in /*) ;; *) repo_hooks="$PWD/$repo_hooks" ;; esac
  real="$(cd "$repo_hooks" 2>/dev/null && pwd -P)"
  if [ -n "$real" ] && [ "$real" = "$guard" ]; then
    chain="unverifiable:hooks_path_is_the_guard"
  elif [ -f "$repo_hooks/$hook" ] && [ -x "$repo_hooks/$hook" ]; then
    chain=chained
    target="$repo_hooks/$hook"
  elif [ -e "$repo_hooks/$hook" ]; then
    chain=ignored_not_executable
    echo "hint: The '$repo_hooks/$hook' hook was ignored because it's not set as executable." >&2
  fi
fi
if [ "$hook" != pre-push ]; then
  [ -n "$target" ] && exec "$target" "$@"
  case "$chain" in unverifiable*) echo "verity: the repository's own $hook hook could not be chained ($chain)" >&2 ;; esac
  exit 0
fi
stdin_file="$(mktemp)"
trap 'rm -f "$stdin_file"' EXIT
cat > "$stdin_file"
rc=0
if [ -n "$target" ]; then
  "$target" "$@" < "$stdin_file"
  rc=$?
fi
${shq(process.execPath)} ${shq(CLI)} prepush --remote "\${1:-}" --url "\${2:-}" --stdin-file "$stdin_file" --chain "$chain" --repo-hook-exit "$rc" < /dev/null
v=$?
# Verity can only add a refusal (live posture, never in Phase 2); a repo hook failure stands as it would unwrapped.
if [ "$rc" = 0 ] && [ "$v" = 1 ]; then exit 1; fi
exit "$rc"
`;
}

/** Write the guard dir for a run. */
export function installGuard(hooksDir) {
  mkdirp(hooksDir);
  const body = guardScript();
  for (const h of GUARD_HOOKS) fs.writeFileSync(path.join(hooksDir, h), body, { mode: 0o700 });
  return hooksDir;
}

/** The child's git config environment: the parent's entries kept, core.hooksPath appended last (wins). */
export function guardEnv(hooksDir, env = process.env) {
  const n = Number(env.GIT_CONFIG_COUNT);
  const orig = Number.isInteger(n) && n > 0 ? n : 0;
  return { GIT_CONFIG_COUNT: String(orig + 1), [`GIT_CONFIG_KEY_${orig}`]: "core.hooksPath", [`GIT_CONFIG_VALUE_${orig}`]: hooksDir, VERITY_GUARD_ORIG_COUNT: String(orig) };
}

// ---------------------------------------------------------------------------
// relaunch
// ---------------------------------------------------------------------------

export function relaunchTemplate(harness, env = process.env) {
  const rc = runConfig(env);
  const op = rc.relaunch[harness];
  if (typeof op === "string" && op.trim()) return { template: op, source: "config" };
  if (op && typeof op === "object" && typeof op.template === "string") return { template: op.template, source: "config" };
  const p = RELAUNCH_PRESETS[harness];
  return p ? { template: p.template, source: "preset" } : null;
}

export function renderTemplate(template, { feedbackFile, session }) {
  return String(template)
    .replace(/\{feedbackFile\}/g, shq(feedbackFile))
    .replace(/\{session\}/g, session ? shq(session) : "<session-id>");
}

function inferHarness(cmd) {
  const b = path.basename(String(cmd || ""));
  return ["claude", "codex", "gemini", "kimi", "opencode", "pi", "hermes"].includes(b) ? b : "cli";
}

// ---------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------

function flagName(a) {
  return a.startsWith("--") && a.includes("=") ? a.slice(0, a.indexOf("=")) : a;
}

function rejectAllowance(sub, a) {
  if (ALLOWANCE_FLAGS.includes(flagName(a))) {
    throw new UsageError(`${sub} takes no allowance, waiver or check input (${flagName(a)}): checks and allowances come from the trusted project config (.verity.json bound with \`verity trust\`) only`);
  }
}

export function parseRunArgs(args) {
  const o = { harness: null, session: null, tui: null, command: [] };
  let i = 0;
  const need = (flag) => {
    if (i + 1 >= args.length) throw new UsageError(`${flag} needs a value`);
    return args[++i];
  };
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      i++;
      break;
    }
    if (!a.startsWith("-")) break;
    rejectAllowance("run", a);
    if (a === "--harness") o.harness = need(a);
    else if (a === "--session") o.session = need(a);
    else if (a === "--tui") o.tui = true;
    else if (a === "--headless") o.tui = false;
    else throw new UsageError(`run: unknown option ${a}`);
  }
  o.command = args.slice(i);
  if (!o.command.length) throw new UsageError("run needs a command: verity run [--harness H] [--session ID] [--tui|--headless] -- <command> [args...]");
  if (o.harness !== null && !/^[a-z0-9-]+$/.test(o.harness)) throw new UsageError("--harness must be a lowercase name");
  return o;
}

export function parseGateArgs(args) {
  const o = { run: null, base: null, cwd: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    rejectAllowance("gate", a);
    const need = () => {
      if (i + 1 >= args.length) throw new UsageError(`${a} needs a value`);
      return args[++i];
    };
    if (a === "--run") o.run = need();
    else if (a === "--base") o.base = need();
    else if (a === "--cwd") o.cwd = need();
    else if (a === "--json") continue;
    else throw new UsageError(`gate: unknown option ${a}`);
  }
  if (o.run && o.base) throw new UsageError("gate: --run and --base are exclusive");
  return o;
}

// ---------------------------------------------------------------------------
// exit contract
// ---------------------------------------------------------------------------

const SIGNUM = os.constants.signals;

/** The wrapper's exit code (item 6). */
export function runExitCode({ mode, received, childCode, gateCode }) {
  if (received === "SIGINT" || received === "SIGTERM") return 128 + SIGNUM[received];
  if (mode === "live") return gateCode;
  return childCode;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

function spawnInherit(file, argv, { env, cwd, state }) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      for (const [s, h] of Object.entries(handlers)) process.removeListener(s, h);
      resolve(r);
    };
    const handlers = {};
    let child;
    try {
      child = spawn(file, argv, { stdio: "inherit", env, cwd });
    } catch (e) {
      finish({ code: 127, signal: null, spawnError: String(e && e.message) });
      return;
    }
    for (const s of ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT"]) {
      handlers[s] = () => {
        if ((s === "SIGINT" || s === "SIGTERM") && !state.received) state.received = s;
        try {
          child.kill(s);
        } catch {
          // already gone
        }
      };
      process.on(s, handlers[s]);
    }
    child.on("error", (e) => finish({ code: 127, signal: null, spawnError: String(e && e.message) }));
    child.on("exit", (code, signal) => finish({ code, signal }));
  });
}

function childExitCode(r) {
  if (Number.isInteger(r.code)) return r.code;
  if (r.signal && SIGNUM[r.signal]) return 128 + SIGNUM[r.signal];
  return 1;
}

export async function runMain(args, env = process.env) {
  const o = parseRunArgs(args);
  const harness = o.harness || inferHarness(o.command[0]);
  const posture = runPosture(harness, env);
  if (posture.disabled) {
    say("VERITY_DISABLE=1: running the command unsupervised");
    const r = await spawnInherit(o.command[0], o.command.slice(1), { env, cwd: process.cwd(), state: {} });
    return childExitCode(r);
  }
  const root = workspaceRoot(process.cwd());
  const runId = newRunId();
  const runDir = mkdirp(path.join(runsDir(env), runId));
  const basePath = path.join(runDir, "base.json");
  const checkLog = path.join(runDir, "check.log");
  const feedbackFile = path.join(runDir, "feedback.md");
  const verdictFile = path.join(runDir, "verdict.json");
  const hooksDir = path.join(runDir, "hooks");
  const tui = o.tui ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);

  // Shared-workspace rule: another live run on this root → shared attribution, live drops to shadow.
  const lockDir = mkdirp(locksDir(root, env));
  const lockFile = path.join(lockDir, `${runId}.lock`);
  const othersAtStart = liveLocks(root, runId, env);
  writeJson(lockFile, { runId, pid: process.pid, root, startedAt: new Date().toISOString() });
  let mode = posture.mode;
  let downgraded = posture.downgraded || null;
  const requestedMode = posture.requestedMode || (posture.mode === "live" ? "live" : null);
  const applyShared = () => {
    if (mode === "live") {
      mode = "shadow";
      downgraded = "shared_workspace";
    }
  };
  if (othersAtStart.length) applyShared();
  // Tell the runs already here that the tree is now shared (they read it when they verify).
  for (const other of othersAtStart) {
    try {
      fs.writeFileSync(path.join(lockDir, `${other.runId}.shared`), runId + "\n", { mode: 0o600, flag: "a" });
    } catch {
      // they will still see this run's lock if it is alive at their verify
    }
  }
  const sharedMark = path.join(lockDir, `${runId}.shared`);

  const trusted = trustedRunConfig(root); // frozen before the child starts
  const meta = { schema: RUN_SCHEMA, runId, root, harness, command: path.basename(o.command[0]), session: o.session, tui, mode, ...(requestedMode && requestedMode !== mode ? { requestedMode, downgraded } : {}), startedAt: new Date().toISOString(), pid: process.pid, basePath, hooksDir, trustedConfig: trusted.file };

  let baseSha = null;
  let snapshotError = null;
  try {
    const base = snapshot({ cwd: root, shadowGitDir: shadowGitDir(root, env), exclude: path.resolve(verityHome(env)).startsWith(root + path.sep) ? [verityHome(env)] : [] });
    writeJson(basePath, base);
    baseSha = sha256File(basePath);
    meta.baseSha256 = baseSha;
    meta.shadowGit = base.repos.some((r) => r.shadowGitDir);
  } catch (e) {
    snapshotError = String(e && e.message ? e.message : e).slice(0, 500);
    meta.snapshotError = snapshotError;
  }
  installGuard(hooksDir);
  writeJson(path.join(runDir, "run.json"), meta);

  const childEnv = { ...env, ...guardEnv(hooksDir, env), VERITY_RUN_ID: runId, VERITY_RUN_DIR: runDir, VERITY_RUN_MODE: mode, VERITY_RUN_HARNESS: harness };
  const state = { received: null };
  let relaunches = 0;
  let r = await spawnInherit(o.command[0], o.command.slice(1), { env: childEnv, cwd: process.cwd(), state });
  let childCode = childExitCode(r);
  if (r.spawnError) say(`could not start ${o.command[0]}: ${r.spawnError}`);

  for (;;) {
    // A second INT/TERM while verifying: record what is known and leave with the signal's code.
    const late = {};
    for (const s of ["SIGINT", "SIGTERM"]) {
      late[s] = () => {
        state.received = state.received || s;
        appendCliVerdict({ event: "run", harness, mode, applied: false, runId, cwd: root, verdict: { decision: "error", message: "Verity: interrupted while verifying", findings: [] }, extra: { attribution: othersAtStart.length ? "shared" : null }, detail: { childExit: childCode, signal: s, relaunches }, env });
        try {
          fs.rmSync(lockFile, { force: true });
        } catch {
          // best effort
        }
        process.exit(128 + SIGNUM[s]);
      };
      process.on(s, late[s]);
    }
    const t0 = Date.now();
    const verdict = snapshotError
      ? { schema: "verity.swarm.verdict/1", decision: "error", errorKind: "internal", message: `Verity: the gate could not answer: no base (snapshot failed: ${snapshotError})`, error: snapshotError, findings: [] }
      : await verifyAgainst({ root, basePath, baseSha, trusted, checkLog });
    const wallMs = Date.now() - t0;
    for (const [s, h] of Object.entries(late)) process.removeListener(s, h);

    const othersNow = liveLocks(root, runId, env);
    const shared = othersAtStart.length > 0 || othersNow.length > 0 || fs.existsSync(sharedMark);
    if (shared) applyShared();
    const signalled = state.received === "SIGINT" || state.received === "SIGTERM";
    const decisionCode = verdict.decision === "error" ? (verdict.exitCode === EXIT.USAGE ? EXIT.USAGE : EXIT.INTERNAL) : exitCodeFor(verdict.decision);
    const tpl = relaunchTemplate(harness, env);
    const failed = verdict.decision === "fail" || verdict.decision === "unverifiable";
    const canRelaunch = mode === "live" && failed && !signalled && !tui && tpl && o.session && relaunches < runConfig(env).relaunchBudget;

    writeJson(verdictFile, { ...verdict, runId, mode, childExit: childCode });
    fs.writeFileSync(feedbackFile, renderRelaunchBlock(verdict, { runId, checkLog: verdict.check && verdict.check.command ? checkLog : null }), { mode: 0o600 });
    const applied = mode === "live" && verdict.decision !== "pass";
    appendCliVerdict({
      event: "run", harness, mode, applied, runId, cwd: root, verdict, wallMs, env,
      extra: { ...(shared ? { attribution: "shared" } : {}), ...(requestedMode && requestedMode !== mode ? { requestedMode, downgraded } : {}), ...(tui ? { tui: true } : {}) },
      detail: { childExit: childCode, ...(state.received ? { signal: state.received } : {}), gateExit: decisionCode, relaunches, ...(meta.shadowGit ? { shadowGit: true } : {}) },
    });

    const label = mode === "live" ? "live" : "shadow, not enforced";
    say(`${runId} ${verdict.decision} (${label}${shared ? ", shared workspace" : ""}): ${String(verdict.message || "").slice(0, 600)}`);
    if (verdict.decision !== "pass") say(`feedback: ${feedbackFile}`);

    if (canRelaunch) {
      relaunches++;
      const cmd = renderTemplate(tpl.template, { feedbackFile, session: o.session });
      say(`relaunching (${relaunches}/${runConfig(env).relaunchBudget}): ${cmd}`);
      r = await spawnInherit("bash", ["-c", cmd], { env: childEnv, cwd: process.cwd(), state });
      childCode = childExitCode(r);
      continue;
    }
    if (failed && !signalled) {
      if (tpl) {
        const cmd = renderTemplate(tpl.template, { feedbackFile, session: o.session });
        say(`${mode === "live" ? (tui ? "interactive session: not relaunched automatically" : "relaunch budget spent or no session id") : "shadow: not relaunched"}; to resume with the feedback: ${cmd}`);
      } else {
        say(`no verified relaunch preset for ${harness} (and no run.relaunch.${harness} in the Verity config); the feedback is in ${feedbackFile}`);
      }
    }

    for (const f of [lockFile, sharedMark]) {
      try {
        fs.rmSync(f, { force: true });
      } catch {
        // best effort
      }
    }
    pruneShadowStore(root, runId, env);
    return runExitCode({ mode, received: state.received, childCode, gateCode: decisionCode });
  }
}

/** Remove the root's shadow git dir once no other live run uses it. Returns true when pruned. */
export function pruneShadowStore(root, runId, env = process.env) {
  if (liveLocks(root, runId, env).length) return false;
  const dir = shadowGitDir(root, env);
  if (!fs.existsSync(dir)) return false;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// gate
// ---------------------------------------------------------------------------

/** The run a gate call judges against: --run, else VERITY_RUN_ID, else the newest live run on this root. */
function findRun(o, root, env) {
  const id = o.run || env.VERITY_RUN_ID || (liveLocks(root, null, env).pop() || {}).runId || null;
  if (!id) return null;
  if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new UsageError(`gate: not a run id: ${id}`);
  const meta = readJson(path.join(runsDir(env), id, "run.json"));
  if (!meta) throw new UsageError(`gate: no run ${id} under ${runsDir(env)}`);
  return meta;
}

export async function gateMain(args, env = process.env) {
  const o = parseGateArgs(args);
  const t0 = Date.now();
  let root;
  let basePath;
  let baseSha = null;
  let runId = null;
  let harness = "cli";
  if (o.base) {
    basePath = path.resolve(o.base);
    const b = readJson(basePath);
    if (!b) throw new UsageError(`gate: --base is not readable JSON: ${o.base}`);
    root = path.resolve(o.cwd || b.cwd || process.cwd());
  } else {
    const here = workspaceRoot(o.cwd || process.cwd());
    const meta = findRun(o, here, env);
    if (!meta) throw new UsageError("gate: no active run for this workspace; pass --run <id> or --base <file>");
    if (!meta.basePath || !meta.baseSha256) throw new GateError(`gate: run ${meta.runId} has no base (${meta.snapshotError || "snapshot missing"})`);
    root = meta.root;
    basePath = meta.basePath;
    baseSha = meta.baseSha256;
    runId = meta.runId;
    harness = meta.harness || "cli";
  }
  const posture = runPosture(harness, env);
  const trusted = trustedRunConfig(root);
  const checkLog = runId ? path.join(runsDir(env), runId, `gate-${Date.now()}.check.log`) : path.join(os.tmpdir(), `verity-gate-${process.pid}-${Date.now()}.check.log`);
  const verdict = await verifyAgainst({ root, basePath, baseSha, trusted, checkLog });
  appendCliVerdict({ event: "gate", harness, mode: posture.mode, applied: false, runId, cwd: root, verdict, wallMs: Date.now() - t0, env, detail: { gateExit: verdict.decision === "error" ? verdict.exitCode ?? EXIT.INTERNAL : exitCodeFor(verdict.decision) } });
  process.stdout.write(JSON.stringify({ ...verdict, ...(runId ? { runId } : {}) }) + "\n");
  if (verdict.decision === "error") return verdict.exitCode === EXIT.USAGE ? EXIT.USAGE : EXIT.INTERNAL;
  return exitCodeFor(verdict.decision);
}

// ---------------------------------------------------------------------------
// feedback
// ---------------------------------------------------------------------------

export function feedbackMain(args) {
  let file = null;
  let checkLog;
  let out = null;
  let block = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const need = () => {
      if (i + 1 >= args.length) throw new UsageError(`${a} needs a value`);
      return args[++i];
    };
    if (a === "--verdict") file = need();
    else if (a === "--check-log") checkLog = need();
    else if (a === "--out") out = need();
    else if (a === "--plain") block = false;
    else if (!a.startsWith("-") && !file) file = a;
    else throw new UsageError(`feedback: unknown option ${a}`);
  }
  if (!file) throw new UsageError("feedback needs a verdict file: verity feedback --verdict <file> [--check-log <file>] [--out <file>] [--plain]");
  const v = readJson(file);
  if (!v || typeof v !== "object") throw new UsageError(`feedback: not a verdict file: ${file}`);
  const text = block ? renderRelaunchBlock(v, { runId: v.runId || null, checkLog }) : renderFeedback(v, { checkLog }) + "\n";
  if (out) fs.writeFileSync(out, text, { mode: 0o600 });
  else process.stdout.write(text);
  return 0;
}
