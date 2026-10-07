#!/usr/bin/env bun
// catalog-byok.ts — Zo BYOK model catalog for the MoA/consensus-gate lineup.
//
// Zo BYOK configs (Claude Code / Codex subscriptions, plus ad-hoc key configs)
// have NO server-side listing API — /models and /byok/* reject server tokens
// (frontend-session auth only). So the source of truth is an operator-editable
// registry (assets/byok-registry.json) and --refresh PROBES each entry via
// /zo/ask to confirm the config is still live (UUIDs rotate when the user
// recreates a config — a dead config returns HTTP 400 "not found").
//
// Subscription models (Claude Code / Codex) are flat-rate, so pricing is
// recorded as 0 — combined with the zo-byok provider rank in lineup-picker,
// they take precedence over usage-billed Opencode/OpenRouter candidates.
// Ids are namespaced `byok:<uuid>` (disjoint from hf:/oc:/xai:), routed back
// to /zo/ask by consensus-gate.ts.
import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { type Tier, type ClassifiedModel, type CatalogCache, classifyOpenWeights } from "./catalog";
import { sameCanonicalModel } from "./model-identity";

const CACHE_PATH = `${process.env.HOME}/.zouroboros/byok-catalog.json`;
const REGISTRY_PATH = path.resolve(__dirname, "../assets/byok-registry.json");
const STALE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;
const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
const PROBE_TIMEOUT_MS = 90_000;

export interface ByokRegistryEntry {
  id: string | null;
  label: string;
  family: string;
  tier: Tier;
  subscription: boolean;
  pending?: string;
}

export interface ByokClassifiedModel extends ClassifiedModel {
  label: string;
  subscription: boolean;
}

export function loadRegistry(): ByokRegistryEntry[] {
  const raw = JSON.parse(fs.readFileSync(REGISTRY_PATH, "utf-8"));
  return (raw.models ?? []) as ByokRegistryEntry[];
}

function classify(e: ByokRegistryEntry): ByokClassifiedModel {
  return {
    id: e.id!,
    context_length: 0,
    pricing: { prompt: "0", completion: "0" },
    family: e.family,
    tier: e.tier,
    promptCost: 0,
    completionCost: 0,
    label: e.label,
    subscription: e.subscription,
    ...classifyOpenWeights({ id: e.id! }),
  };
}

export async function probeAlive(id: string, attempt = 0): Promise<{ alive: boolean; detail: string }> {
  const zoToken = process.env.ZO_CLIENT_IDENTITY_TOKEN || process.env.ZO_TOKEN || "";
  if (!zoToken) return { alive: false, detail: "no ZO token in env" };
  try {
    const resp = await fetch(ZO_ASK_URL, {
      method: "POST",
      headers: { authorization: zoToken, "content-type": "application/json" },
      body: JSON.stringify({ input: "Reply with exactly: OK", model_name: id }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "");
      // 429 = workspace /zo/ask concurrency cap — transient, never "dead". Retry with backoff.
      if ((resp.status === 429 || resp.status >= 500) && attempt < 2) {
        await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
        return probeAlive(id, attempt + 1);
      }
      return { alive: false, detail: `HTTP ${resp.status}: ${body.slice(0, 100)}` };
    }
    const data = (await resp.json()) as { output?: string };
    const out = (data.output ?? "").trim();
    if (out) return { alive: true, detail: out.slice(0, 40) };
    // A 200 carrying an empty body is transient — an upstream hiccup or a
    // classifier soft-block — not a dead config, so retry it like 429/5xx
    // instead of evicting. Opus 4.8 was dropped from the catalog on a single
    // such response while answering "OK" on every probe seconds later, and an
    // evicted entry is unpickable until the next refresh.
    if (attempt < 2) {
      await new Promise((r) => setTimeout(r, 5_000 * (attempt + 1)));
      return probeAlive(id, attempt + 1);
    }
    return { alive: false, detail: "empty output (3 attempts)" };
  } catch (err: any) {
    return { alive: false, detail: err.message };
  }
}

// Probe every registered (non-pending) entry; only live configs enter the cache.
export async function fetchLiveCatalog(): Promise<ByokClassifiedModel[]> {
  const entries = loadRegistry();
  const registered = entries.filter((e) => e.id);
  const pending = entries.filter((e) => !e.id);
  if (pending.length) {
    console.warn(`⚠️  ${pending.length} registry entr${pending.length === 1 ? "y" : "ies"} pending UUID capture: ${pending.map((e) => e.label).join(", ")}`);
  }
  const alive: ByokClassifiedModel[] = [];
  // Probe in chunks of 4: the workspace allows only 5 concurrent /zo/ask
  // requests, and blasting all entries at once 429s the overflow into
  // false "dead" verdicts.
  const results: { e: ByokRegistryEntry; probe: { alive: boolean; detail: string } }[] = [];
  for (let i = 0; i < registered.length; i += 4) {
    const chunk = registered.slice(i, i + 4);
    results.push(...(await Promise.all(chunk.map(async (e) => ({ e, probe: await probeAlive(e.id!) })))));
  }
  for (const { e, probe } of results) {
    if (probe.alive) {
      alive.push(classify(e));
      console.log(`✅ ${e.label} (${e.id}) live`);
    } else {
      console.warn(`❌ ${e.label} (${e.id}) dead: ${probe.detail}`);
    }
  }
  return alive;
}

export function writeCache(models: ByokClassifiedModel[]): CatalogCache {
  const cache: CatalogCache = {
    fetched_at: new Date().toISOString(),
    source: REGISTRY_PATH,
    models,
    chains: {},
  };
  fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  return cache;
}

export function loadCachedCatalog(): CatalogCache | null {
  if (!fs.existsSync(CACHE_PATH)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf-8")) as CatalogCache;
    const age = Date.now() - Date.parse(raw.fetched_at);
    if (!Number.isFinite(age) || age > STALE_AFTER_MS) return null;
    return raw;
  } catch {
    return null;
  }
}

/** Label lookup for renderers (lineup-picker displayName). */
export function byokLabels(): Map<string, string> {
  const out = new Map<string, string>();
  const cache = loadCachedCatalog();
  for (const m of (cache?.models ?? []) as ByokClassifiedModel[]) {
    if (m.label) out.set(m.id, m.label);
  }
  // Registry is authoritative even when the cache is stale/absent.
  try {
    for (const e of loadRegistry()) if (e.id) out.set(e.id, e.label);
  } catch {}
  return out;
}

/** Find a live byok twin for an hf:/oc: model by normalized name match. */
export function mapToByokTwin(modelId: string): string | null {
  const cache = loadCachedCatalog();
  if (!cache) return null;
  for (const m of (cache.models ?? []) as ByokClassifiedModel[]) {
    if (m.label && sameCanonicalModel(modelId, { id: m.id, label: m.label, family: m.family })) return m.id;
  }
  return null;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: { refresh: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
  });
  if (values.refresh) {
    const models = await fetchLiveCatalog();
    const cache = writeCache(models);
    console.log(`\n📦 Cached ${models.length} live byok model(s) → ${CACHE_PATH}`);
    if (values.json) console.log(JSON.stringify(cache, null, 2));
  } else {
    const cache = loadCachedCatalog();
    if (!cache) {
      console.log("No fresh byok catalog cache. Run with --refresh.");
      process.exit(1);
    }
    if (values.json) console.log(JSON.stringify(cache, null, 2));
    else for (const m of cache.models as ByokClassifiedModel[]) console.log(`${m.id}  ${m.label}  [${m.family}/${m.tier}]${m.subscription ? " (subscription)" : ""}`);
  }
}
