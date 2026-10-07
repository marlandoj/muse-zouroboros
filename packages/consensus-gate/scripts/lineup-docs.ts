#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import { resolveConsensusLineup } from "./consensus-lineup";
import {
  displayName,
  loadPersistedLineup,
  type LineupProfile,
  type ModelMeta,
  type PersistedLineup,
} from "./lineup-picker";
import {
  resolveLineupSelection,
  type CapabilityTier,
  type ModelRoleProfile,
  type WeightPolicy,
} from "./lineup-taxonomy";
import {
  callMoaModel,
  DEFAULT_PRODUCTION_MOA_LINEUP,
  providerForMoaModel,
  resolveProductionMoaLineup,
} from "./moa-runtime";

const ROOT = path.resolve(import.meta.dir, "..");
export const DEFAULT_MANIFEST_PATH = path.join(ROOT, "effective-lineups.json");
export const DEFAULT_DOC_PATH = path.join(ROOT, "LINEUPS.generated.md");
const PROFILES: LineupProfile[] = ["flagship", "fast", "open-weights", "coder", "judge"];

export interface LineupMember {
  id: string;
  name: string;
  family: string;
  provider: string;
  role: "proposer" | "aggregator" | "reviewer";
}

export interface HealthRecord {
  ok: boolean;
  provider: string;
  observedAt: string;
  latencyMs: number;
  error?: string;
}

export interface LineupManifest {
  schemaVersion: 2;
  generatedAt: string;
  configHash: string;
  moa: {
    fallback: {
      proposers: LineupMember[];
      aggregator: LineupMember;
    };
    effective: {
      source: "env" | "dynamic" | "fallback";
      proposers: LineupMember[];
      aggregator: LineupMember;
    };
    profiles: Array<{
      profile: LineupProfile;
      roleProfile: ModelRoleProfile;
      capabilityTier: CapabilityTier;
      weightPolicy: WeightPolicy;
      valid: boolean;
      persistedAt: string | null;
      proposers: LineupMember[];
      aggregator: LineupMember | null;
    }>;
  };
  consensus: {
    source: "explicit" | "persisted-profile" | "legacy";
    profile?: LineupProfile;
    models: LineupMember[];
  };
  health: Record<string, HealthRecord>;
}

function sha256(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function readManifest(manifestPath: string): LineupManifest | null {
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")) as LineupManifest;
  } catch {
    return null;
  }
}

function metadataMap(records: Array<PersistedLineup | null>): Map<string, ModelMeta> {
  const result = new Map<string, ModelMeta>();
  for (const record of records) {
    for (const member of record?.members ?? []) result.set(member.id, member);
  }
  return result;
}

function familyFromId(id: string): string {
  const raw = id.replace(/^(byok:|hf:|oc:|syn:|xai:)/, "");
  return raw.split(/[\/_\-.]/)[0]?.toLowerCase() || "unknown";
}

function member(
  id: string,
  role: LineupMember["role"],
  metadata: Map<string, ModelMeta>,
): LineupMember {
  const known = metadata.get(id);
  return {
    id,
    name: known?.name ?? displayName(id),
    family: known?.family ?? familyFromId(id),
    provider: known?.provider ?? providerForMoaModel(id),
    role,
  };
}

function configPayload(manifest: Omit<LineupManifest, "generatedAt" | "configHash" | "health">): unknown {
  return {
    moa: {
      effective: manifest.moa.effective,
      profiles: manifest.moa.profiles.map(({ persistedAt: _persistedAt, ...profile }) => profile),
    },
    consensus: manifest.consensus,
  };
}

export function buildRuntimeManifest(
  previous: LineupManifest | null = null,
  now = new Date(),
): LineupManifest {
  const records = PROFILES.map((profile) => loadPersistedLineup(profile));
  const metadata = metadataMap(records);
  const effective = resolveProductionMoaLineup(DEFAULT_PRODUCTION_MOA_LINEUP);
  const consensus = resolveConsensusLineup();
  const partial = {
    schemaVersion: 2 as const,
    moa: {
      fallback: {
        proposers: DEFAULT_PRODUCTION_MOA_LINEUP.proposers.map((id) => member(id, "proposer", metadata)),
        aggregator: member(DEFAULT_PRODUCTION_MOA_LINEUP.aggregator, "aggregator", metadata),
      },
      effective: {
        source: effective.source,
        proposers: effective.proposers.map((id) => member(id, "proposer", metadata)),
        aggregator: member(effective.aggregator, "aggregator", metadata),
      },
      profiles: PROFILES.map((profile, index) => {
        const record = records[index];
        const selection = resolveLineupSelection(profile);
        return {
          profile,
          roleProfile: selection.roleProfile,
          capabilityTier: selection.capabilityTier,
          weightPolicy: selection.weightPolicy,
          valid: record?.valid === true,
          persistedAt: record?.persistedAt ?? null,
          proposers: (record?.lineup.proposers ?? []).map((id) => member(id, "proposer", metadata)),
          aggregator: record?.lineup.aggregator ? member(record.lineup.aggregator, "aggregator", metadata) : null,
        };
      }),
    },
    consensus: {
      source: consensus.source,
      ...(consensus.profile ? { profile: consensus.profile } : {}),
      models: consensus.models.map((id) => member(id, "reviewer", metadata)),
    },
  };
  const configHash = sha256(configPayload(partial));
  const activeIds = new Set([
    ...partial.moa.effective.proposers.map((item) => item.id),
    partial.moa.effective.aggregator.id,
    ...partial.moa.fallback.proposers.map((item) => item.id),
    partial.moa.fallback.aggregator.id,
    ...partial.moa.profiles.flatMap((profile) => [
      ...profile.proposers.map((item) => item.id),
      ...(profile.aggregator ? [profile.aggregator.id] : []),
    ]),
    ...partial.consensus.models.map((item) => item.id),
  ]);
  const health = Object.fromEntries(
    Object.entries(previous?.health ?? {}).filter(([id]) => activeIds.has(id)),
  );
  return {
    ...partial,
    generatedAt: previous?.configHash === configHash ? previous.generatedAt : now.toISOString(),
    configHash,
    health,
  };
}

function normalizeError(error?: string): string | undefined {
  if (!error) return undefined;
  const http = error.match(/HTTP\s+(\d+)/i);
  if (http) return `HTTP ${http[1]}`;
  if (/timed out/i.test(error)) return "timeout";
  if (/upstream request failed/i.test(error)) return "upstream request failed";
  return error.slice(0, 80);
}

function sameHealth(a: HealthRecord | undefined, b: Omit<HealthRecord, "observedAt">): boolean {
  return Boolean(a && a.ok === b.ok && a.provider === b.provider && a.error === b.error);
}

export async function probeManifest(
  manifest: LineupManifest,
  now = new Date(),
  concurrency = 4,
): Promise<LineupManifest> {
  const ids = [...new Set([
    ...manifest.moa.effective.proposers.map((item) => item.id),
    manifest.moa.effective.aggregator.id,
    ...manifest.moa.fallback.proposers.map((item) => item.id),
    manifest.moa.fallback.aggregator.id,
    ...manifest.moa.profiles.flatMap((profile) => [
      ...profile.proposers.map((item) => item.id),
      ...(profile.aggregator ? [profile.aggregator.id] : []),
    ]),
    ...manifest.consensus.models.map((item) => item.id),
  ])];
  const health: Record<string, HealthRecord> = {};
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, ids.length) }, async () => {
    while (cursor < ids.length) {
      const id = ids[cursor++];
      const result = await callMoaModel(id, "Reply with exactly OK", { maxTokens: 64, temperature: 0 });
      const current = {
        ok: result.ok,
        provider: result.provider,
        latencyMs: result.latencyMs,
        ...(normalizeError(result.error) ? { error: normalizeError(result.error) } : {}),
      };
      const previous = manifest.health[id];
      health[id] = {
        ...current,
        observedAt: sameHealth(previous, current) ? previous.observedAt : now.toISOString(),
      };
    }
  });
  await Promise.all(workers);
  return { ...manifest, health };
}

function healthLabel(record?: HealthRecord): string {
  if (!record) return "not probed";
  return record.ok ? "healthy" : `degraded${record.error ? ` (${record.error})` : ""}`;
}

function renderMembers(members: LineupMember[], health: Record<string, HealthRecord>): string[] {
  return members.map((item) =>
    `| ${item.role} | \`${item.id}\` | ${item.name} | ${item.family} | ${item.provider} | ${healthLabel(health[item.id])} |`,
  );
}

export function renderMarkdown(manifest: LineupManifest): string {
  const lines = [
    "# Effective Model Lineups",
    "",
    "> Generated by `bun scripts/lineup-docs.ts --write`. Do not edit this file manually.",
    "",
    `Configuration hash: \`${manifest.configHash}\`  `,
    `Configuration changed: ${manifest.generatedAt}`,
    "",
    "## Effective Production MoA",
    "",
    `Resolution source: **${manifest.moa.effective.source}**`,
    "",
    "| Role | Model ID | Name | Family | Provider | Availability |",
    "|---|---|---|---|---|---|",
    ...renderMembers([
      ...manifest.moa.effective.proposers,
      manifest.moa.effective.aggregator,
    ], manifest.health),
    "",
    "## Static MoA Fallback",
    "",
    "| Role | Model ID | Name | Family | Provider | Availability |",
    "|---|---|---|---|---|---|",
    ...renderMembers([
      ...manifest.moa.fallback.proposers,
      manifest.moa.fallback.aggregator,
    ], manifest.health),
    "",
    "## Persisted Profiles",
    "",
    "Profiles are compatibility presets. Canonical selection uses role, capability tier, and weight policy as independent dimensions.",
    "",
  ];
  for (const profile of manifest.moa.profiles) {
    lines.push(
      `### ${profile.profile}`,
      "",
      `Canonical selection: role **${profile.roleProfile}**; capability **${profile.capabilityTier}**; weights **${profile.weightPolicy}**`,
      "",
      `Status: **${profile.valid ? "valid" : "unavailable"}**${profile.persistedAt ? `; persisted ${profile.persistedAt}` : ""}`,
      "",
      "| Role | Model ID | Name | Family | Provider | Availability |",
      "|---|---|---|---|---|---|",
      ...renderMembers([
        ...profile.proposers,
        ...(profile.aggregator ? [profile.aggregator] : []),
      ], manifest.health),
      "",
    );
  }
  lines.push(
    "## Effective Consensus Panel",
    "",
    `Resolution source: **${manifest.consensus.source}**${manifest.consensus.profile ? `; profile **${manifest.consensus.profile}**` : ""}`,
    "",
    "| Role | Model ID | Name | Family | Provider | Availability |",
    "|---|---|---|---|---|---|",
    ...renderMembers(manifest.consensus.models, manifest.health),
    "",
    "## Resolution Precedence",
    "",
    "- MoA: runtime `ZO_MOA_*` overrides, then persisted Flagship lineup, then static fallback.",
    "- Consensus: `CONSENSUS_MODELS`, then `GATE_LINEUP_ROLE` + `GATE_LINEUP_WEIGHT_POLICY`, then legacy `GATE_LINEUP_PROFILE`, then the quarantine-aware default panel.",
    "- Availability is observational. A catalog entry is not considered healthy until its exact seat responds.",
    "",
  );
  return lines.join("\n");
}

function atomicWrite(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, filePath);
}

function checkGenerated(manifestPath: string, docPath: string): void {
  const manifest = readManifest(manifestPath);
  if (!manifest) throw new Error(`lineup manifest is missing or malformed: ${manifestPath}`);
  const expected = renderMarkdown(manifest);
  const actual = fs.existsSync(docPath) ? fs.readFileSync(docPath, "utf8") : "";
  if (actual !== expected) throw new Error(`generated lineup documentation is stale: ${docPath}`);
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      write: { type: "boolean", default: false },
      check: { type: "boolean", default: false },
      "check-runtime": { type: "boolean", default: false },
      probe: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      manifest: { type: "string", default: DEFAULT_MANIFEST_PATH },
      doc: { type: "string", default: DEFAULT_DOC_PATH },
    },
  });
  const manifestPath = values.manifest!;
  const docPath = values.doc!;
  if (!values.write && !values.check && !values["check-runtime"]) {
    throw new Error("choose --write, --check, or --check-runtime");
  }
  if (values.write) {
    const previous = readManifest(manifestPath);
    let manifest = buildRuntimeManifest(previous);
    if (values.probe) manifest = await probeManifest(manifest);
    atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    atomicWrite(docPath, renderMarkdown(manifest));
  }
  if (values.check) checkGenerated(manifestPath, docPath);
  if (values["check-runtime"]) {
    const tracked = readManifest(manifestPath);
    if (!tracked) throw new Error(`lineup manifest is missing or malformed: ${manifestPath}`);
    const runtime = buildRuntimeManifest(tracked);
    if (runtime.configHash !== tracked.configHash) {
      throw new Error(`runtime lineup drift: tracked=${tracked.configHash} runtime=${runtime.configHash}`);
    }
  }
  const manifest = readManifest(manifestPath);
  if (values.json) console.log(JSON.stringify(manifest));
  else console.log(`lineup docs OK: ${docPath}`);
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
