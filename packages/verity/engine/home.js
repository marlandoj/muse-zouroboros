// Home directory resolution for the Verity engine.
// VERITY_ENGINE_HOME wins; otherwise ~/.verity/engine. When settling on the
// default home for the first time, existing sessions are migrated from
// ~/.canny automatically.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_HOME = path.join(os.homedir(), ".verity", "engine");
export const LEGACY_HOME = path.join(os.homedir(), ".canny");

export function resolveHome() {
  if (process.env.VERITY_ENGINE_HOME) return process.env.VERITY_ENGINE_HOME;
  return DEFAULT_HOME;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(p, 0o700);
  } catch {
    // best effort on odd filesystems
  }
}

export function sessionsDir(home) {
  return path.join(home, "sessions");
}

/** Copy legacy sessions + trust marker into a fresh default home. */
export function migrateIfNeeded(home) {
  if (home !== DEFAULT_HOME) return;
  const dest = sessionsDir(home);
  if (fs.existsSync(dest)) return;
  const src = sessionsDir(LEGACY_HOME);
  if (!fs.existsSync(src)) return;
  ensureDir(dest);
  for (const f of fs.readdirSync(src)) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      fs.copyFileSync(path.join(src, f), path.join(dest, f));
      fs.chmodSync(path.join(dest, f), 0o600);
    } catch {
      // keep going; a partial migration still beats none
    }
  }
  for (const f of ["trusted.json"]) {
    const s = path.join(LEGACY_HOME, f);
    const d = path.join(home, f);
    if (fs.existsSync(s) && !fs.existsSync(d)) {
      try {
        fs.copyFileSync(s, d);
        fs.chmodSync(d, 0o600);
      } catch {
        // ignore
      }
    }
  }
}

export { ensureDir };
