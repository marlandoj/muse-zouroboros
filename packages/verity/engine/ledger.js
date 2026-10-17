// Append-only session ledger. One JSONL file per agent session:
// <home>/sessions/<agent>-<session_id>.jsonl. Owner-only permissions,
// corrupt lines skipped on read. Facts, never file contents.
import fs from "node:fs";
import path from "node:path";
import { ensureDir, sessionsDir } from "./home.js";
import { parseJsonLines } from "./util.js";

function sanitizeAgent(agent) {
  const a = String(agent || "claude").toLowerCase().replace(/[^a-z0-9-]/g, "");
  return a || "claude";
}

export function sessionFile(home, agent, sessionId) {
  const sid = String(sessionId || "unknown").replace(/[^A-Za-z0-9-_]/g, "_");
  return path.join(sessionsDir(home), `${sanitizeAgent(agent)}-${sid}.jsonl`);
}

export function appendLine(home, agent, sessionId, obj) {
  const file = sessionFile(home, agent, sessionId);
  ensureDir(path.dirname(file));
  const line = JSON.stringify({ ts: Date.now(), ...obj }) + "\n";
  fs.appendFileSync(file, line, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // best effort
  }
}

export function readSession(home, agent, sessionId) {
  const file = sessionFile(home, agent, sessionId);
  if (!fs.existsSync(file)) return [];
  return parseJsonLines(fs.readFileSync(file, "utf8"));
}

export function listSessions(home) {
  const dir = sessionsDir(home);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(dir, f));
}
