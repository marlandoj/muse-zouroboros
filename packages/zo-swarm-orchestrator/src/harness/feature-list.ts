/**
 * Immutable, hash-guarded feature-list — long-horizon harness discipline.
 *
 * Roadmap §10 (AIEWF 2026 corpus — Anthropic agentic surfaces): a durable spec of
 * what a campaign MUST deliver, kept OUTSIDE the model's context window in a JSON
 * file that a long-running agent cannot silently overwrite. The corpus principle is
 * blunt: "the model overwrites JSON less than Markdown" — so the spec is JSON, with
 * a content hash so any drift/overwrite is detectable.
 *
 * PURE: hashing is deterministic compute; all file IO flows through an INJECTED
 * FileProbe, so the core never touches real disk in tests. createFeatureList is
 * WRITE-ONCE (refuses to clobber an existing file); reconcileProgress is a pure
 * advisory map of declared features → landed vs missing against TaskResults.
 *
 * @module zouroboros-swarm/harness/feature-list
 */

import { createHash } from 'node:crypto';
import type { TaskResult } from '../types.js';

export interface Feature {
  id: string;
  title: string;
  /** Declared-done hint at authoring time; reconcile verifies reality vs results. */
  done?: boolean;
  /** Optional artifact path that signals this feature landed. */
  artifact?: string;
}

export interface FeatureList {
  campaign: string;
  /** ISO timestamp set at creation. */
  createdAt: string;
  features: Feature[];
  /** sha256 hex over the canonical content (sans this field). */
  hash: string;
}

/**
 * Injected file probe — keeps the write-once helpers pure/testable.
 * `read` returns null when the path is missing OR unreadable.
 */
export interface FeatureListFileProbe {
  exists(path: string): boolean;
  read(path: string): string | null;
  write(path: string, content: string): void;
}

/** Deterministic canonical serialization of the hashable content (sans hash). */
function canonicalize(list: Pick<FeatureList, 'campaign' | 'createdAt' | 'features'>): string {
  const features = list.features.map(f => ({
    id: f.id,
    title: f.title,
    done: f.done ?? false,
    artifact: f.artifact ?? null,
  }));
  return JSON.stringify({ campaign: list.campaign, createdAt: list.createdAt, features });
}

/** sha256 hex of the canonical content. Pure. */
export function computeFeatureListHash(
  list: Pick<FeatureList, 'campaign' | 'createdAt' | 'features'>,
): string {
  return createHash('sha256').update(canonicalize(list)).digest('hex');
}

export interface CreateFeatureListOptions {
  createdAt?: string;
}

/**
 * Build a hashed FeatureList and write it WRITE-ONCE through the probe.
 * Throws if the path already exists (never clobbers an authored spec).
 */
export function createFeatureList(
  campaign: string,
  features: Feature[],
  path: string,
  probe: FeatureListFileProbe,
  opts: CreateFeatureListOptions = {},
): FeatureList {
  if (probe.exists(path)) {
    throw new Error(`feature-list already exists at ${path} (write-once; refusing to overwrite)`);
  }
  const list = buildFeatureList(campaign, features, opts);
  probe.write(path, JSON.stringify(list, null, 2));
  return list;
}

/** Build a hashed FeatureList object without any IO. Pure. */
export function buildFeatureList(
  campaign: string,
  features: Feature[],
  opts: CreateFeatureListOptions = {},
): FeatureList {
  const base = {
    campaign,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    features,
  };
  return { ...base, hash: computeFeatureListHash(base) };
}

/** Parse + shape-validate a feature-list from JSON text. Throws on malformed input. */
export function parseFeatureList(jsonText: string): FeatureList {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonText);
  } catch (err) {
    throw new Error(`feature-list is not valid JSON: ${(err as Error).message}`);
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('feature-list must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (typeof o.campaign !== 'string') throw new Error('feature-list.campaign must be a string');
  if (typeof o.createdAt !== 'string') throw new Error('feature-list.createdAt must be a string');
  if (typeof o.hash !== 'string') throw new Error('feature-list.hash must be a string');
  if (!Array.isArray(o.features)) throw new Error('feature-list.features must be an array');
  const features: Feature[] = o.features.map((f, i) => {
    if (!f || typeof f !== 'object') throw new Error(`feature[${i}] must be an object`);
    const fo = f as Record<string, unknown>;
    if (typeof fo.id !== 'string') throw new Error(`feature[${i}].id must be a string`);
    if (typeof fo.title !== 'string') throw new Error(`feature[${i}].title must be a string`);
    const feat: Feature = { id: fo.id, title: fo.title };
    if (typeof fo.done === 'boolean') feat.done = fo.done;
    if (typeof fo.artifact === 'string') feat.artifact = fo.artifact;
    return feat;
  });
  return { campaign: o.campaign, createdAt: o.createdAt, features, hash: o.hash };
}

/** Load + parse a feature-list from a path through the probe. Throws if absent/malformed. */
export function loadFeatureList(path: string, probe: FeatureListFileProbe): FeatureList {
  const text = probe.read(path);
  if (text === null) throw new Error(`feature-list not found or unreadable at ${path}`);
  return parseFeatureList(text);
}

export interface IntegrityResult {
  ok: boolean;
  expected: string;
  actual: string;
}

/**
 * Recompute the hash over the list's current content and compare to the stored
 * hash. A mismatch means the file was overwritten/tampered since creation.
 */
export function verifyFeatureListIntegrity(list: FeatureList): IntegrityResult {
  const expected = computeFeatureListHash(list);
  return { ok: expected === list.hash, expected, actual: list.hash };
}

export interface ReconcileReport {
  campaign: string;
  total: number;
  /** Feature ids backed by a successful result (id match or artifact match). */
  landed: string[];
  /** Declared feature ids with no successful result evidence. */
  missing: string[];
  /** missing.length === 0 (advisory only — never gates the run). */
  passed: boolean;
}

/**
 * Pure advisory map: declared features → landed vs missing, judged against the
 * actual TaskResults (not the declared `done` hint). A feature is LANDED when a
 * successful result's task id equals the feature id, OR a successful result
 * reports an artifact equal to the feature's declared artifact.
 */
export function reconcileProgress(list: FeatureList, results: TaskResult[]): ReconcileReport {
  const succeededIds = new Set<string>();
  const succeededArtifacts = new Set<string>();
  for (const r of results) {
    if (!r.success) continue;
    if (r.task?.id) succeededIds.add(r.task.id);
    for (const a of r.artifacts ?? []) if (a && a.trim()) succeededArtifacts.add(a.trim());
    for (const c of r.childRecords ?? [])
      for (const a of c.artifacts ?? []) if (a && a.trim()) succeededArtifacts.add(a.trim());
  }

  const landed: string[] = [];
  const missing: string[] = [];
  for (const f of list.features) {
    const byId = succeededIds.has(f.id);
    const byArtifact = !!f.artifact && succeededArtifacts.has(f.artifact.trim());
    if (byId || byArtifact) landed.push(f.id);
    else missing.push(f.id);
  }

  return {
    campaign: list.campaign,
    total: list.features.length,
    landed,
    missing,
    passed: missing.length === 0,
  };
}

/** Real file probe — wired path only (lazy require keeps the core fs-free). */
export function createRealFileProbe(): FeatureListFileProbe {
  const { existsSync, readFileSync, writeFileSync } = require('fs');
  return {
    exists: (p: string): boolean => existsSync(p),
    read: (p: string): string | null => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
    write: (p: string, content: string): void => writeFileSync(p, content, 'utf-8'),
  };
}
