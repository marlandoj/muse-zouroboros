#!/usr/bin/env node
// Verity engine CLI. Clean-room reimplementation: same argv contract as the
// engine it replaces, original code throughout.
//
//   engine/cli.js hook --agent claude|codex   run as a hook; reads the event on stdin
//   engine/cli.js status [session-file]       what the ledger knows about the latest session
//   engine/cli.js sessions                    list recorded sessions
//   engine/cli.js replay [session-file]       re-derive every Stop verdict from the ledger
//   engine/cli.js trust                       let this project's .verity.json turn checks off
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

function help() {
  process.stdout.write(
    `verity-engine: a supervision layer for AI coding agents\n` +
      `\n` +
      `  engine/cli.js hook --agent claude|codex   run as a hook; reads the event on stdin\n` +
      `  engine/cli.js status [session-file]       what the ledger knows about the latest session\n` +
      `  engine/cli.js sessions                    list recorded sessions\n` +
      `  engine/cli.js replay [session-file]       re-derive every Stop verdict from the ledger\n` +
      `  engine/cli.js trust                       let this project's .verity.json turn checks off\n` +
      `\n` +
      `Sessions live in ${HOME}/sessions. No model is ever consulted: only facts can block.\n`
  );
}

const [, , cmd, ...rest] = process.argv;
switch (cmd) {
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
  default:
    help();
    break;
}
