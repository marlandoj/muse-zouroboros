#!/usr/bin/env bun

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseArgs } from "node:util";
import type { ProfileEscalationLedgerRow, PromotionVerification } from "./profile-escalation-valve";
import { loadPersistedLineup } from "./lineup-picker";

export interface PromotionThresholds {
  min_distinct_days: number;
  min_samples: number;
  max_severe_misses: number;
}

export interface PromotionObserved {
  samples: number;
  comparable_samples: number;
  distinct_days: number;
  first_observed_at: string | null;
  last_observed_at: string | null;
  severe_misses: number;
  malformed_rows: number;
}

export interface PromotionArtifact {
  schema_version: 1;
  generated_at: string;
  expires_at: string;
  eligible: boolean;
  ledger_sha256: string;
  thresholds: PromotionThresholds;
  observed: PromotionObserved;
  lineups: { fast: string | null; flagship: string | null };
  blockers: string[];
}

export interface PromotionOptions {
  minDistinctDays?: number;
  minSamples?: number;
  maxSevereMisses?: number;
  maxArtifactAgeHours?: number;
  now?: Date;
  currentLineups?: { fast: string; flagship: string } | null;
}

export interface PromotionPolicy {
  minDistinctDays: number;
  minSamples: number;
  maxSevereMisses: 0;
  maxArtifactAgeHours: number;
}

const DEFAULT_LEDGER_PATH = process.env.PROFILE_ESCALATION_LEDGER
  ?? `${process.env.HOME}/.zouroboros/profile-escalation-shadow.jsonl`;
const DEFAULT_ARTIFACT_PATH = process.env.PROFILE_ESCALATION_PROMOTION
  ?? `${process.env.HOME}/.zouroboros/profile-escalation-promotion.json`;

function positiveInteger(value: unknown, label: string, minimum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value < minimum) {
    throw new RangeError(`${label} must be an integer >= ${minimum}`);
  }
  return value;
}

function envPositiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function trustedPromotionPolicy(): PromotionPolicy {
  return {
    minDistinctDays: 7,
    minSamples: envPositiveInteger(process.env.PROFILE_ESCALATION_MIN_SAMPLES, 100),
    maxSevereMisses: 0,
    maxArtifactAgeHours: envPositiveInteger(process.env.PROFILE_ESCALATION_ARTIFACT_MAX_AGE_HOURS, 24),
  };
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isValidRun(row: ProfileEscalationLedgerRow["fast"] | null): boolean {
  return Boolean(
    row?.ok &&
    (row.status === "passed" || row.status === "rejected" || row.status === "escalate") &&
    typeof row.confidence === "number" && Number.isFinite(row.confidence) &&
    typeof row.unanimous === "boolean" &&
    Array.isArray(row.panel) && row.panel.length > 0 &&
    typeof row.panel_fingerprint === "string" &&
    row.panel_fingerprint === sha256(JSON.stringify(row.panel))
  );
}

function readLedger(content: string): { rows: ProfileEscalationLedgerRow[]; malformed: number } {
  const rows: ProfileEscalationLedgerRow[] = [];
  let malformed = 0;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as ProfileEscalationLedgerRow;
      if (row.schema_version !== 1 || typeof row.timestamp !== "string") {
        malformed++;
        continue;
      }
      rows.push(row);
    } catch {
      malformed++;
    }
  }
  return { rows, malformed };
}

export function evaluatePromotionContent(
  content: string,
  options: PromotionOptions = {},
): PromotionArtifact {
  const minDistinctDays = positiveInteger(options.minDistinctDays ?? 7, "minDistinctDays", 7);
  const minSamples = positiveInteger(options.minSamples ?? 100, "minSamples", 1);
  if (options.maxSevereMisses !== undefined && options.maxSevereMisses !== 0) {
    throw new RangeError("maxSevereMisses is fixed at 0");
  }
  const maxArtifactAgeHours = positiveInteger(options.maxArtifactAgeHours ?? 24, "maxArtifactAgeHours", 1);
  const thresholds: PromotionThresholds = {
    min_distinct_days: minDistinctDays,
    min_samples: minSamples,
    max_severe_misses: 0,
  };
  const { rows, malformed } = readLedger(content);
  const shadowRows = rows.filter((row) => row.effective_mode === "shadow");
  const allComparable = shadowRows.filter((row) => isValidRun(row.fast) && isValidRun(row.flagship));
  const comparable = options.currentLineups
    ? allComparable.filter((row) =>
        row.fast.panel_fingerprint === options.currentLineups!.fast &&
        row.flagship!.panel_fingerprint === options.currentLineups!.flagship
      )
    : allComparable;
  const timestamps = comparable
    .map((row) => new Date(row.timestamp))
    .filter((date) => Number.isFinite(date.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  const distinctDays = new Set(timestamps.map((date) => date.toISOString().slice(0, 10))).size;
  const severeMisses = comparable.filter((row) => row.severe_miss).length;
  const lineupPairs = new Set(comparable.map((row) => `${row.fast.panel_fingerprint}:${row.flagship!.panel_fingerprint}`));
  const onlyPair = lineupPairs.size === 1 ? comparable[0] : undefined;
  const lineups = {
    fast: onlyPair?.fast.panel_fingerprint ?? null,
    flagship: onlyPair?.flagship?.panel_fingerprint ?? null,
  };
  const generatedAt = options.now ?? new Date();
  const blockers: string[] = [];

  if (comparable.length < thresholds.min_samples) {
    blockers.push(`sample floor not met: ${comparable.length}/${thresholds.min_samples}`);
  }
  if (distinctDays < thresholds.min_distinct_days) {
    blockers.push(`observation days not met: ${distinctDays}/${thresholds.min_distinct_days}`);
  }
  if (severeMisses > thresholds.max_severe_misses) {
    blockers.push(`severe miss ceiling exceeded: ${severeMisses}/${thresholds.max_severe_misses}`);
  }
  if (malformed > 0) blockers.push(`ledger contains ${malformed} malformed row(s)`);
  if (comparable.length > 0 && lineupPairs.size !== 1) blockers.push("shadow observations span multiple lineup fingerprints");
  if (options.currentLineups === null) blockers.push("current persisted Fast and Flagship lineups are unavailable");
  else if (options.currentLineups && (
    lineups.fast !== options.currentLineups.fast || lineups.flagship !== options.currentLineups.flagship
  )) blockers.push("shadow observations do not match the current persisted lineups");
  if (options.currentLineups !== undefined) {
    const latest = timestamps.at(-1)?.getTime();
    const ageMs = latest === undefined ? Number.POSITIVE_INFINITY : generatedAt.getTime() - latest;
    if (ageMs < 0 || ageMs > maxArtifactAgeHours * 3_600_000) {
      blockers.push("latest comparable shadow observation is stale");
    }
  }

  return {
    schema_version: 1,
    generated_at: generatedAt.toISOString(),
    expires_at: new Date(generatedAt.getTime() + maxArtifactAgeHours * 3_600_000).toISOString(),
    eligible: blockers.length === 0,
    ledger_sha256: sha256(content),
    thresholds,
    observed: {
      samples: shadowRows.length,
      comparable_samples: comparable.length,
      distinct_days: distinctDays,
      first_observed_at: timestamps[0]?.toISOString() ?? null,
      last_observed_at: timestamps.at(-1)?.toISOString() ?? null,
      severe_misses: severeMisses,
      malformed_rows: malformed,
    },
    lineups,
    blockers,
  };
}

export function evaluatePromotionLedger(
  ledgerPath: string,
  options: PromotionOptions = {},
): PromotionArtifact {
  const content = fs.existsSync(ledgerPath) ? fs.readFileSync(ledgerPath, "utf8") : "";
  return evaluatePromotionContent(content, options);
}

export function writePromotionArtifact(
  ledgerPath: string,
  artifactPath: string,
  options: PromotionOptions = {},
): PromotionArtifact {
  const artifact = evaluatePromotionLedger(ledgerPath, {
    ...options,
    currentLineups: options.currentLineups === undefined ? currentPersistedLineups() : options.currentLineups,
  });
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  const tempPath = `${artifactPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, artifactPath);
  return artifact;
}

function sameObserved(a: PromotionObserved, b: PromotionObserved): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function currentPersistedLineups(): { fast: string; flagship: string } | null {
  const fast = loadPersistedLineup("fast");
  const flagship = loadPersistedLineup("flagship");
  if (!fast?.valid || !flagship?.valid || !fast.lineup.proposers.length || !flagship.lineup.proposers.length) return null;
  return {
    fast: sha256(JSON.stringify(fast.lineup.proposers)),
    flagship: sha256(JSON.stringify(flagship.lineup.proposers)),
  };
}

export function verifyPromotionArtifact(
  artifactPath: string,
  ledgerPath: string,
  options: { policy?: PromotionPolicy; now?: Date; currentLineups?: { fast: string; flagship: string } | null } = {},
): PromotionVerification {
  if (!fs.existsSync(artifactPath)) return { eligible: false, blockers: ["promotion artifact is missing"] };
  let artifact: PromotionArtifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as PromotionArtifact;
  } catch {
    return { eligible: false, blockers: ["promotion artifact is malformed"] };
  }
  if (artifact.schema_version !== 1 || !artifact.thresholds) {
    return { eligible: false, blockers: ["promotion artifact schema is invalid"] };
  }
  try {
    positiveInteger(artifact.thresholds.min_distinct_days, "artifact min_distinct_days", 7);
    positiveInteger(artifact.thresholds.min_samples, "artifact min_samples", 1);
    if (artifact.thresholds.max_severe_misses !== 0) throw new RangeError("artifact max_severe_misses must be 0");
  } catch (error) {
    return { eligible: false, blockers: [error instanceof Error ? error.message : "promotion artifact thresholds are invalid"] };
  }

  const policy = options.policy ?? trustedPromotionPolicy();
  const policyBlockers: string[] = [];
  if (artifact.thresholds.min_distinct_days < policy.minDistinctDays) policyBlockers.push("artifact observation-day threshold is below policy");
  if (artifact.thresholds.min_samples < policy.minSamples) policyBlockers.push("artifact sample threshold is below policy");
  if (artifact.thresholds.max_severe_misses !== 0) policyBlockers.push("artifact severe-miss threshold violates policy");
  const now = options.now ?? new Date();
  const expiresAt = new Date(artifact.expires_at).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) policyBlockers.push("promotion artifact is expired");
  const lastObservedAt = new Date(artifact.observed?.last_observed_at ?? "").getTime();
  if (!Number.isFinite(lastObservedAt) || now.getTime() - lastObservedAt > policy.maxArtifactAgeHours * 3_600_000) {
    policyBlockers.push("latest comparable shadow observation is stale");
  }
  const currentLineups = options.currentLineups === undefined ? currentPersistedLineups() : options.currentLineups;
  if (!currentLineups) policyBlockers.push("current persisted Fast and Flagship lineups are unavailable");
  else if (artifact.lineups?.fast !== currentLineups.fast || artifact.lineups?.flagship !== currentLineups.flagship) {
    policyBlockers.push("promotion artifact lineup fingerprints are stale");
  }

  const current = evaluatePromotionLedger(ledgerPath, {
    minDistinctDays: Math.max(artifact.thresholds.min_distinct_days, policy.minDistinctDays),
    minSamples: Math.max(artifact.thresholds.min_samples, policy.minSamples),
    maxSevereMisses: 0,
    maxArtifactAgeHours: policy.maxArtifactAgeHours,
    currentLineups,
    now,
  });
  const blockers = [...policyBlockers, ...current.blockers];
  if (artifact.ledger_sha256 !== current.ledger_sha256) blockers.unshift("promotion artifact ledger digest is stale");
  if (!sameObserved(artifact.observed, current.observed)) blockers.push("promotion artifact observations do not match the ledger");
  if (artifact.lineups?.fast !== current.lineups.fast || artifact.lineups?.flagship !== current.lineups.flagship) {
    blockers.push("promotion artifact observations have different lineup fingerprints");
  }
  if (!artifact.eligible) blockers.push("promotion artifact is not eligible");
  return { eligible: blockers.length === 0 && current.eligible, blockers: [...new Set(blockers)] };
}

async function main(): Promise<void> {
  const policy = trustedPromotionPolicy();
  const { values } = parseArgs({
    options: {
      ledger: { type: "string", default: DEFAULT_LEDGER_PATH },
      output: { type: "string", default: DEFAULT_ARTIFACT_PATH },
      "min-days": { type: "string", default: "7" },
      "min-samples": { type: "string", default: String(policy.minSamples) },
      json: { type: "boolean", default: false },
    },
  });
  const minDistinctDays = positiveInteger(Number(values["min-days"]), "--min-days", policy.minDistinctDays);
  const minSamples = positiveInteger(Number(values["min-samples"]), "--min-samples", policy.minSamples);
  const artifact = writePromotionArtifact(values.ledger!, values.output!, {
    minDistinctDays,
    minSamples,
    maxSevereMisses: 0,
    maxArtifactAgeHours: policy.maxArtifactAgeHours,
  });
  if (values.json) console.log(JSON.stringify(artifact));
  else console.log(`${artifact.eligible ? "ELIGIBLE" : "BLOCKED"}: ${values.output}`);
  if (!artifact.eligible) process.exitCode = 2;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
