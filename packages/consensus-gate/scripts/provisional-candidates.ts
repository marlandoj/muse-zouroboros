#!/usr/bin/env bun
// provisional-candidates.ts — ZOU-484 (Vetting loop 1/3): Discovery → provisional enrollment.
//
// When a provider surfaces a new model, automatically enroll it as a *provisional*
// candidate instead of requiring a human to hand-edit the quorum/pool. Provisional
// models are candidates ONLY — they never enter DEFAULT_QUORUM / DEFAULT_MOA until
// they pass the cold-start probe (ZOU-485) and earn shadow promotion (ZOU-486).
//
// Primary entry point: the daily catalog-refresh-all.ts hooks `seedProvisional()`
// after each provider diff, so genuinely-new models (diffCatalog().added) become
// provisional candidates automatically. Standalone `discover` seeds any catalog
// model not yet tracked (idempotent by id).
//
// Usage:
//   bun provisional-candidates.ts discover           # seed untracked catalog models
//   bun provisional-candidates.ts discover --json     # machine-readable
//   bun provisional-candidates.ts list [--json]      # all candidates
//   bun provisional-candidates.ts show <id>          # one candidate
//   bun provisional-candidates.ts --help
//
// Store: ~/.zouroboros/provisional-candidates.json

import { parseArgs } from "util";
import * as fs from "fs";
import { type Tier, type ClassifiedModel } from "./catalog";
import { canonicalModelFamily } from "./model-identity";

const STORE_PATH = `${process.env.HOME}/.zouroboros/provisional-candidates.json`;

export type CandidateStatus = "provisional" | "cold-start-passed" | "shadow" | "promoted" | "rejected";

export interface ProvisionalRecord {
  id: string;            // gate-prefixed id (hf:…, oc:…, or:…)
  family: string;        // vendor family (glm, kimi, claude, deepseek, …)
  tier: Tier;            // flagship | fast | coder
  provider: string;      // synthetic | openrouter | opencode
  firstSeen: string;     // ISO timestamp
  status: CandidateStatus;
  coldStartScore: number | null;  // set by ZOU-485
  promotedAt: string | null;       // set by ZOU-486
}

function familyOf(id: string): string {
  return canonicalModelFamily(id);
}

function tierOf(id: string): Tier {
  if (/codex|coder|(^|[-_])code([-_]|$)/i.test(id)) return "coder";
  if (/mini|nano|flash|haiku|lite|small|spark|free/i.test(id)) return "fast";
  return "flagship";
}

function loadStore(): ProvisionalRecord[] {
  if (!fs.existsSync(STORE_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, "utf-8")) as ProvisionalRecord[];
  } catch {
    return [];
  }
}

function saveStore(records: ProvisionalRecord[]): void {
  fs.mkdirSync(STORE_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(records, null, 2));
}

/** Load all provisional candidate records. */
export function loadCandidates(): ProvisionalRecord[] {
  return loadStore();
}

/** Look up a single candidate by gate-prefixed id. */
export function getCandidate(id: string): ProvisionalRecord | undefined {
  return loadStore().find((r) => r.id === id);
}

/**
 * Update a candidate's status (and optional extra fields). Used by the
 * cold-start probe (ZOU-485) to record a score + pass/fail, and by the
 * shadow-promotion lane (ZOU-486) to advance vetted candidates.
 */
export function updateCandidateStatus(
  id: string,
  status: CandidateStatus,
  extra?: Partial<Pick<ProvisionalRecord, "coldStartScore" | "promotedAt">>,
): void {
  const store = loadStore();
  const rec = store.find((r) => r.id === id);
  if (!rec) return;
  rec.status = status;
  if (extra?.coldStartScore !== undefined) rec.coldStartScore = extra.coldStartScore;
  if (extra?.promotedAt !== undefined) rec.promotedAt = extra.promotedAt;
  saveStore(store);
}

/**
 * Seed provisional records for genuinely-new models. Idempotent: re-running with
 * the same added ids does not duplicate candidates. Returns the records created
 * in this call (empty if all already tracked).
 */
export function seedProvisional(
  provider: string,
  addedIds: string[],
  allModels: ClassifiedModel[],
): ProvisionalRecord[] {
  const store = loadStore();
  const known = new Set(store.map((r) => r.id));
  const byId = new Map(allModels.map((m) => [m.id, m]));
  const created: ProvisionalRecord[] = [];
  const now = new Date().toISOString();

  for (const rawId of addedIds) {
    const id = provider === "openrouter" && !rawId.startsWith("or:") ? `or:${rawId}` : rawId;
    if (known.has(id) || known.has(rawId)) continue;
    const model = byId.get(rawId) ?? byId.get(id);
    const record: ProvisionalRecord = {
      id,
      family: model ? canonicalModelFamily(model) : familyOf(id),
      tier: model?.tier || tierOf(id),
      provider,
      firstSeen: now,
      status: "provisional",
      coldStartScore: null,
      promotedAt: null,
    };
    store.push(record);
    known.add(id);
    created.push(record);
  }

  if (created.length) saveStore(store);
  return created;
}

async function loadAllCached(): Promise<{ provider: string; models: ClassifiedModel[] }[]> {
  const { loadCachedCatalog: loadSyn } = await import("./catalog");
  const { loadCachedCatalog: loadOR } = await import("./catalog-openrouter");
  const { loadCachedCatalog: loadOC } = await import("./catalog-opencode");
  const { loadCachedCatalog: loadKimi } = await import("./catalog-kimi");
  const out: { provider: string; models: ClassifiedModel[] }[] = [];
  const syn = loadSyn();
  if (syn) out.push({ provider: "synthetic", models: syn.models });
  const or = loadOR();
  if (or) out.push({ provider: "openrouter", models: or.models });
  const oc = loadOC();
  if (oc) out.push({ provider: "opencode", models: oc.models });
  const kimi = loadKimi();
  if (kimi) out.push({ provider: "kimi", models: kimi.models });
  return out;
}

async function cmdDiscover(json: boolean): Promise<void> {
  const catalogs = await loadAllCached();
  const store = loadStore();
  const known = new Set(store.map((r) => r.id));
  const now = new Date().toISOString();
  const created: ProvisionalRecord[] = [];

  for (const { provider, models } of catalogs) {
    for (const m of models) {
      const id = provider === "openrouter" && !m.id.startsWith("or:") ? `or:${m.id}` : m.id;
      if (known.has(id) || known.has(m.id)) continue;
      const record: ProvisionalRecord = {
        id,
        family: canonicalModelFamily(m),
        tier: m.tier,
        provider,
        firstSeen: now,
        status: "provisional",
        coldStartScore: null,
        promotedAt: null,
      };
      store.push(record);
      known.add(id);
      created.push(record);
    }
  }

  if (created.length) saveStore(store);

  if (json) {
    console.log(JSON.stringify({ created: created.length, candidates: created, total: store.length }, null, 2));
  } else {
    console.log(`Provisional discovery — ${created.length} new candidate(s) seeded, ${store.length} total.`);
    for (const r of created) {
      console.log(`  + ${r.id.padEnd(34)} ${r.family.padEnd(10)} ${r.tier.padEnd(9)} ${r.provider}`);
    }
    if (!created.length) console.log("  (all catalog models already tracked)");
  }
}

function cmdList(json: boolean): void {
  const store = loadStore();
  if (json) {
    console.log(JSON.stringify({ total: store.length, candidates: store }, null, 2));
    return;
  }
  console.log(`Provisional candidates — ${store.length} total\n`);
  console.log("  id                                   family     tier       provider   status            firstSeen");
  for (const r of store) {
    console.log(
      `  ${r.id.padEnd(36)} ${r.family.padEnd(10)} ${r.tier.padEnd(10)} ${r.provider.padEnd(10)} ${r.status.padEnd(17)} ${r.firstSeen.slice(0, 10)}`,
    );
  }
}

function cmdShow(id: string): void {
  const store = loadStore();
  const r = store.find((x) => x.id === id);
  if (!r) {
    console.error(`No candidate with id "${id}"`);
    process.exit(1);
  }
  console.log(JSON.stringify(r, null, 2));
}

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });
  const cmd = positionals[0] || "list";

  if (values.help || cmd === "--help") {
    console.log(`Usage:
  provisional-candidates.ts discover [--json]   seed untracked catalog models
  provisional-candidates.ts list [--json]       all candidates
  provisional-candidates.ts show <id>          one candidate`);
    return;
  }

  if (cmd === "discover") await cmdDiscover(values.json);
  else if (cmd === "list") cmdList(values.json);
  else if (cmd === "show") cmdShow(positionals[1] || "");
  else {
    console.error(`Unknown command "${cmd}". Try --help.`);
    process.exit(1);
  }
}

if (import.meta.main) main().catch((e) => {
  console.error(e);
  process.exit(1);
});
