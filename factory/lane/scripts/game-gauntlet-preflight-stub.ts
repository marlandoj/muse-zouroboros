/**
 * game-gauntlet-preflight-stub.ts — Local stand-ins for the game-gauntlet
 * preflight gates.
 *
 * The upstream modules (factory/game-gauntlet/scripts/game-*-preflight.ts)
 * are not vendored in this distribution. Each upstream gate is OFF by
 * default (env var unset) and only evaluates a game contract when explicitly
 * enabled. This stub replicates that contract:
 *
 * - Env var unset / "0" / "off" → { mode: "off", allowed: true, reason:
 *   "disabled" } (identical to upstream).
 * - Env var set to "1" / "enforce" → THROWS. Upstream would evaluate a game
 *   contract we cannot replicate here; silently allowing would bypass a
 *   requested gate, so we fail closed instead.
 * - Any other value → throws (invalid), same as upstream.
 *
 * If game-gauntlet support is needed, vendor factory/game-gauntlet and
 * repoint dispatcher.ts at the real modules.
 */

export type GameGateMode = "off" | "enforce";

function gateMode(
  env: Record<string, string | undefined>,
  varName: string,
): GameGateMode {
  const raw = env[varName]?.trim().toLowerCase();
  if (!raw || raw === "0" || raw === "off") return "off";
  if (raw === "1" || raw === "enforce") return "enforce";
  throw new Error(`Invalid ${varName} value: ${raw}`);
}

function notVendored(varName: string): Error {
  return new Error(
    `${varName} is set to enforce, but factory/game-gauntlet is not vendored ` +
      `in this distribution — refusing to bypass a requested game gate`,
  );
}

// ─── Seed ────────────────────────────────────────────────────────────────────

export interface GameSeedPreflightResult {
  mode: GameGateMode;
  allowed: boolean;
  contractPath: string | null;
  decisions: readonly { stage: string; allowed: boolean }[];
  reason: string;
}

export function runGameSeedPreflight(
  env: Record<string, string | undefined> = process.env,
): GameSeedPreflightResult {
  const mode = gateMode(env, "FACTORY_GAME_SEED_GATE");
  if (mode === "off") {
    return { mode, allowed: true, contractPath: null, decisions: [], reason: "disabled" };
  }
  throw notVendored("FACTORY_GAME_SEED_GATE");
}

export function gameSeedPreflightSummary(result: GameSeedPreflightResult): string {
  const stages = result.decisions.map((d) => `${d.stage}:${d.allowed ? "pass" : "blocked"}`);
  return (
    `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}` +
    (stages.length > 0 ? ` stages=${stages.join(",")}` : "")
  );
}

// ─── Manifest ────────────────────────────────────────────────────────────────

export interface GameManifestPreflightResult {
  mode: GameGateMode;
  allowed: boolean;
  roundPath: string | null;
  decision: { allowed: boolean; reason: string } | null;
  reason: string;
}

export function runGameManifestPreflight(
  env: Record<string, string | undefined> = process.env,
): GameManifestPreflightResult {
  const mode = gateMode(env, "FACTORY_GAME_MANIFEST_GATE");
  if (mode === "off") {
    return { mode, allowed: true, roundPath: null, decision: null, reason: "disabled" };
  }
  throw notVendored("FACTORY_GAME_MANIFEST_GATE");
}

export function gameManifestPreflightSummary(result: GameManifestPreflightResult): string {
  return `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}`;
}

// ─── Harness ─────────────────────────────────────────────────────────────────

export interface GameHarnessPreflightResult {
  mode: GameGateMode;
  allowed: boolean;
  certificationPath: string | null;
  decision: { allowed: boolean; reason: string } | null;
  reason: string;
}

export function runGameHarnessPreflight(
  env: Record<string, string | undefined> = process.env,
): GameHarnessPreflightResult {
  const mode = gateMode(env, "FACTORY_GAME_HARNESS_GATE");
  if (mode === "off") {
    return { mode, allowed: true, certificationPath: null, decision: null, reason: "disabled" };
  }
  throw notVendored("FACTORY_GAME_HARNESS_GATE");
}

export function gameHarnessPreflightSummary(result: GameHarnessPreflightResult): string {
  return `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}`;
}

// ─── Score ───────────────────────────────────────────────────────────────────

export interface GameScorePreflightResult {
  mode: GameGateMode;
  allowed: boolean;
  reportPath: string | null;
  report: { score: number } | null;
  reason: string;
}

export function runGameScorePreflight(
  env: Record<string, string | undefined> = process.env,
): GameScorePreflightResult {
  const mode = gateMode(env, "FACTORY_GAME_SCORE_GATE");
  if (mode === "off") {
    return { mode, allowed: true, reportPath: null, report: null, reason: "disabled" };
  }
  throw notVendored("FACTORY_GAME_SCORE_GATE");
}

export function gameScorePreflightSummary(result: GameScorePreflightResult): string {
  return `${result.mode} ${result.allowed ? "allowed" : "blocked"} reason=${result.reason}`;
}
