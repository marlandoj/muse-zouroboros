// Mode resolution for the Verity hook: the one implementation behind
// `engine/cli.js mode`, consumed by scripts/verity-hook.sh, scripts/verity.sh
// and the orchestrator's gates report.
//
// Reproduces the hook's jq expressions exactly (jq 1.8 semantics):
//   mode   = VERITY_MODE   > .harness[h].mode   > .mode   > "shadow"
//   checks = VERITY_CHECKS > .harness[h].checks > .checks > ["all"]
// over $VERITY_HOME/config.json (VERITY_HOME defaults to $HOME/.verity).
// An env override counts only when non-empty. A config value counts unless
// it is null or false. A config that is absent, unreadable or not JSON, or
// whose path has the wrong shape (a type error in jq), resolves to
// shadow / all; so does a checks value that is not a list of scalars, and
// an empty checks list. VERITY_DISABLE=1 is not a mode: it is reported as
// `disabled` (the hook then skips the engine; live mode fails closed).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

class ShapeError extends Error {}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// jq `.[key]` on null is null; on an object it is the member or null;
// on anything else it is an error.
function idx(v, key) {
  if (v === null || v === undefined) return null;
  if (!isObj(v)) throw new ShapeError(key);
  return Object.prototype.hasOwnProperty.call(v, key) ? v[key] : null;
}

// jq truthiness for `//`: anything but null and false.
function present(v) {
  return v !== null && v !== undefined && v !== false;
}

// What `jq -r` prints for a value, as captured by $(...) (trailing newlines dropped).
function raw(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.replace(/\n+$/, "");
}

// jq `join(",")`: null -> "", strings as-is, numbers/booleans as JSON; anything else errors.
function join(list) {
  if (!Array.isArray(list)) throw new ShapeError("join");
  return list
    .map((x) => {
      if (x === null) return "";
      if (typeof x === "string") return x;
      if (typeof x === "number" || typeof x === "boolean") return JSON.stringify(x);
      throw new ShapeError("join");
    })
    .join(",");
}

/** Read and parse the config the hook reads; { path, state, cfg }. */
export function readModeConfig(env = process.env) {
  const vhome = env.VERITY_HOME || path.join(env.HOME || os.homedir(), ".verity");
  const file = path.join(vhome, "config.json");
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    return { path: file, state: "absent", cfg: null };
  }
  // verity-hook.sh: [ -f "$cfg" ] || cfg=/dev/null (a non-file reads as no config)
  if (!st.isFile()) return { path: file, state: "absent", cfg: null };
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { path: file, state: "unreadable", cfg: null };
  }
  // jq on an empty file prints nothing: the hook falls back to shadow / all.
  if (text.trim() === "") return { path: file, state: "empty", cfg: null };
  try {
    return { path: file, state: "ok", cfg: JSON.parse(text) };
  } catch {
    return { path: file, state: "invalid", cfg: null };
  }
}

function layered(cfg, harness, key, fallback) {
  // .harness[$h].<key> // .<key> // fallback, all-or-nothing on a shape error.
  // harness === null reads the global layer only (.<key> // fallback).
  try {
    if (harness !== null) {
      const hv = idx(idx(idx(cfg, "harness"), harness), key);
      if (present(hv)) return { value: hv, source: "harness" };
    }
    const gv = idx(cfg, key);
    if (present(gv)) return { value: gv, source: "global" };
    return { value: fallback, source: "default" };
  } catch (e) {
    if (e instanceof ShapeError) return { value: fallback, source: "default", shapeError: true };
    throw e;
  }
}

function modeOf(cfg, harness) {
  const r = layered(cfg, harness, "mode", "shadow");
  const m = raw(r.value);
  return m === "" ? { value: "shadow", source: "default" } : { value: m, source: r.source };
}

function checksOf(cfg, harness) {
  const r = layered(cfg, harness, "checks", ["all"]);
  let s;
  try {
    s = join(r.value);
  } catch (e) {
    if (!(e instanceof ShapeError)) throw e;
    s = "";
  }
  return s === "" ? { value: "all", source: "default" } : { value: s, source: r.source };
}

/**
 * The resolved posture for one harness, as the hook applies it.
 * `mode` / `checks` are effective (env applied); `configured` is the file
 * layers only; `global` is the file's global layer.
 */
export function resolveMode(harness = "claude", env = process.env) {
  const { path: file, state, cfg } = readModeConfig(env);
  const cm = modeOf(cfg, harness);
  const cc = checksOf(cfg, harness);
  const gm = modeOf(cfg, null);
  const gc = checksOf(cfg, null);
  const envMode = env.VERITY_MODE || "";
  const envChecks = env.VERITY_CHECKS || "";
  const mode = envMode ? { value: envMode, source: "env" } : cm;
  const checks = envChecks ? { value: envChecks, source: "env" } : cc;
  let override = false;
  try {
    override = present(idx(idx(cfg, "harness"), harness));
  } catch {
    override = false;
  }
  return {
    harness,
    mode: mode.value,
    checks: checks.value.split(","),
    disabled: env.VERITY_DISABLE === "1",
    source: { mode: mode.source, checks: checks.source },
    configured: { mode: cm.value, checks: cc.value.split(","), source: { mode: cm.source, checks: cc.source } },
    global: { mode: gm.value, checks: gc.value.split(",") },
    override,
    env: {
      VERITY_MODE: env.VERITY_MODE ?? null,
      VERITY_CHECKS: env.VERITY_CHECKS ?? null,
      VERITY_DISABLE: env.VERITY_DISABLE ?? null,
    },
    config: { path: file, state },
  };
}
