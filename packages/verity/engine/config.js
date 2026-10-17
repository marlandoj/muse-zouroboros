// Project config: <cwd>/.verity.json, gated by `trust`.
// trust records sha256(<abspath>) in $HOME/trusted.json; a config only
// takes effect when its content hash still matches. The agent runs as the
// user and can weaken its own config — documented limitation, not a bug:
// the threat model is premature "done", not malicious subversion.
//
// Scoping (observed): `verify` patterns and `allow` are resolved by walking
// up from the event's cwd; `ignore` globs are global — the union of every
// trusted config's ignore list applies to every event.
import fs from "node:fs";
import path from "node:path";
import { fileHash } from "./util.js";
import { ensureDir } from "./home.js";

const CONFIG_NAME = ".verity.json";
const LEGACY_CONFIG_NAME = ".canny.json";

function trustedFile(home) {
  return path.join(home, "trusted.json");
}

export function loadTrusted(home) {
  try {
    return JSON.parse(fs.readFileSync(trustedFile(home), "utf8"));
  } catch {
    return {};
  }
}

/** Parse a config file only if its trust binding still matches. */
function loadIfTrusted(trusted, file) {
  let raw;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return null;
  }
  if (trusted[file] !== fileHash(raw)) return null;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
}

/** Walk up from cwd looking for .verity.json (or legacy .verity.json). Returns abspath or null. */
export function findConfigFile(cwd) {
  let dir = path.resolve(cwd);
  for (;;) {
    const cand = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(cand)) return cand;
    const legacy = path.join(dir, LEGACY_CONFIG_NAME);
    if (fs.existsSync(legacy)) return legacy;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Effective config for a hook event:
 * { verifyPatterns, allowSecrets, ignoreGlobs, releaseValve }.
 *
 * releaseValve gates the Stop-hook "release valve" (a repeated stop with no
 * new facts after a block degrading to a warning). It defaults to false:
 * fail closed. A project opts in explicitly via its trusted .verity.json,
 * bound with `verity trust` by the operator.
 */
export function loadEffectiveConfig(home, cwd) {
  const out = { verifyPatterns: [], allowSecrets: false, ignoreGlobs: [], releaseValve: false };
  const trusted = loadTrusted(home);
  // Global: every trusted config contributes its ignore globs.
  for (const file of Object.keys(trusted)) {
    const cfg = loadIfTrusted(trusted, file);
    if (cfg && Array.isArray(cfg.ignore)) {
      for (const p of cfg.ignore) {
        if (typeof p === "string" && !out.ignoreGlobs.includes(p)) out.ignoreGlobs.push(p);
      }
    }
  }
  // Cwd-scoped: verify patterns and allow flags.
  const file = findConfigFile(cwd);
  if (!file) return out;
  const cfg = loadIfTrusted(trusted, file);
  if (!cfg) return out;
  if (Array.isArray(cfg.verify)) {
    out.verifyPatterns = cfg.verify.filter((p) => typeof p === "string");
  }
  if (Array.isArray(cfg.allow) && cfg.allow.includes("secrets")) out.allowSecrets = true;
  if (cfg.releaseValve === true) out.releaseValve = true;
  return out;
}

/** `trust` subcommand: bind the cwd's .verity.json by content hash. */
export function trustCwd(home, cwd) {
  const file = findConfigFile(cwd);
  if (!file) {
    return { ok: false, text: `no .verity.json at or above ${path.resolve(cwd)}` };
  }
  const raw = fs.readFileSync(file);
  const trusted = loadTrusted(home);
  trusted[file] = fileHash(raw);
  ensureDir(home);
  const dest = trustedFile(home);
  fs.writeFileSync(dest, JSON.stringify(trusted, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    // best effort
  }
  let cfg = null;
  try {
    cfg = JSON.parse(raw.toString("utf8"));
  } catch {
    // ignore
  }
  const feats = [];
  if (cfg) {
    if (Array.isArray(cfg.verify) && cfg.verify.length) feats.push("verify");
    if (Array.isArray(cfg.ignore) && cfg.ignore.length) feats.push("ignore");
    if (Array.isArray(cfg.allow) && cfg.allow.length) feats.push("allow");
    if (cfg.releaseValve === true) feats.push("releaseValve");
  }
  const text = feats.length
    ? `trusted ${file}: ${feats.join(", ")} now take effect`
    : `trusted ${file}`;
  return { ok: true, text };
}
