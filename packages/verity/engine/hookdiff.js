// Verity hybrid, Phase 1: the diff ledger under the hook path, dual-run.
//
//   SessionStart  record a base tree of the session's git workspace (the swarm
//                 gate's writeWorkingTree, temporary index, real index never
//                 touched) in <home>/bases/<agent>-<session>.json — outside the
//                 workspace. A workspace that cannot be snapshotted gets a
//                 plain `state: "unavailable"` record with the reason.
//   passing check the working-tree hash at that moment goes on the ledger fact
//                 (`treeHash`), so Stop can tell whether the tree moved since.
//   Stop          diff base → current tree through the shared diffRules core,
//                 apply the done rule against the last passing check and its
//                 tree hash, and return a provenance-only `diffDecision`.
//
// Record-only: the event-ledger verdict alone answers the harness. Nothing
// here may throw into the hook or outlast its time budget; an error becomes
// `diffDecision: { decision: "unverifiable", reason: "error", errorClass }`.
import fs from "node:fs";
import path from "node:path";
import { ensureDir } from "./home.js";
import { sessionFile } from "./ledger.js";
import {
  DEFAULT_IGNORE,
  MAX_DIFF_BYTES,
  MAX_LOOSE_FILES,
  blockingFindings,
  decideDone,
  diffRepo,
  diffRules,
  gitTry,
  treeExists,
  writeWorkingTree,
} from "./swarm.js";

export const HOOK_BASE_SCHEMA = "verity.hook.base/1";
/** Untracked (not ignored) files a snapshot will hash: the swarm gate's loose-file cap. */
export const MAX_UNTRACKED_FILES = MAX_LOOSE_FILES;
/** Their total size: the swarm gate's diff cap. */
export const MAX_UNTRACKED_BYTES = MAX_DIFF_BYTES;
/** Wall-clock budget for the git work of one hook event (the wrapper kills the engine at 8 s). */
export const HOOK_GIT_BUDGET_MS = 2000;

class CapExceeded extends Error {}
class BudgetExceeded extends Error {}

export function basesDir(home) {
  return path.join(home, "bases");
}

/** <home>/bases/<agent>-<session>.json, named exactly like the session ledger. */
export function baseFile(home, agent, sessionId) {
  return path.join(basesDir(home), path.basename(sessionFile(home, agent, sessionId), ".jsonl") + ".json");
}

export function readBase(home, agent, sessionId) {
  try {
    return JSON.parse(fs.readFileSync(baseFile(home, agent, sessionId), "utf8"));
  } catch {
    return null;
  }
}

function errorClass(e) {
  return (e && e.constructor && e.constructor.name) || "Error";
}

function budget(ms = HOOK_GIT_BUDGET_MS) {
  const deadline = Date.now() + ms;
  return () => {
    const left = deadline - Date.now();
    if (left <= 0) throw new BudgetExceeded(`hook git budget of ${ms}ms spent`);
    return left;
  };
}

/** Throws CapExceeded when the untracked load is above the caps (a snapshot would hash all of it). */
function assertUnderCaps(top, left) {
  const raw = gitTry(top, ["ls-files", "--others", "--exclude-standard", "-z"], { timeoutMs: left() });
  if (raw === null) throw new CapExceeded("untracked_unlisted");
  const files = raw.split("\0").filter(Boolean);
  if (files.length > MAX_UNTRACKED_FILES) throw new CapExceeded("untracked_files_over_cap");
  let bytes = 0;
  for (const f of files) {
    try {
      bytes += fs.lstatSync(path.join(top, f)).size;
    } catch {
      // vanished between listing and stat
    }
    if (bytes > MAX_UNTRACKED_BYTES) throw new CapExceeded("untracked_bytes_over_cap");
  }
}

function currentTree(repo, left) {
  assertUnderCaps(repo, left);
  return writeWorkingTree(repo, { timeoutMs: left() });
}

function takeBase(cwd, left) {
  const top = gitTry(cwd, ["rev-parse", "--show-toplevel"], { timeoutMs: left() });
  if (!top) return { state: "unavailable", reason: "not_a_git_tree" };
  try {
    const baseTree = currentTree(top, left);
    return { state: "ok", repo: top, baseTree, head: gitTry(top, ["rev-parse", "--verify", "-q", "HEAD"], { timeoutMs: left() }) };
  } catch (e) {
    if (e instanceof CapExceeded) return { state: "unavailable", reason: e.message, repo: top };
    throw e;
  }
}

/**
 * SessionStart: record the session's base once (a resumed or compacted
 * session keeps its first base). Never throws; returns the record written,
 * or null when even the record could not be written.
 */
export function recordSessionBase(home, agent, sessionId, cwd) {
  try {
    const file = baseFile(home, agent, sessionId);
    if (fs.existsSync(file)) return readBase(home, agent, sessionId);
    const t0 = Date.now();
    let rec;
    try {
      rec = takeBase(cwd, budget());
    } catch (e) {
      rec = { state: "unavailable", reason: "snapshot_error", errorClass: errorClass(e) };
    }
    rec = { schema: HOOK_BASE_SCHEMA, createdAt: new Date().toISOString(), cwd, ...rec, durationMs: Date.now() - t0 };
    ensureDir(basesDir(home));
    fs.writeFileSync(file, JSON.stringify(rec) + "\n", { mode: 0o600 });
    return rec;
  } catch {
    return null;
  }
}

/**
 * The working-tree hash to record on a passing check's fact: undefined when
 * the session has no usable base (the fact stays exactly as before), null
 * when the hash could not be taken.
 */
export function treeHashFor(home, agent, sessionId) {
  const base = readBase(home, agent, sessionId);
  if (!base || base.state !== "ok") return undefined;
  try {
    return currentTree(base.repo, budget());
  } catch {
    return null;
  }
}

function lastPassingCheck(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    const f = history[i] && history[i].type === "event" ? history[i].fact : null;
    if (f && f.kind === "command" && f.verify && f.exitCode === 0) return f;
  }
  return null;
}

/** Provenance only: rule, path, label (and severity for advisory findings). Never a fingerprint, value or line. */
function provenance(f) {
  return { rule: f.rule, path: f.path, ...(f.label ? { label: f.label } : {}), ...(f.severity ? { severity: f.severity } : {}), ...(f.allowed ? { allowed: true } : {}) };
}

/**
 * Stop: the diff verdict for a session whose base is usable, or undefined
 * (no base, or an unavailable one → the Stop path is today's, unchanged).
 * decision: pass | fail | unverifiable. Never throws.
 */
export function diffDecisionFor(home, agent, sessionId, { history, cfg = {}, testFiles = null }) {
  const base = readBase(home, agent, sessionId);
  if (!base || base.state !== "ok") return undefined;
  const t0 = Date.now();
  try {
    const left = budget();
    const postTree = currentTree(base.repo, left);
    if (!treeExists(base.repo, base.baseTree)) throw new Error("base tree missing from the repository");
    const check = lastPassingCheck(history);
    const command = check ? check.command : null;
    const d = postTree === base.baseTree
      ? { entries: [], added: new Map(), untracked: new Set(), truncated: false }
      : diffRepo(base.repo, base.baseTree, postTree, { timeoutMs: left() });
    const ignoreGlobs = [...new Set([...DEFAULT_IGNORE, ...(cfg.ignoreGlobs || [])])];
    const r = diffRules({ abs: base.repo, entries: d.entries, added: d.added, untracked: d.untracked, baseTree: base.baseTree, postTree, ignoreGlobs, allowSecrets: cfg.allowSecrets === true, command });
    const blocking = blockingFindings(r.findings);
    let decision;
    let reason;
    if (blocking.length) {
      decision = "fail";
      reason = blocking[0].rule;
    } else if (r.code.length === 0) {
      decision = "pass";
      reason = "no_code_change";
    } else if (!check) {
      decision = "fail";
      reason = "no_passing_check";
    } else if (check.treeHash !== postTree) {
      decision = "fail";
      reason = check.treeHash ? "tree_moved_since_check" : "check_tree_unknown";
    } else {
      const done = decideDone({ code: r.code, command, exitCode: 0, testFiles });
      decision = done.decision === "allow" ? "pass" : "fail";
      reason = done.decision === "allow" ? "check_passed_on_tree" : "hollow_pass";
    }
    return {
      decision,
      reason,
      findings: r.findings.map(provenance),
      code: r.code,
      baseTree: base.baseTree,
      postTree,
      ...(check ? { checkTree: check.treeHash ?? null } : {}),
      ...(d.truncated ? { truncated: true } : {}),
      durationMs: Date.now() - t0,
    };
  } catch (e) {
    return { decision: "unverifiable", reason: e instanceof CapExceeded ? e.message : "error", errorClass: errorClass(e), durationMs: Date.now() - t0 };
  }
}
