// Shared utilities for the Verity engine. Written from the behavioral
// specification in test/fixtures/engine (black-box observations only).
import { createHash } from "node:crypto";
import path from "node:path";

/** First 16 hex chars of sha256(s). Used for fingerprints and message hashes. */
export function hash16(s) {
  return createHash("sha256").update(String(s), "utf8").digest("hex").slice(0, 16);
}

/** sha256 hex of a file's bytes (trust binding). */
export function fileHash(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Relativize p against cwd the way the ledger does: absolute paths become
 *  relative (possibly ../..), relative paths lose a leading ./, trailing
 *  slashes are stripped. */
export function relPath(cwd, p) {
  let q = String(p).replace(/\/+$/, "");
  if (q.startsWith("./")) q = q.slice(2);
  if (path.isAbsolute(q)) {
    const r = path.relative(cwd, q);
    return r === "" ? "." : r;
  }
  return q;
}

/** Split a shell command into tokens, respecting single/double quotes
 *  (quotes are stripped from the resulting tokens). */
export function tokenize(cmd) {
  const toks = [];
  const re = /"([^"]*)"|'([^']*)'|\S+/g;
  let m;
  while ((m = re.exec(cmd)) !== null) {
    toks.push(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[0]);
  }
  return toks;
}

/** Strip quoted spans, then cut a trailing # comment. Used before check
 *  classification so quoted text and comments can't fake a check. */
export function stripQuotesAndComments(cmd) {
  const dequoted = String(cmd)
    .replace(/"([^"\\]|\\.)*"/g, "")
    .replace(/'([^'\\]|\\.)*'/g, "");
  const hash = dequoted.indexOf("#");
  return hash === -1 ? dequoted : dequoted.slice(0, hash);
}

/** Last non-empty line of stdout (the "summary" recorded for commands). */
export function lastLine(s) {
  const lines = String(s ?? "").split("\n").filter((l) => l !== "");
  return lines.length ? lines[lines.length - 1] : "";
}

/** Parse JSONL text, skipping corrupt lines. */
export function parseJsonLines(text) {
  const out = [];
  for (const line of String(text).split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch {
      // corrupt lines are skipped on read
    }
  }
  return out;
}

/** Minimal glob matcher for config `ignore` patterns (*, **, ?). */
export function globMatch(pattern, str) {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += ".*";
        i++;
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${re}$`).test(str);
}
