import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  evaluatePromotionContent,
  verifyPromotionArtifact,
  writePromotionArtifact,
} from "./profile-escalation-promotion";

const tempDirs: string[] = [];
const fastPanel = ["fast-a", "fast-b", "fast-c"];
const flagshipPanel = ["flagship-a", "flagship-b", "flagship-c"];
const fingerprint = (panel: string[]) => createHash("sha256").update(JSON.stringify(panel)).digest("hex");
const currentLineups = { fast: fingerprint(fastPanel), flagship: fingerprint(flagshipPanel) };
const policy = { minDistinctDays: 7, minSamples: 7, maxSevereMisses: 0 as const, maxArtifactAgeHours: 24 };

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function row(day: number, severeMiss = false, comparable = true): string {
  const run = (profile: "fast" | "flagship") => ({
    ok: comparable,
    consensus_id: comparable ? `cg-${day}` : null,
    gate_run_id: comparable ? `gate-${day}` : null,
    status: comparable ? "passed" : null,
    confidence: comparable ? 0.95 : null,
    unanimous: comparable ? true : null,
    panel: profile === "fast" ? fastPanel : flagshipPanel,
    panel_fingerprint: profile === "fast" ? currentLineups.fast : currentLineups.flagship,
    latency_ms: 10,
  });
  return JSON.stringify({
    schema_version: 1,
    valve_run_id: `pv-${day}`,
    timestamp: `2026-07-${String(day).padStart(2, "0")}T12:00:00.000Z`,
    requested_mode: "shadow",
    effective_mode: "shadow",
    severe_miss: severeMiss,
    fast: run("fast"),
    flagship: run("flagship"),
  });
}

function eligibleContent(): string {
  return Array.from({ length: 7 }, (_, index) => row(index + 1)).join("\n") + "\n";
}

describe("profile escalation promotion", () => {
  test("requires seven distinct UTC observation days", () => {
    const sixDays = Array.from({ length: 7 }, (_, index) => row(Math.min(index + 1, 6))).join("\n");
    const artifact = evaluatePromotionContent(sixDays, { minSamples: 7 });
    expect(artifact.eligible).toBe(false);
    expect(artifact.observed.distinct_days).toBe(6);
    expect(artifact.blockers[0]).toContain("observation days");
  });

  test("requires the configured comparable sample floor", () => {
    const artifact = evaluatePromotionContent(eligibleContent(), { minSamples: 8 });
    expect(artifact.eligible).toBe(false);
    expect(artifact.observed.comparable_samples).toBe(7);
    expect(artifact.blockers[0]).toContain("sample floor");
  });

  test("allows promotion only after all requirements pass", () => {
    const artifact = evaluatePromotionContent(eligibleContent(), { minSamples: 7 });
    expect(artifact.eligible).toBe(true);
    expect(artifact.blockers).toEqual([]);
    expect(artifact.observed.distinct_days).toBe(7);
  });

  test("one severe Flagship miss blocks promotion", () => {
    const content = `${eligibleContent()}${row(8, true)}\n`;
    const artifact = evaluatePromotionContent(content, { minSamples: 7 });
    expect(artifact.eligible).toBe(false);
    expect(artifact.observed.severe_misses).toBe(1);
    expect(artifact.blockers.some((blocker) => blocker.includes("severe miss"))).toBe(true);
  });

  test("older lineup cohorts remain auditable but do not poison the current cohort", () => {
    const old = JSON.parse(row(1));
    old.fast.panel = ["old-fast"];
    old.fast.panel_fingerprint = fingerprint(old.fast.panel);
    old.flagship.panel = ["old-flagship"];
    old.flagship.panel_fingerprint = fingerprint(old.flagship.panel);
    const content = `${JSON.stringify(old)}\n${eligibleContent()}`;
    const current = evaluatePromotionContent(content, {
      minSamples: 7,
      currentLineups,
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(current.eligible).toBe(true);
    expect(current.observed.comparable_samples).toBe(7);
    expect(evaluatePromotionContent(content, { minSamples: 7 }).eligible).toBe(false);
  });

  test("non-comparable and malformed rows cannot satisfy promotion", () => {
    const content = `${eligibleContent()}${row(8, false, false)}\n{torn`;
    const artifact = evaluatePromotionContent(content, { minSamples: 7 });
    expect(artifact.eligible).toBe(false);
    expect(artifact.observed.comparable_samples).toBe(7);
    expect(artifact.observed.malformed_rows).toBe(1);
  });

  test("artifact is bound to the exact ledger digest", () => {
    const dir = mkdtempSync(join(tmpdir(), "promotion-"));
    tempDirs.push(dir);
    const ledger = join(dir, "ledger.jsonl");
    const artifactPath = join(dir, "promotion.json");
    const now = new Date("2026-07-07T12:00:00Z");
    writeFileSync(ledger, eligibleContent());
    writePromotionArtifact(ledger, artifactPath, { minSamples: 7, currentLineups, now });
    expect(verifyPromotionArtifact(artifactPath, ledger, { policy, currentLineups, now })).toEqual({ eligible: true, blockers: [] });
    appendFileSync(ledger, row(8) + "\n");
    const verification = verifyPromotionArtifact(artifactPath, ledger, { policy, currentLineups, now });
    expect(verification.eligible).toBe(false);
    expect(verification.blockers).toContain("promotion artifact ledger digest is stale");
  });

  test("artifact writes complete JSON atomically", () => {
    const dir = mkdtempSync(join(tmpdir(), "promotion-"));
    tempDirs.push(dir);
    const ledger = join(dir, "ledger.jsonl");
    const artifactPath = join(dir, "promotion.json");
    writeFileSync(ledger, eligibleContent());
    const artifact = writePromotionArtifact(ledger, artifactPath, {
      minSamples: 7,
      currentLineups,
      now: new Date("2026-07-07T12:00:00Z"),
    });
    expect(JSON.parse(readFileSync(artifactPath, "utf8"))).toEqual(artifact);
  });

  test("rejects attempts to weaken immutable safety floors", () => {
    expect(() => evaluatePromotionContent("", { minDistinctDays: 0, minSamples: 0 })).toThrow(RangeError);
    expect(() => evaluatePromotionContent("", { minDistinctDays: 7, minSamples: Number.NaN })).toThrow(RangeError);
    expect(() => evaluatePromotionContent("", { minDistinctDays: 7, minSamples: -1 })).toThrow(RangeError);
    expect(() => evaluatePromotionContent("", { minDistinctDays: 7, minSamples: 1, maxSevereMisses: 1 })).toThrow(RangeError);
  });

  test("rejects tampered thresholds, expired artifacts, and lineup drift", () => {
    const dir = mkdtempSync(join(tmpdir(), "promotion-"));
    tempDirs.push(dir);
    const ledger = join(dir, "ledger.jsonl");
    const artifactPath = join(dir, "promotion.json");
    writeFileSync(ledger, eligibleContent());
    const now = new Date("2026-07-07T12:00:00Z");
    const artifact = writePromotionArtifact(ledger, artifactPath, { minSamples: 7, currentLineups, now });

    writeFileSync(artifactPath, JSON.stringify({ ...artifact, thresholds: { ...artifact.thresholds, min_distinct_days: 0 } }));
    expect(verifyPromotionArtifact(artifactPath, ledger, { policy, currentLineups, now }).eligible).toBe(false);

    writeFileSync(artifactPath, JSON.stringify(artifact));
    expect(verifyPromotionArtifact(artifactPath, ledger, {
      policy,
      currentLineups,
      now: new Date("2026-07-09T00:00:00Z"),
    }).blockers).toContain("promotion artifact is expired");

    expect(verifyPromotionArtifact(artifactPath, ledger, {
      policy,
      currentLineups: { ...currentLineups, fast: "changed" },
      now,
    }).blockers).toContain("promotion artifact lineup fingerprints are stale");
  });
});
