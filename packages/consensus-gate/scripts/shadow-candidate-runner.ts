#!/usr/bin/env bun

import { parseArgs } from "util";
import * as fs from "fs";
import * as path from "path";
import { callVendorWithFallback } from "./consensus-gate";
import { updateReputation } from "./reputation";

const CONSENSUS_DB_PATH = `${process.env.HOME}/.zouroboros/consensus-gate.json`;
export const LEDGER_PATH = `${process.env.HOME}/.zouroboros/shadow-candidate-runs.jsonl`;

export interface ShadowCandidateTarget {
  id: string;
  route: string;
}

export interface ShadowSourceCase {
  id: string;
  timestamp: string;
  label: string;
  code: string;
  criteria: string;
  pass: boolean;
  status: "passed" | "rejected";
}

export interface ShadowRunRecord {
  candidate_id: string;
  candidate_route: string;
  source_consensus_id: string;
  source_timestamp: string;
  candidate_pass: boolean;
  reference_pass: boolean;
  agreed: boolean;
  vendor_error: boolean;
  observed_at: string;
}

export interface CandidateRunSummary {
  candidate_id: string;
  candidate_route: string;
  attempted: number;
  fresh_evidence: number;
  agreements: number;
  vendor_errors: number;
}

type Reviewer = typeof callVendorWithFallback;
type ReputationWriter = typeof updateReputation;

function loadJsonArray(filePath: string): unknown[] {
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Array.isArray(parsed) ? parsed : [];
}

export function loadSourceCases(filePath = CONSENSUS_DB_PATH): ShadowSourceCase[] {
  return loadJsonArray(filePath)
    .flatMap((value): ShadowSourceCase[] => {
      const row = value as Record<string, any>;
      const pass = row.consensus?.pass;
      const status = row.status;
      if (
        typeof row.id !== "string" ||
        typeof row.timestamp !== "string" ||
        typeof row.label !== "string" ||
        typeof row.code !== "string" ||
        typeof row.criteria !== "string" ||
        typeof pass !== "boolean" ||
        row.consensus?.unanimous !== true ||
        (status !== "passed" && status !== "rejected") ||
        row.label.startsWith("shadow-candidate:")
      ) {
        return [];
      }
      return [{
        id: row.id,
        timestamp: row.timestamp,
        label: row.label,
        code: row.code,
        criteria: row.criteria,
        pass,
        status,
      }];
    })
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

function ledgerKey(candidateId: string, consensusId: string): string {
  return `${candidateId}\u0000${consensusId}`;
}

export function loadSeenRuns(filePath = LEDGER_PATH): Set<string> {
  if (!fs.existsSync(filePath)) return new Set();
  const seen = new Set<string>();
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Partial<ShadowRunRecord>;
      if (row.candidate_id && row.source_consensus_id) {
        seen.add(ledgerKey(row.candidate_id, row.source_consensus_id));
      }
    } catch {
      continue;
    }
  }
  return seen;
}

export function loadShadowRuns(candidateId?: string, filePath = LEDGER_PATH): ShadowRunRecord[] {
  if (!fs.existsSync(filePath)) return [];
  const runs: ShadowRunRecord[] = [];
  for (const line of fs.readFileSync(filePath, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as ShadowRunRecord;
      if (!row.candidate_id) continue;
      if (candidateId && row.candidate_id !== candidateId) continue;
      runs.push(row);
    } catch {
      continue;
    }
  }
  return runs;
}

export function selectFreshCases(
  candidateId: string,
  sourceCases: ShadowSourceCase[],
  seen: Set<string>,
  limit: number,
): ShadowSourceCase[] {
  return sourceCases
    .filter((source) => !seen.has(ledgerKey(candidateId, source.id)))
    .slice(0, Math.max(0, limit));
}

function vendorErrors(issues: string[]): string[] {
  return issues.filter((issue) =>
    issue.startsWith("No response from vendor") ||
    issue.startsWith("API error:") ||
    issue.startsWith("Call failed:") ||
    issue.startsWith("Substitute ")
  );
}

function appendRecord(record: ShadowRunRecord, filePath: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
}

export async function runShadowAdvisory(
  candidates: ShadowCandidateTarget[],
  options: {
    sourceCases?: ShadowSourceCase[];
    ledgerPath?: string;
    casesPerCandidate?: number;
    reviewer?: Reviewer;
    reputationWriter?: ReputationWriter;
    now?: () => Date;
  } = {},
): Promise<CandidateRunSummary[]> {
  const sourceCases = options.sourceCases ?? loadSourceCases();
  const ledgerPath = options.ledgerPath ?? LEDGER_PATH;
  const casesPerCandidate = Math.max(1, options.casesPerCandidate ?? 1);
  const reviewer = options.reviewer ?? callVendorWithFallback;
  const reputationWriter = options.reputationWriter ?? updateReputation;
  const now = options.now ?? (() => new Date());
  const seen = loadSeenRuns(ledgerPath);
  const summaries: CandidateRunSummary[] = [];

  for (const candidate of candidates) {
    const summary: CandidateRunSummary = {
      candidate_id: candidate.id,
      candidate_route: candidate.route,
      attempted: 0,
      fresh_evidence: 0,
      agreements: 0,
      vendor_errors: 0,
    };
    const cases = selectFreshCases(candidate.id, sourceCases, seen, casesPerCandidate);

    for (const source of cases) {
      const verdict = await reviewer(candidate.route, source.code, source.criteria, "code-review");
      const errors = vendorErrors(verdict.issues);
      const record: ShadowRunRecord = {
        candidate_id: candidate.id,
        candidate_route: candidate.route,
        source_consensus_id: source.id,
        source_timestamp: source.timestamp,
        candidate_pass: verdict.pass,
        reference_pass: source.pass,
        agreed: errors.length === 0 && verdict.pass === source.pass,
        vendor_error: errors.length > 0,
        observed_at: now().toISOString(),
      };

      reputationWriter(
        [{ model: candidate.id, pass: verdict.pass, vendorErrors: errors }],
        { pass: source.pass, status: source.status },
      );
      appendRecord(record, ledgerPath);
      seen.add(ledgerKey(candidate.id, source.id));
      summary.attempted++;
      if (record.vendor_error) summary.vendor_errors++;
      else {
        summary.fresh_evidence++;
        if (record.agreed) summary.agreements++;
      }
    }
    summaries.push(summary);
  }

  return summaries;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      models: { type: "string" },
      cases: { type: "string", default: "1" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
    strict: true,
  });
  if (values.help || !values.models) {
    console.log("Usage: shadow-candidate-runner.ts --models <candidateId=route,...> [--cases 1] [--json]");
    process.exit(values.help ? 0 : 1);
  }
  const candidates = values.models.split(",").filter(Boolean).map((entry) => {
    const [id, route = id] = entry.split("=", 2);
    return { id, route };
  });
  const summaries = await runShadowAdvisory(candidates, {
    casesPerCandidate: Number.parseInt(values.cases ?? "1", 10),
  });
  if (values.json) console.log(JSON.stringify({ summaries }, null, 2));
  else for (const row of summaries) {
    console.log(`${row.candidate_id}: ${row.fresh_evidence} fresh, ${row.agreements} agreed, ${row.vendor_errors} vendor errors`);
  }
}

if (import.meta.main) main().catch((error) => {
  console.error(error);
  process.exit(1);
});
