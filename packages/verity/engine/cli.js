#!/usr/bin/env node
// Verity engine CLI. Clean-room reimplementation: same argv contract as the
// engine it replaces, original code throughout.
//
//   engine/cli.js hook --agent claude|codex   run as a hook; reads the event on stdin
//   engine/cli.js status [session-file]       what the ledger knows about the latest session
//   engine/cli.js sessions                    list recorded sessions
//   engine/cli.js replay [session-file]       re-derive every Stop verdict from the ledger
//   engine/cli.js trust                       let this project's .verity.json turn checks off
//   engine/cli.js snapshot --cwd D --out F    Verity×Swarm: record a workspace's pre-task base
//   engine/cli.js verify --cwd D --base F     Verity×Swarm: judge the workspace against its base
//   engine/cli.js mode [--harness H]          the hook's resolved mode / checks for a harness, as JSON
//   engine/cli.js run [--harness H] [--session ID] [--tui|--headless] -- CMD...
//                                             Phase 2: supervise a session (snapshot, spawn, verify, feedback, record)
//   engine/cli.js gate [--run ID | --base F] [--cwd D]
//                                             Phase 2: read-only checkpoint against a run's base (no allowance input)
//   engine/cli.js feedback --verdict F [--check-log L] [--out F] [--plain]
//                                             Phase 2: render the relaunch block for a verdict
//   engine/cli.js prepush --remote R --url U --stdin-file F --chain C --repo-hook-exit N
//                                             Phase 2: the push guard's check (called by the run's pre-push hook)
//
// Home: $VERITY_ENGINE_HOME, else ~/.verity/engine.
// Existing ~/.canny sessions migrate automatically.
import fs from "node:fs";
import path from "node:path";
import { handleEvent } from "./hook.js";
import { decideStop, statusSummary } from "./rules.js";
import { listSessions, sessionFile } from "./ledger.js";
import { parseJsonLines } from "./util.js";
import { migrateIfNeeded, resolveHome, sessionsDir } from "./home.js";
import { trustCwd } from "./config.js";
import { resolveMode } from "./mode.js";
import { feedbackMain, gateMain, runMain } from "./run.js";
import { prepushMain } from "./prepush.js";
import { DEFAULT_CHECK_TIMEOUT_S, DEFAULT_MAX_DEPTH, EXIT, GateError, VERDICT_SCHEMA, engineFingerprint, exitCodeFor, snapshot, verify } from "./swarm.js";

const HOME = resolveHome();
migrateIfNeeded(HOME);

function readStdin() {
  return fs.readFileSync(0, "utf8");
}

function resolveSessionFile(arg) {
  if (arg) {
    const p = arg.includes("/") ? arg : path.join(sessionsDir(HOME), arg);
    return p.endsWith(".jsonl") ? p : `${p}.jsonl`;
  }
  // Latest session overall, by file mtime.
  let best = null;
  let bestMtime = -1;
  for (const f of listSessions(HOME)) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m > bestMtime) {
        bestMtime = m;
        best = f;
      }
    } catch {
      // unreadable
    }
  }
  return best;
}

function cmdHook(agent) {
  const verdict = handleEvent(readStdin(), agent || "claude", { home: HOME });
  process.stdout.write(JSON.stringify(verdict));
}

function cmdStatus(arg) {
  const errors = [];
  try {
    const log = fs.readFileSync(path.join(HOME, "errors.log"), "utf8");
    for (const line of log.split("\n")) {
      const t = line.trim();
      if (t) errors.push(t);
    }
  } catch {
    // no errors logged
  }
  const file = resolveSessionFile(arg);
  if (!file || !fs.existsSync(file)) {
    if (errors.length) {
      const last = errors[errors.length - 1];
      process.stdout.write(
        `errors    ${errors.length} hook crash in ${HOME}/errors.log, and a crashed hook checks nothing. Last: ${last}\n`
      );
    }
    process.stdout.write(
      `no sessions recorded for ${process.cwd()} under ${HOME}; ` +
        `\`node "${process.argv[1]}" sessions\` lists every project's\n`
    );
    return;
  }
  const lines = parseJsonLines(fs.readFileSync(file, "utf8"));
  const s = statusSummary(lines);
  const firstCwd = (() => {
    for (const ln of lines) if (ln.cwd) return ln.cwd;
    return process.cwd();
  })();
  const out = [];
  if (errors.length) {
    const last = errors[errors.length - 1];
    out.push(
      `errors    ${errors.length} hook crash in ${HOME}/errors.log, and a crashed hook checks nothing. Last: ${last}`
    );
  }
  out.push(`session   ${path.basename(file)}`);
  out.push(`project   ${firstCwd}`);
  out.push(`events    ${lines.filter((ln) => ln.type === "event").length}`);
  out.push(`edited    ${s.edited.length ? s.edited.join(", ") : "nothing that needs a check"}`);
  out.push(`verified  ${s.verified}`);
  if (s.lastSummary) {
    const l = s.lastSummary;
    const ex = l.exitCode === null || l.exitCode === undefined ? "?" : l.exitCode;
    out.push(`last cmd  \`${l.command}\` exit ${ex}: ${l.summary}`);
  }
  out.push(`stops     ${s.stops.length ? s.stops.join(", ") : "none yet"}`);
  out.push(`jev       0 calls, 0 cached, 0 failed`);
  process.stdout.write(out.join("\n") + "\n");
}

function cmdSessions() {
  const files = listSessions(HOME)
    .map((f) => {
      let lines = [];
      try {
        lines = parseJsonLines(fs.readFileSync(f, "utf8"));
      } catch {
        // unreadable
      }
      let mtime = 0;
      try {
        mtime = fs.statSync(f).mtimeMs;
      } catch {
        // ignore
      }
      let cwd = "";
      for (const ln of lines) {
        if (ln.cwd) {
          cwd = ln.cwd;
          break;
        }
      }
      return { f, mtime, cwd };
    })
    .sort((a, b) => b.mtime - a.mtime);
  for (const { f, mtime, cwd } of files) {
    process.stdout.write(`${new Date(mtime).toISOString()}  ${f}  ${cwd}\n`);
  }
}

function cmdReplay(arg) {
  const file = resolveSessionFile(arg);
  if (!file || !fs.existsSync(file)) {
    process.stderr.write("no such session\n");
    process.exitCode = 1;
    return;
  }
  const lines = parseJsonLines(fs.readFileSync(file, "utf8"));
  const problems = [];
  let n = 0;
  lines.forEach((ln, i) => {
    if (ln.type !== "event" || !ln.fact || ln.fact.kind !== "stop") return;
    n++;
    const recorded = lines
      .slice(i + 1)
      .find((l) => l.type === "verdict" && l.phase === "stop");
    // The valve decision depends on operator-trusted config, which is not in
    // the ledger; replay with the recorded trip flag so a ledgered warn
    // re-derives as warn and a ledgered block as block. Same for the
    // semantic anchor: the ledger's hollowPass flag carries the repo's
    // test-file state at decision time (absent on old ledgers → assume
    // tests existed, i.e. pre-anchor behavior).
    const { decision } = decideStop(
      lines.slice(0, i),
      ln.fact.stopHookActive === true,
      recorded ? recorded.valve === true : false,
      recorded ? (recorded.hollowPass === true ? false : true) : null,
    );
    if (!recorded || recorded.decision !== decision) {
      problems.push(
        `stop #${n}: ledger says ${recorded ? recorded.decision : "nothing"}, re-derived ${decision}`
      );
    }
  });
  if (!problems.length) {
    process.stdout.write("all Stop verdicts reproduced\n");
  } else {
    process.stdout.write(problems.join("\n") + "\n");
    process.exitCode = 1;
  }
}

function cmdTrust() {
  const r = trustCwd(HOME, process.cwd());
  process.stdout.write(r.text + "\n");
  if (!r.ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Verity×Swarm: snapshot / verify (the orchestrator-run gate). Argv contract:
//   snapshot --cwd <workspace> --out <base.json> [--max-depth 3] [--exclude <path>]...
//   verify   --cwd <workspace> --base <base.json> --json
//            [--check <cmd>] [--check-source task|policy|verity-json-base] [--waived]
//            [--check-cwd <rel>] [--check-timeout <s>] [--check-log <file>]
//            [--require-check] [--allow-test-deletion] [--allow-secrets] [--allow-check-edits]
//            [--ignore <glob>]... [--exclude <path>]... [--policy <file>] [--max-depth N]
// Exit: 0 pass, 1 fail, 2 unverifiable, 64 usage, 70 internal (see swarm.js).
// ---------------------------------------------------------------------------

function parseSwarmArgs(args) {
  const o = { ignore: [], exclude: [], json: false, requireCheck: false, allowTestDeletion: false, allowSecrets: false, allowCheckEdits: false, waived: false };
  const need = (i, flag) => {
    if (i + 1 >= args.length) throw new GateError(`${flag} needs a value`, EXIT.USAGE);
    return args[i + 1];
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    switch (a) {
      case "--cwd": o.cwd = need(i, a); i++; break;
      case "--out": o.out = need(i, a); i++; break;
      case "--base": o.base = need(i, a); i++; break;
      case "--max-depth": o.maxDepth = Number(need(i, a)); i++; break;
      case "--check": o.check = need(i, a); i++; break;
      case "--check-source": o.checkSource = need(i, a); i++; break;
      case "--check-cwd": o.checkCwd = need(i, a); i++; break;
      case "--check-timeout": o.checkTimeoutS = Number(need(i, a)); i++; break;
      case "--check-log": o.checkLog = need(i, a); i++; break;
      case "--policy": o.policy = need(i, a); i++; break;
      case "--ignore": o.ignore.push(need(i, a)); i++; break;
      case "--exclude": o.exclude.push(need(i, a)); i++; break;
      case "--json": o.json = true; break;
      case "--waived": o.waived = true; break;
      case "--require-check": o.requireCheck = true; break;
      case "--allow-test-deletion": o.allowTestDeletion = true; break;
      case "--allow-secrets": o.allowSecrets = true; break;
      case "--allow-check-edits": o.allowCheckEdits = true; break;
      default:
        throw new GateError(`unknown option ${a}`, EXIT.USAGE);
    }
  }
  if (o.maxDepth !== undefined && !(Number.isInteger(o.maxDepth) && o.maxDepth >= 0)) throw new GateError("--max-depth must be a non-negative integer", EXIT.USAGE);
  if (o.checkTimeoutS !== undefined && !(o.checkTimeoutS > 0)) throw new GateError("--check-timeout must be a positive number of seconds", EXIT.USAGE);
  if (o.checkSource !== undefined && !["task", "policy", "verity-json-base"].includes(o.checkSource)) throw new GateError("--check-source must be task|policy|verity-json-base", EXIT.USAGE);
  return o;
}

function swarmFailure(err) {
  const code = err instanceof GateError ? err.code : EXIT.INTERNAL;
  const out = { schema: VERDICT_SCHEMA, decision: "error", errorKind: code === EXIT.USAGE ? "usage" : "internal", exitCode: code, error: String(err && err.message ? err.message : err).slice(0, 2000) };
  process.stdout.write(JSON.stringify(out) + "\n");
  process.exitCode = code;
}

function cmdSnapshot(args) {
  let o;
  try {
    o = parseSwarmArgs(args);
    if (!o.cwd || !o.out) throw new GateError("snapshot needs --cwd and --out", EXIT.USAGE);
    const base = snapshot({ cwd: o.cwd, maxDepth: o.maxDepth ?? DEFAULT_MAX_DEPTH, exclude: o.exclude });
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true, mode: 0o700 });
    fs.writeFileSync(o.out, JSON.stringify(base, null, 2) + "\n", { mode: 0o600 });
    process.stdout.write(JSON.stringify({ schema: base.schema, out: o.out, repos: base.repos.map((r) => ({ path: r.path, baseTree: r.baseTree })), loose: base.loose ? base.loose.files.length : null }) + "\n");
  } catch (err) {
    swarmFailure(err);
  }
}

async function cmdVerify(args) {
  try {
    const o = parseSwarmArgs(args);
    if (!o.cwd || !o.base) throw new GateError("verify needs --cwd and --base", EXIT.USAGE);
    const verdict = await verify({ ...o, checkTimeoutS: o.checkTimeoutS ?? DEFAULT_CHECK_TIMEOUT_S });
    verdict.engine = engineFingerprint();
    process.stdout.write(JSON.stringify(verdict) + (o.json ? "\n" : "\n"));
    process.exitCode = exitCodeFor(verdict.decision);
  } catch (err) {
    swarmFailure(err);
  }
}

// Phase 2: run / gate / feedback / prepush. Usage errors exit 64, internal 70 (the swarm gate's codes).
async function phase2(fn, args, { json = false } = {}) {
  try {
    process.exitCode = await fn(args);
  } catch (err) {
    const code = err instanceof GateError ? err.code : EXIT.INTERNAL;
    if (json) swarmFailure(err);
    else {
      process.stderr.write(`verity: ${String(err && err.message ? err.message : err).slice(0, 2000)}\n`);
      process.exitCode = code;
    }
  }
}

function cmdPrepush(args) {
  const o = {};
  for (let i = 0; i < args.length; i += 2) o[args[i].replace(/^--/, "")] = args[i + 1] ?? "";
  let stdinText = "";
  try {
    stdinText = o["stdin-file"] ? fs.readFileSync(o["stdin-file"], "utf8") : "";
  } catch {
    stdinText = "";
  }
  return prepushMain({ cwd: process.cwd(), remote: o.remote || null, url: o.url || null, stdinText, chain: o.chain || null, repoHookExit: o["repo-hook-exit"] === undefined ? null : Number(o["repo-hook-exit"]) });
}

function help() {
  process.stdout.write(
    `verity-engine: a supervision layer for AI coding agents\n` +
      `\n` +
      `  engine/cli.js hook --agent claude|codex   run as a hook; reads the event on stdin\n` +
      `  engine/cli.js status [session-file]       what the ledger knows about the latest session\n` +
      `  engine/cli.js sessions                    list recorded sessions\n` +
      `  engine/cli.js replay [session-file]       re-derive every Stop verdict from the ledger\n` +
      `  engine/cli.js trust                       let this project's .verity.json turn checks off\n` +
      `  engine/cli.js snapshot --cwd D --out F    swarm gate: record a workspace's pre-task base\n` +
      `  engine/cli.js verify --cwd D --base F --json [--check CMD ...]\n` +
      `                                            swarm gate: judge the workspace against its base\n` +
      `                                            (exit 0 pass, 1 fail, 2 unverifiable, 64 usage, 70 internal)\n` +
      `  engine/cli.js mode [--harness H]          the hook's resolved mode / checks for a harness, as JSON\n` +
      `  engine/cli.js run [--harness H] [--session ID] [--tui|--headless] -- CMD...\n` +
      `                                            supervise a session: snapshot, spawn, verify, feedback, record\n` +
      `                                            (shadow: the child's exit code; live: the gate's; INT/TERM: 128+n)\n` +
      `  engine/cli.js gate [--run ID | --base F] [--cwd D]\n` +
      `                                            read-only checkpoint; takes no allowance, waiver or check input\n` +
      `  engine/cli.js feedback --verdict F [--check-log L] [--out F] [--plain]\n` +
      `                                            render the relaunch block for a verdict\n` +
      `\n` +
      `Sessions live in ${HOME}/sessions. No model is ever consulted: only facts can block.\n`
  );
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
  case "snapshot":
    cmdSnapshot(rest);
    break;
  case "verify":
    await cmdVerify(rest);
    break;
  case "run":
    await phase2(runMain, rest);
    break;
  case "gate":
    await phase2(gateMain, rest, { json: true });
    break;
  case "feedback":
    await phase2(feedbackMain, rest);
    break;
  case "prepush":
    try {
      process.exitCode = cmdPrepush(rest);
    } catch (err) {
      process.stderr.write(`verity: pre-push check failed: ${String(err && err.message ? err.message : err).slice(0, 500)}\n`);
      process.exitCode = 0;
    }
    break;
  case "hook": {
    const ai = rest.indexOf("--agent");
    cmdHook(ai === -1 ? "claude" : rest[ai + 1]);
    break;
  }
  case "status":
    cmdStatus(rest[0]);
    break;
  case "sessions":
    cmdSessions();
    break;
  case "replay":
    cmdReplay(rest[0]);
    break;
  case "trust":
    cmdTrust();
    break;
  case "mode": {
    const hi = rest.indexOf("--harness");
    process.stdout.write(JSON.stringify(resolveMode(hi === -1 ? "claude" : rest[hi + 1] ?? "claude")) + "\n");
    break;
  }
  default:
    help();
    break;
}
