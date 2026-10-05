import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { EvidenceCheckStatus, EvidenceMode } from "./factory-evidence";
import { sourceDigest, type SupplyChainAttestation } from "../../../Skills/skill-security-gate/scripts/supply-chain/attestation";
import type { SupplyChainReport } from "../../../Skills/skill-security-gate/scripts/supply-chain/types";

export interface SupplyChainPreflight {
  status: EvidenceCheckStatus;
  blocked: boolean;
  evidence: string[];
  attestation_hash: string | null;
  review_required?: number;
  reviewed_by?: string | null;
  hashes: Record<string, string>;
  diagnostics: string[];
}

export interface SupplyChainRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

type Runner = (command: string, args: string[]) => SupplyChainRunResult;

const defaultRunner: Runner = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
};

export function parseSupplyChainOutput(
  result: SupplyChainRunResult,
  mode: EvidenceMode,
  review: { by?: string; note?: string } = {},
): SupplyChainPreflight {
  const combined = `${result.stdout}\n${result.stderr}`;
  const digest = combined.match(/Attestation digest:\s*(sha256:[0-9a-f]{64})/i)?.[1] ?? null;
  const path = combined.match(/Attestation:\s*(.+\.json)\s*$/im)?.[1]?.trim();
  const diagnostics: string[] = [];
  const hashes: Record<string, string> = {};
  let verifiedArtifact = false;
  let attestedReviewRequired: number | null = null;
  if (path && digest && existsSync(path)) {
    try {
      const bytes = readFileSync(path);
      hashes[path] = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
      const attestation = JSON.parse(bytes.toString("utf8")) as SupplyChainAttestation;
      attestedReviewRequired = attestation.reviewRequired;
      if (attestation.sourceDigest !== digest) diagnostics.push("attestation digest differs from gate output");
      else if (!attestation.reportPath || !existsSync(attestation.reportPath)) diagnostics.push("attestation source report is missing");
      else {
        const reportBytes = readFileSync(attestation.reportPath);
        hashes[attestation.reportPath] = `sha256:${createHash("sha256").update(reportBytes).digest("hex")}`;
        const report = JSON.parse(reportBytes.toString("utf8")) as SupplyChainReport;
        if (sourceDigest(report) !== digest) diagnostics.push("attestation digest does not match source report");
        else verifiedArtifact = true;
      }
    } catch (err) {
      diagnostics.push(`attestation verification failed: ${(err as Error).message}`);
    }
  } else diagnostics.push("attestation path/digest missing or unreadable");
  const printedReviewRequired = Number(combined.match(/MCP review required:\s*(\d+)/i)?.[1] ?? 0);
  if (attestedReviewRequired !== null && printedReviewRequired !== attestedReviewRequired) {
    diagnostics.push("MCP review count differs from attestation");
    verifiedArtifact = false;
  }
  const passed = result.status === 0 && digest !== null && verifiedArtifact;
  const reviewRequired = attestedReviewRequired ?? printedReviewRequired;
  const reviewAccepted = reviewRequired === 0 || Boolean(review.by?.trim() && review.note?.trim());
  return {
    status: passed && reviewAccepted ? "pass" : "fail",
    blocked: mode === "blocking" && (!passed || !reviewAccepted),
    evidence: Object.keys(hashes).sort(),
    attestation_hash: digest,
    review_required: reviewRequired,
    reviewed_by: reviewAccepted && reviewRequired > 0 ? review.by ?? null : null,
    hashes,
    diagnostics: [
      ...diagnostics,
      ...(!passed ? [combined.trim().slice(0, 1000) || `supply-chain gate exited ${result.status}`] : []),
      ...(reviewRequired > 0 && reviewAccepted ? [`MCP policy review by ${review.by}: ${review.note}`] : []),
      ...(reviewRequired > 0 && !reviewAccepted ? [`${reviewRequired} MCP policy finding(s) require operator review`] : []),
    ],
  };
}

export function runSupplyChainPreflight(
  root: string,
  reportDir: string,
  mode: EvidenceMode,
  runner: Runner = defaultRunner,
): SupplyChainPreflight {
  const gate = join(root, "Skills", "skill-security-gate", "scripts", "supply-chain", "gate.ts");
  const args = [gate, "--root", root, "--report-dir", reportDir, "--attest"];
  if (mode === "blocking") args.push("--strict");
  return parseSupplyChainOutput(runner("bun", args), mode, {
    by: process.env.SUPPLY_CHAIN_REVIEWED_BY,
    note: process.env.SUPPLY_CHAIN_REVIEW_NOTE,
  });
}
