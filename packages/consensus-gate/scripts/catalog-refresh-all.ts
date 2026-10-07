#!/usr/bin/env bun
// Unified daily refresh orchestrator. Refreshes every provider catalog and fans
// the result out to both consumers:
//   1. Synthetic.new  → ~/.zouroboros/synthetic-catalog.json (consensus-gate chains)
//   2. OpenRouter     → ~/.zouroboros/openrouter-catalog.json (consensus-gate chains)
//   3. Opencode Zen   → ~/.zouroboros/opencode-catalog.json (consensus-gate chains)
//   4. Zo BYOK        → ~/.zouroboros/byok-catalog.json (lineup + twin failover)
//   5. Kimi            → ~/.zouroboros/kimi-catalog.json (direct Moonshot routes)
//   6. tier-resolver  → data/external-models.json (advisory external pool)
//
// Emits a machine-readable summary so the scheduling agent can email only on a
// non-zero diff, a broken quorum, or a provider error.
import * as path from "path";
import * as fs from "fs";
import {
  fetchLiveCatalog as fetchSynthetic,
  writeCache as writeSynthetic,
  loadCachedCatalog as loadSynthetic,
  diffCatalog,
  getChain,
  type CatalogCache,
  type DiffSummary,
} from "./catalog";
import {
  fetchLiveCatalog as fetchOpenRouter,
  writeCache as writeOpenRouter,
  loadCachedCatalog as loadOpenRouter,
} from "./catalog-openrouter";
import {
  fetchLiveCatalog as fetchOpencode,
  writeCache as writeOpencode,
  loadCachedCatalog as loadOpencode,
} from "./catalog-opencode";
import {
  fetchLiveCatalog as fetchByok,
  writeCache as writeByok,
  loadCachedCatalog as loadByok,
} from "./catalog-byok";
import {
  fetchLiveCatalog as fetchKimi,
  writeCache as writeKimi,
  loadCachedCatalog as loadKimi,
} from "./catalog-kimi";
import { seedProvisional } from "./provisional-candidates";
import {
  lineupPathFor,
  loadPersistedLineup,
  type LineupProfile,
  type PersistedLineup,
} from "./lineup-picker";

const DEFAULT_QUORUM = [
  "hf:zai-org/GLM-5.2",
  "hf:moonshotai/Kimi-K2.7-Code",
  "hf:MiniMaxAI/MiniMax-M3",
];
const SYNC_SCRIPT = path.resolve(__dirname, "./tier-resolver-sync.ts");
const LINEUP_SCRIPT = path.resolve(__dirname, "./lineup-picker.ts");
export const LINEUP_PROFILES: readonly LineupProfile[] = [
  "flagship",
  "open-weights",
  "fast",
  "coder",
  "judge",
];

interface ProviderResult {
  provider: string;
  ok: boolean;
  modelCount: number;
  totalChanges: number;
  diff: DiffSummary | null;
  error: string | null;
}

async function refreshProvider(
  provider: string,
  load: () => CatalogCache | null,
  fetchLive: () => Promise<any[]>,
  write: (models: any[]) => CatalogCache,
  enrollProvisional = true,
): Promise<ProviderResult> {
  try {
    const prev = load();
    const models = await fetchLive();
    const next = write(models);
    const diff = diffCatalog(prev, next);
    const totalChanges =
      diff.added.length + diff.removed.length + diff.priceChanges.length + diff.chainChanges.length;
    console.log(`✅ ${provider}: cached ${models.length} models (${totalChanges} changes)`);
    if (diff.added.length) console.log(`   + ${diff.added.length} added`);
    if (diff.removed.length) console.log(`   − ${diff.removed.length} removed`);
    if (diff.priceChanges.length) console.log(`   Δ ${diff.priceChanges.length} price changes`);
    // ZOU-484: auto-enroll genuinely-new models as provisional candidates.
    if (enrollProvisional && diff.added.length) {
      const provName = provider.replace(/\.new$/, "");
      const seeded = seedProvisional(provName, diff.added, models);
      if (seeded.length) console.log(`   ⚑ ${seeded.length} provisional candidate(s) enrolled`);
    }
    return { provider, ok: true, modelCount: models.length, totalChanges, diff, error: null };
  } catch (err: any) {
    console.error(`❌ ${provider}: ${err.message}`);
    return { provider, ok: false, modelCount: 0, totalChanges: 0, diff: null, error: err.message };
  }
}

function runTierSync(): { ok: boolean; output: string } {
  const proc = Bun.spawnSync(["bun", SYNC_SCRIPT, "sync"], { stdout: "pipe", stderr: "pipe" });
  const output = new TextDecoder().decode(proc.stdout) + new TextDecoder().decode(proc.stderr);
  console.log(output.trim());
  return { ok: proc.exitCode === 0, output };
}

export interface LineupRefreshResult {
  profile: LineupProfile;
  ok: boolean;
  output: string;
  error: string | null;
}

interface SpawnResult {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export type LineupSpawner = (args: string[]) => SpawnResult;

export interface PickerOutput {
  valid: true;
  profile: LineupProfile;
  lineup: {
    proposers: string[];
    aggregator: string;
    generatedAt: string;
  };
}

export type LineupArtifactVerifier = (
  profile: LineupProfile,
  pickerOutput: PickerOutput,
) => string | null;

const spawnLineup: LineupSpawner = (args) =>
  Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });

function validatePickerOutput(value: unknown, profile: LineupProfile): string | null {
  if (!value || typeof value !== "object") return "picker output is not an object";
  const output = value as Partial<PickerOutput> & { blockers?: unknown };
  if (output.valid !== true) {
    const blockers = Array.isArray(output.blockers)
      ? output.blockers.filter((blocker): blocker is string => typeof blocker === "string" && blocker.length > 0)
      : [];
    return blockers.length
      ? `picker reported valid=false: ${blockers.join("; ")}`
      : "picker reported valid=false";
  }
  if (output.profile !== profile) {
    return `picker profile mismatch: expected ${profile}, got ${String(output.profile)}`;
  }
  if (!output.lineup || typeof output.lineup !== "object") return "picker lineup is missing";
  const { proposers, aggregator, generatedAt } = output.lineup;
  if (!Array.isArray(proposers) || proposers.length === 0 || !proposers.every((id) => typeof id === "string" && id.length > 0)) {
    return "picker lineup has invalid proposers";
  }
  if (new Set(proposers).size !== proposers.length) return "picker lineup has duplicate proposers";
  if (typeof aggregator !== "string" || aggregator.length === 0 || proposers.includes(aggregator)) {
    return "picker lineup has invalid aggregator";
  }
  if (typeof generatedAt !== "string" || generatedAt.length === 0) return "picker lineup has invalid generatedAt";
  return null;
}

export function verifyPersistedArtifact(
  profile: LineupProfile,
  pickerOutput: PickerOutput,
  resolvePath: (profile: LineupProfile) => string = lineupPathFor,
): string | null {
  const artifactPath = resolvePath(profile);
  let persisted: unknown;
  try {
    persisted = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
  } catch (err) {
    return `artifact readback failed at ${artifactPath}: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (!persisted || typeof persisted !== "object") return `artifact at ${artifactPath} is not an object`;
  const record = persisted as { valid?: unknown; profile?: unknown; lineup?: unknown };
  const envelopeError = validatePickerOutput(
    { valid: record.valid, profile: record.profile, lineup: record.lineup },
    profile,
  );
  if (envelopeError) return `artifact validation failed at ${artifactPath}: ${envelopeError}`;
  const generatedAt = (record.lineup as { generatedAt?: unknown }).generatedAt;
  if (generatedAt !== pickerOutput.lineup.generatedAt) {
    return `artifact fingerprint mismatch at ${artifactPath}: generatedAt differs from picker output`;
  }
  return null;
}

export function runLineupPersist(
  profile: LineupProfile,
  spawn: LineupSpawner = spawnLineup,
  verifyArtifact: LineupArtifactVerifier = verifyPersistedArtifact,
): LineupRefreshResult {
  if (spawn === spawnLineup && shouldSkipPinnedRefresh(loadPersistedLineup(profile))) {
    console.log(`ℹ️  Lineup [${profile}] is operator-pinned; automatic refresh skipped`);
    return { profile, ok: true, output: "", error: null };
  }
  let proc: SpawnResult;
  try {
    proc = spawn(["bun", LINEUP_SCRIPT, "--profile", profile, "--json"]);
  } catch (err) {
    const error = `picker spawn failed: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`⚠️  Lineup picker [${profile}] failed (${error}) — last-good lineup preserved`);
    return { profile, ok: false, output: "", error };
  }
  const stdout = new TextDecoder().decode(proc.stdout);
  const stderr = new TextDecoder().decode(proc.stderr);
  const output = stdout + stderr;

  if (proc.exitCode !== 0) {
    const error = `picker exited ${proc.exitCode}`;
    console.error(`⚠️  Lineup picker [${profile}] failed (${error}) — last-good lineup preserved`);
    return { profile, ok: false, output, error };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    const error = `invalid JSON: ${err instanceof Error ? err.message : String(err)}`;
    console.error(`⚠️  Lineup picker [${profile}] failed (${error}) — last-good lineup preserved`);
    return { profile, ok: false, output, error };
  }

  const validationError = validatePickerOutput(parsed, profile);
  if (validationError) {
    const error = validationError;
    console.error(`⚠️  Lineup picker [${profile}] failed (${error}) — last-good lineup preserved`);
    return { profile, ok: false, output, error };
  }

  const pickerOutput = parsed as PickerOutput;
  const artifactError = verifyArtifact(profile, pickerOutput);
  if (artifactError) {
    console.error(`⚠️  Lineup picker [${profile}] failed (${artifactError}) — last-good lineup preserved`);
    return { profile, ok: false, output, error: artifactError };
  }

  const lineup = pickerOutput.lineup;
  console.log(
    `✅ Lineup [${profile}] persisted: ${lineup?.proposers?.length ?? 0} proposers, aggregator=${String(lineup?.aggregator ?? "")}`,
  );
  return { profile, ok: true, output, error: null };
}

export function shouldSkipPinnedRefresh(persisted: PersistedLineup | null): boolean {
  return persisted?.valid === true && persisted.lineup.pinned === true;
}

export function refreshAllLineups(
  spawn: LineupSpawner = spawnLineup,
  verifyArtifact: LineupArtifactVerifier = verifyPersistedArtifact,
): LineupRefreshResult[] {
  return LINEUP_PROFILES.map((profile) => runLineupPersist(profile, spawn, verifyArtifact));
}

export function summarizeLineups(results: LineupRefreshResult[]) {
  return {
    lineup_ok: results.every((result) => result.ok),
    lineup_profiles: results.map(({ profile, ok, error }) => ({ profile, ok, error })),
  };
}

function validateQuorum(): { ok: boolean; broken: string[] } {
  const broken: string[] = [];
  for (const id of DEFAULT_QUORUM) {
    if (getChain(id).length === 0) broken.push(id);
  }
  if (broken.length) console.error(`⚠️  Broken quorum (no chain): ${broken.join(", ")}`);
  else console.log(`✅ Quorum intact: ${DEFAULT_QUORUM.length} primaries have non-empty chains`);
  return { ok: broken.length === 0, broken };
}

async function main() {
  console.log("🔄 Provider catalog refresh — all providers + consumers\n");

  const results: ProviderResult[] = [];
  results.push(
    await refreshProvider("synthetic.new", loadSynthetic, fetchSynthetic, writeSynthetic),
  );
  results.push(
    await refreshProvider("openrouter", loadOpenRouter, fetchOpenRouter, writeOpenRouter),
  );
  results.push(
    await refreshProvider("opencode", loadOpencode, fetchOpencode, writeOpencode),
  );
  results.push(
    await refreshProvider("zo-byok", loadByok, fetchByok, writeByok, false),
  );
  results.push(
    await refreshProvider("kimi", loadKimi, fetchKimi, writeKimi),
  );

  console.log("");
  const tierSync = runTierSync();

  console.log("");
  const lineups = refreshAllLineups();
  const lineupSummary = summarizeLineups(lineups);

  console.log("");
  const quorum = validateQuorum();

  const totalChanges = results.reduce((a, r) => a + r.totalChanges, 0);
  const providerErrors = results.filter((r) => !r.ok).map((r) => r.provider);
  const actionNeeded = totalChanges > 0 || !quorum.ok || providerErrors.length > 0 || !tierSync.ok || !lineupSummary.lineup_ok;

  const summary = {
    action_needed: actionNeeded,
    total_changes: totalChanges,
    provider_errors: providerErrors,
    quorum_broken: quorum.broken,
    tier_sync_ok: tierSync.ok,
    ...lineupSummary,
    providers: results.map((r) => ({
      provider: r.provider,
      ok: r.ok,
      models: r.modelCount,
      changes: r.totalChanges,
      added: r.diff?.added ?? [],
      removed: r.diff?.removed ?? [],
      price_changes: r.diff?.priceChanges.map((p) => p.id) ?? [],
    })),
  };
  console.log("\n" + JSON.stringify(summary));

  // Exit non-zero only on hard failure (provider error, broken quorum, failed
  // sync, or failed lineup refresh) so the agent can distinguish an
  // informational catalog change from a refresh that needs intervention.
  if (providerErrors.length || !quorum.ok || !tierSync.ok || !lineupSummary.lineup_ok) process.exit(1);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`❌ orchestrator: ${err.message}`);
    process.exit(1);
  });
}
