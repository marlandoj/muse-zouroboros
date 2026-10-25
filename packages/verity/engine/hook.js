// Per-event hook pipeline: parse → route → ledger → verdict.
// Reads one event JSON from stdin, prints one verdict JSON to stdout.
import fs from "node:fs";
import path from "node:path";
import { appendLine, readSession, sessionFile } from "./ledger.js";
import { buildFact } from "./events.js";
import { decideStop, serialize } from "./rules.js";
import { loadEffectiveConfig } from "./config.js";
import {
  detectSecret,
  detectTestDeletion,
  needsPipefailRewrite,
  pipefailRewrite,
  repoHasTestFiles,
} from "./checks.js";
import { globMatch } from "./util.js";
import { diffDecisionFor, recordSessionBase, treeHashFor } from "./hookdiff.js";

const SESSION_NOTE =
  "Verity guards this session. Before you finish, a check has to pass " +
  "after your last code edit. A test, build, lint, or type-check command " +
  "counts, run so its own exit status is the result: a pipe into `tail`, " +
  "`|| true`, or a trailing `; echo` hides it. " +
  "Keys go in a git-ignored env file, and tests are removed or skipped " +
  "only when the user asks.";

const REWRITE_NOTE =
  "Verity ran this with `set -o pipefail`, so the check's own exit status " +
  "is the result and it counts as a check.";

function logCrash(home, err) {
  try {
    const file = path.join(home, "errors.log");
    fs.appendFileSync(file, `${new Date().toISOString()} ${err}\n`, { mode: 0o600 });
  } catch {
    // a crashing logger must not crash the hook
  }
}

function appendVerdict(home, agent, sessionId, cwd, phase, decision, message, extras) {
  const obj = { type: "verdict", cwd, phase, decision, ...(extras || {}) };
  if (message !== undefined) obj.message = message;
  appendLine(home, agent, sessionId, obj);
}

function writeTools(event) {
  const ti = event.tool_input || {};
  return ti.content !== undefined || ti.new_string !== undefined;
}

/**
 * Handle one hook event. Returns the verdict object to print.
 * `ctx` = { home, agent }.
 */
export function handleEvent(rawInput, agent, ctx) {
  const home = ctx.home;
  let event;
  try {
    event = JSON.parse(rawInput);
  } catch (err) {
    logCrash(home, `${err.name}: ${err.message}`);
    return {};
  }
  if (!event || typeof event !== "object") {
    logCrash(home, "SyntaxError: hook event must be a JSON object");
    return {};
  }

  const cwd = event.cwd || process.cwd();
  const sessionId = event.session_id || "unknown";
  const name = event.hook_event_name || "";
  const tool = event.tool_name || "";
  const cfg = loadEffectiveConfig(home, cwd);

  if (name === "SessionStart") {
    // Phase 1 dual-run: the diff ledger's base. Never fails the session start.
    recordSessionBase(home, agent, sessionId, cwd);
    return serialize("note", SESSION_NOTE, agent);
  }

  if (name === "PreToolUse") {
    if (writeTools(event)) {
      const ti = event.tool_input || {};
      const filePath = ti.file_path || ti.path || ti.notebook_path || "file";
      const content = [ti.content, ti.new_string].filter((v) => v !== undefined).join("\n");
      const msg = detectSecret(filePath, content, cwd, cfg.allowSecrets);
      if (msg) {
        appendVerdict(home, agent, sessionId, cwd, "pre", "deny", msg);
        return serialize("deny", msg, agent);
      }
      return {};
    }
    if (tool === "Bash") {
      const command = String((event.tool_input || {}).command ?? "");
      const delMsg = detectTestDeletion(command, cwd);
      if (delMsg) {
        // Governance review 2026-10-14: test deletion is deny, not ask.
        // Tests are only removed when the user asked for it; the gate
        // refuses the deletion rather than prompting.
        appendVerdict(home, agent, sessionId, cwd, "pre", "deny", delMsg);
        return serialize("deny", delMsg, agent);
      }
      if (needsPipefailRewrite(command, cfg.verifyPatterns)) {
        const newCmd = pipefailRewrite(command);
        appendVerdict(home, agent, sessionId, cwd, "pre", "rewrite", REWRITE_NOTE);
        return serialize("rewrite", { command: newCmd, note: REWRITE_NOTE }, agent);
      }
    }
    return {};
  }

  if (name === "PostToolUse" || name === "PostToolUseFailure") {
    const built = buildFact(event, cwd, cfg);
    if (!built) return {};
    // Config `ignore` globs strip matching paths from the fact's `code`
    // (the gate's change-set); `files` keeps the full record and the event
    // is always ledgered.
    if (cfg.ignoreGlobs.length && Array.isArray(built.fact.code)) {
      const isIgnored = (f) =>
        cfg.ignoreGlobs.some(
          (g) => globMatch(g, f) || globMatch(g, f.split("/").pop())
        );
      built.fact.code = built.fact.code.filter((f) => !isIgnored(f));
    }
    // A passing check carries the working-tree hash it passed on (sessions
    // with a usable diff base only; other facts are unchanged).
    if (built.fact.kind === "command" && built.fact.verify && built.fact.exitCode === 0) {
      const treeHash = treeHashFor(home, agent, sessionId);
      if (treeHash !== undefined) built.fact.treeHash = treeHash;
    }
    appendLine(home, agent, sessionId, {
      type: "event",
      cwd,
      phase: built.phase,
      hookEvent: name,
      tool,
      fact: built.fact,
    });
    return {};
  }

  if (name === "Stop") {
    const built = buildFact(event, cwd, cfg);
    appendLine(home, agent, sessionId, {
      type: "event",
      cwd,
      phase: built.phase,
      hookEvent: name,
      tool: "",
      fact: built.fact,
    });
    const prior = readSession(home, agent, sessionId);
    // Decide over everything before the stop event just appended.
    const history = prior.slice(0, -1);
    // Semantic anchor: one repo scan per stop; null (unscannable) skips it.
    const testFiles = repoHasTestFiles(cwd);
    const { decision, message, valve, hollowPass } = decideStop(
      history,
      event.stop_hook_active === true,
      cfg.releaseValve === true,
      testFiles,
    );
    const extras = {};
    if (valve) extras.valve = true;
    if (hollowPass) extras.hollowPass = true;
    // Second opinion, recorded only: the event verdict above answers the
    // harness. Absent when the session has no usable diff base.
    const diffDecision = diffDecisionFor(home, agent, sessionId, { history, cfg, testFiles });
    if (diffDecision) extras.diffDecision = diffDecision;
    appendVerdict(home, agent, sessionId, cwd, "stop", decision, message, Object.keys(extras).length ? extras : undefined);
    return serialize(decision, message, agent);
  }

  // Unknown events: not ledgered, no verdict.
  return {};
}

export { sessionFile };
