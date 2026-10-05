import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const HOLDOUT_SCHEMA_VERSION = 1 as const;
export const CONTAMINATION_THRESHOLD = 0.6;
export const ROTATE_AFTER_EXPOSURES = 2;
export const ROTATE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;

export const ALLOWED_ACCESS_PURPOSES = [
  "evaluate",
  "inspect",
  "contamination_check",
  "rotate",
  "expire",
] as const;

export const EXCLUDED_ACCESS_PURPOSES = [
  "production_trace",
  "prompt",
  "scenario_generation",
  "retrieval",
  "ingestion",
  "memory",
  "example",
  "routing_optimization",
  "implementation",
] as const;

export type HoldoutAccessPurpose = typeof ALLOWED_ACCESS_PURPOSES[number];
export type HoldoutItemState = "active" | "rotation_required" | "expired";
export type HoldoutDecision = "allow" | "hold";

export interface HoldoutFingerprint {
  itemId: string;
  version: string;
  contentSha256: string;
  normalized8GramHashes: string[];
  custodyClass: "evaluator_only";
  createdAt: string;
  expiresAt: string;
  exposureCount: number;
  state: HoldoutItemState;
  rotationReasons: string[];
}

export interface HoldoutManifest {
  schemaVersion: typeof HOLDOUT_SCHEMA_VERSION;
  items: HoldoutFingerprint[];
  manifestHash: string;
}

export interface HoldoutAccessRecord {
  itemId: string;
  itemVersion: string | null;
  actor: string;
  purpose: string;
  decision: HoldoutDecision;
  reasons: string[];
  ts: string;
  previousHash: string | null;
  recordHash: string;
}

export interface HoldoutState {
  manifest: HoldoutManifest;
  accessLedger: HoldoutAccessRecord[];
}

export interface HoldoutAccessResult extends HoldoutState {
  decision: HoldoutDecision;
  reasons: string[];
}

export interface ContaminationResult {
  disposition: "clear" | "quarantine" | "hold";
  exactMatch: boolean;
  maximumOverlap: number;
  matchedItemId: string | null;
  reasons: string[];
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
}

function iso(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be an ISO timestamp`);
  return parsed;
}

function normalizeTokens(value: string): string[] {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

export function normalized8GramHashes(value: string): string[] {
  const tokens = normalizeTokens(value);
  if (tokens.length === 0) return [];
  const grams: string[] = [];
  if (tokens.length < 8) grams.push(`short:${tokens.join(" ")}`);
  else {
    for (let index = 0; index <= tokens.length - 8; index++) {
      grams.push(tokens.slice(index, index + 8).join(" "));
    }
  }
  return [...new Set(grams.map((gram) => sha256(gram)))].sort();
}

export function createHoldoutFingerprint(input: {
  itemId: string;
  version: string;
  plaintext: string;
  createdAt: string;
  expiresAt?: string;
}): HoldoutFingerprint {
  if (!/^[a-z0-9][a-z0-9._-]{2,127}$/i.test(input.itemId)) throw new Error("itemId is invalid");
  if (!input.version.trim()) throw new Error("version is required");
  if (!input.plaintext.trim()) throw new Error("holdout plaintext is empty");
  const created = iso(input.createdAt, "createdAt");
  const expiresAt = input.expiresAt ?? new Date(created + ROTATE_AFTER_MS).toISOString();
  if (iso(expiresAt, "expiresAt") <= created) throw new Error("expiresAt must follow createdAt");
  return {
    itemId: input.itemId,
    version: input.version,
    contentSha256: sha256(input.plaintext),
    normalized8GramHashes: normalized8GramHashes(input.plaintext),
    custodyClass: "evaluator_only",
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(iso(expiresAt, "expiresAt")).toISOString(),
    exposureCount: 0,
    state: "active",
    rotationReasons: [],
  };
}

function manifestPayload(items: readonly HoldoutFingerprint[]): Omit<HoldoutManifest, "manifestHash"> {
  return {
    schemaVersion: HOLDOUT_SCHEMA_VERSION,
    items: items
      .map((item) => structuredClone(item))
      .sort((left, right) => `${left.itemId}:${left.version}`.localeCompare(`${right.itemId}:${right.version}`)),
  };
}

export function finalizeHoldoutManifest(items: readonly HoldoutFingerprint[]): HoldoutManifest {
  const payload = manifestPayload(items);
  return { ...payload, manifestHash: sha256(canonicalize(payload)) };
}

export function validateHoldoutManifest(manifest: HoldoutManifest): string[] {
  const errors: string[] = [];
  if (manifest.schemaVersion !== HOLDOUT_SCHEMA_VERSION) errors.push("unknown manifest schema");
  const expected = sha256(canonicalize(manifestPayload(manifest.items)));
  if (manifest.manifestHash !== expected) errors.push("manifest hash mismatch");
  const identities = new Set<string>();
  for (const item of manifest.items) {
    const identity = `${item.itemId}:${item.version}`;
    if (identities.has(identity)) errors.push(`duplicate holdout identity: ${identity}`);
    identities.add(identity);
    if (!/^[0-9a-f]{64}$/.test(item.contentSha256)) errors.push(`invalid content hash: ${identity}`);
    if (item.normalized8GramHashes.some((hash) => !/^[0-9a-f]{64}$/.test(hash))) errors.push(`invalid 8-gram hash: ${identity}`);
    if (new Set(item.normalized8GramHashes).size !== item.normalized8GramHashes.length) errors.push(`duplicate 8-gram hash: ${identity}`);
    try {
      if (iso(item.expiresAt, "expiresAt") <= iso(item.createdAt, "createdAt")) errors.push(`invalid expiry: ${identity}`);
    } catch (error) {
      errors.push(String(error));
    }
  }
  return errors;
}

function accessPayload(record: Omit<HoldoutAccessRecord, "recordHash">): string {
  return canonicalize(record);
}

export function validateAccessLedger(records: readonly HoldoutAccessRecord[]): string[] {
  const errors: string[] = [];
  let previous: string | null = null;
  for (const [index, record] of records.entries()) {
    if (record.previousHash !== previous) errors.push(`access ledger previous hash mismatch at ${index}`);
    const { recordHash, ...payload } = record;
    const expected = sha256(accessPayload(payload));
    if (recordHash !== expected) errors.push(`access ledger record hash mismatch at ${index}`);
    previous = recordHash;
  }
  return errors;
}

function appendAccessRecord(
  records: readonly HoldoutAccessRecord[],
  input: Omit<HoldoutAccessRecord, "previousHash" | "recordHash">,
): HoldoutAccessRecord[] {
  if (validateAccessLedger(records).length > 0) throw new Error("cannot append to a broken access ledger");
  const payload: Omit<HoldoutAccessRecord, "recordHash"> = {
    ...input,
    previousHash: records.at(-1)?.recordHash ?? null,
  };
  return [...records.map((record) => structuredClone(record)), { ...payload, recordHash: sha256(accessPayload(payload)) }];
}

function rotationReasons(item: HoldoutFingerprint, now: string, contaminationSignal: boolean): string[] {
  const reasons = [...item.rotationReasons];
  const nowMs = iso(now, "now");
  if (item.exposureCount >= ROTATE_AFTER_EXPOSURES) reasons.push("exposure_limit");
  if (nowMs - iso(item.createdAt, "createdAt") >= ROTATE_AFTER_MS) reasons.push("age_limit");
  if (contaminationSignal) reasons.push("contamination_signal");
  return [...new Set(reasons)].sort();
}

function stateAt(item: HoldoutFingerprint, now: string, contaminationSignal: boolean): HoldoutFingerprint {
  const next = structuredClone(item);
  const reasons = rotationReasons(next, now, contaminationSignal);
  if (iso(now, "now") >= iso(next.expiresAt, "expiresAt")) next.state = "expired";
  else if (reasons.length > 0) next.state = "rotation_required";
  next.rotationReasons = reasons;
  return next;
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  const union = new Set([...a, ...b]);
  if (union.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / union.size;
}

export function evaluateHoldoutContamination(
  candidate: string,
  manifest: HoldoutManifest,
  now: string,
): ContaminationResult {
  const manifestErrors = validateHoldoutManifest(manifest);
  if (manifestErrors.length > 0 || manifest.items.length === 0) {
    return { disposition: "hold", exactMatch: false, maximumOverlap: 0, matchedItemId: null, reasons: manifestErrors.length > 0 ? manifestErrors : ["empty holdout manifest"] };
  }
  const inactive = manifest.items.map((item) => stateAt(item, now, false)).filter((item) => item.state !== "active");
  if (inactive.length > 0) {
    return { disposition: "hold", exactMatch: false, maximumOverlap: 0, matchedItemId: inactive[0].itemId, reasons: [`holdout ${inactive[0].state}`] };
  }
  const candidateHash = sha256(candidate);
  const candidateGrams = normalized8GramHashes(candidate);
  let maximumOverlap = 0;
  let matchedItemId: string | null = null;
  let exactMatch = false;
  for (const item of manifest.items) {
    const overlap = jaccard(candidateGrams, item.normalized8GramHashes);
    if (overlap > maximumOverlap) {
      maximumOverlap = overlap;
      matchedItemId = item.itemId;
    }
    if (item.contentSha256 === candidateHash) {
      exactMatch = true;
      matchedItemId = item.itemId;
    }
  }
  if (exactMatch || maximumOverlap >= CONTAMINATION_THRESHOLD) {
    return {
      disposition: "quarantine",
      exactMatch,
      maximumOverlap,
      matchedItemId,
      reasons: [exactMatch ? "exact_hash_overlap" : "normalized_8gram_overlap"],
    };
  }
  return { disposition: "clear", exactMatch: false, maximumOverlap, matchedItemId, reasons: [] };
}

export function recordHoldoutAccess(
  state: HoldoutState,
  input: { itemId: string; actor: string; purpose: string; ts: string; contaminationSignal?: boolean },
): HoldoutAccessResult {
  const manifestErrors = validateHoldoutManifest(state.manifest);
  const ledgerErrors = validateAccessLedger(state.accessLedger);
  if (manifestErrors.length > 0 || ledgerErrors.length > 0) {
    return { ...structuredClone(state), decision: "hold", reasons: [...manifestErrors, ...ledgerErrors] };
  }
  if (!input.actor.trim()) throw new Error("actor is required");
  iso(input.ts, "ts");
  const itemIndex = state.manifest.items.findIndex((item) => item.itemId === input.itemId);
  const item = itemIndex >= 0 ? stateAt(state.manifest.items[itemIndex], input.ts, input.contaminationSignal === true) : null;
  const allowedPurpose = (ALLOWED_ACCESS_PURPOSES as readonly string[]).includes(input.purpose);
  const excludedPurpose = (EXCLUDED_ACCESS_PURPOSES as readonly string[]).includes(input.purpose);
  const reasons: string[] = [];
  if (!item) reasons.push("holdout item not found");
  if (!allowedPurpose) reasons.push(excludedPurpose ? "purpose is excluded" : "purpose is unknown");
  if (item?.state !== "active" && input.purpose !== "rotate" && input.purpose !== "expire") reasons.push(`holdout ${item?.state}`);
  const decision: HoldoutDecision = reasons.length === 0 ? "allow" : "hold";

  const items = state.manifest.items.map((entry, index) => {
    if (index !== itemIndex || !item) return structuredClone(entry);
    const next = structuredClone(item);
    if (decision === "allow" && (input.purpose === "evaluate" || input.purpose === "inspect")) next.exposureCount++;
    return stateAt(next, input.ts, input.contaminationSignal === true);
  });
  const manifest = finalizeHoldoutManifest(items);
  const accessLedger = appendAccessRecord(state.accessLedger, {
    itemId: input.itemId,
    itemVersion: item?.version ?? null,
    actor: input.actor,
    purpose: input.purpose,
    decision,
    reasons,
    ts: new Date(iso(input.ts, "ts")).toISOString(),
  });
  return { manifest, accessLedger, decision, reasons };
}

export function expireHoldouts(state: HoldoutState, now: string, actor = "custody-system"): HoldoutState {
  if (validateHoldoutManifest(state.manifest).length > 0 || validateAccessLedger(state.accessLedger).length > 0) {
    throw new Error("cannot expire invalid holdout state");
  }
  let current: HoldoutState = {
    manifest: finalizeHoldoutManifest(state.manifest.items.map((item) => stateAt(item, now, false))),
    accessLedger: structuredClone(state.accessLedger),
  };
  for (const item of current.manifest.items.filter((entry) => entry.state === "expired")) {
    const audited = recordHoldoutAccess(current, { itemId: item.itemId, actor, purpose: "expire", ts: now });
    current = { manifest: audited.manifest, accessLedger: audited.accessLedger };
  }
  return current;
}

export function readHoldoutState(path: string): HoldoutState {
  const state = JSON.parse(readFileSync(path, "utf8")) as HoldoutState;
  const errors = [...validateHoldoutManifest(state.manifest), ...validateAccessLedger(state.accessLedger)];
  if (errors.length > 0) throw new Error(`invalid holdout state: ${errors.join("; ")}`);
  return state;
}

export function writeHoldoutState(path: string, state: HoldoutState): void {
  const errors = [...validateHoldoutManifest(state.manifest), ...validateAccessLedger(state.accessLedger)];
  if (errors.length > 0) throw new Error(`refuse to persist invalid holdout state: ${errors.join("; ")}`);
  mkdirSync(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.${sha256(path).slice(0, 12)}.${process.pid}.tmp`);
  try {
    writeFileSync(temporary, `${canonicalize(state)}\n`, { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
