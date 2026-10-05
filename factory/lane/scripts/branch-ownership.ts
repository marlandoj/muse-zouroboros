#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * FH-12 (P1-9) — Branch ownership enforcement.
 *
 * PR #402 is titled for RAG self-heal work and sits on
 * `factory/zou-902-factory-intake-zbre-001-define-versioned-result-co`. Four
 * unrelated commits landed on a branch minted for a different execution,
 * because nothing records who owns a branch. A branch name looks like an
 * execution identity and is treated as one, but it is only a string: any
 * execution can append to any branch and no check objects.
 *
 * This module makes ownership explicit and checkable. At branch creation an
 * execution claims `{branch, execution_id, ticket_id, base_commit}`. Any later
 * execution that tries to write to that branch is refused, and the conflict is
 * surfaced rather than silently accepted.
 *
 * Design notes:
 *
 *   - The registry is a single append-only JSONL file. The conveyor issues each
 *     step as a separate shell invocation, so in-process ownership state would
 *     be lost between steps — the same constraint that puts the FH-07 halt in a
 *     sentinel file.
 *   - Re-claiming a branch you already own is a no-op, not an error. Executions
 *     resume, and a resumed cycle must not lock itself out.
 *   - An unclaimed branch is claimable. Refusing every branch without a record
 *     would block all pre-existing work on its first touch, which is a worse
 *     failure than the one being fixed.
 *   - A stale claim is reported, never auto-released. Releasing another
 *     execution's branch automatically is exactly the class of unattended
 *     destructive action this program is trying to remove.
 *
 * Reachability: `swarm-exec.ts` claims a branch before its first commit and
 * `ship-ready-runner.ts` asserts ownership before opening a PR.
 * CLI: `bun branch-ownership.ts claim|assert|status|release|quarantine`.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

const PROJECT_DIR = join(import.meta.dir, "..");

export function registryPath(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "branch-ownership.jsonl");
}

export interface BranchClaim {
  branch: string;
  execution_id: string;
  ticket_id: string;
  base_commit: string | null;
  claimed_at: string;
  /** Set when an operator deliberately hands the branch to another execution. */
  released_at?: string;
  released_by?: string;
}

export type OwnershipStatus =
  /** No claim exists; the caller may take it. */
  | "unclaimed"
  /** The caller already owns it — resume, not a conflict. */
  | "owned"
  /** Another live execution owns it. */
  | "conflict"
  /** The prior owner released it; the caller may take it. */
  | "released";

export interface OwnershipVerdict {
  status: OwnershipStatus;
  allowed: boolean;
  branch: string;
  claim: BranchClaim | null;
  reason: string;
}

function readClaims(base = PROJECT_DIR): BranchClaim[] {
  const path = registryPath(base);
  if (!existsSync(path)) return [];
  const claims: BranchClaim[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as BranchClaim;
      // A torn concurrent append must not blind the registry.
      if (row && typeof row.branch === "string" && typeof row.execution_id === "string") claims.push(row);
    } catch {
      // Skip corrupt lines, same tolerance as the flight journal.
    }
  }
  return claims;
}

/** The effective claim for a branch: the newest record wins. */
export function currentClaim(branch: string, base = PROJECT_DIR): BranchClaim | null {
  const rows = readClaims(base).filter((claim) => claim.branch === branch);
  if (rows.length === 0) return null;
  return rows.reduce((latest, row) => (row.claimed_at >= latest.claimed_at ? row : latest));
}

/**
 * Pure ownership decision. Separated from I/O so the policy — not the file
 * format — is what the tests pin.
 */
export function evaluateOwnership(
  branch: string,
  executionId: string,
  claim: BranchClaim | null,
): OwnershipVerdict {
  if (!claim) {
    return {
      status: "unclaimed",
      allowed: true,
      branch,
      claim: null,
      reason: `${branch} has no owner on record`,
    };
  }
  if (claim.released_at) {
    return {
      status: "released",
      allowed: true,
      branch,
      claim,
      reason: `${branch} was released by ${claim.released_by ?? "an operator"} at ${claim.released_at}`,
    };
  }
  if (claim.execution_id === executionId) {
    return {
      status: "owned",
      allowed: true,
      branch,
      claim,
      reason: `${branch} is already owned by ${executionId}`,
    };
  }
  return {
    status: "conflict",
    allowed: false,
    branch,
    claim,
    reason:
      `${branch} is owned by ${claim.execution_id} (${claim.ticket_id}, claimed ${claim.claimed_at});`
      + ` ${executionId} must use its own branch`,
  };
}

export interface ClaimInput {
  branch: string;
  execution_id: string;
  ticket_id: string;
  base_commit?: string | null;
}

/**
 * Claim a branch. Returns the verdict; the claim is only written when it was
 * allowed and not already held by this execution.
 */
export function claimBranch(
  input: ClaimInput,
  options: { base?: string; now?: string } = {},
): OwnershipVerdict {
  const base = options.base ?? PROJECT_DIR;
  const now = options.now ?? new Date().toISOString();
  const verdict = evaluateOwnership(input.branch, input.execution_id, currentClaim(input.branch, base));
  if (!verdict.allowed || verdict.status === "owned") return verdict;

  const claim: BranchClaim = {
    branch: input.branch,
    execution_id: input.execution_id,
    ticket_id: input.ticket_id,
    base_commit: input.base_commit ?? null,
    claimed_at: now,
  };
  mkdirSync(factoryStatePathForProject(base), { recursive: true });
  appendFileSync(registryPath(base), JSON.stringify(claim) + "\n");
  return { ...verdict, status: "owned", claim, reason: `${input.branch} claimed by ${input.execution_id}` };
}

/** Read-only check. Use before committing, pushing, or opening a PR. */
export function assertOwnership(
  branch: string,
  executionId: string,
  base = PROJECT_DIR,
): OwnershipVerdict {
  return evaluateOwnership(branch, executionId, currentClaim(branch, base));
}

/**
 * Hand a branch to another execution. Deliberately operator-gated: an automatic
 * release would reintroduce the "any execution can take any branch" behaviour
 * this module exists to stop.
 */
export function releaseBranch(
  branch: string,
  by: string,
  options: { base?: string; now?: string } = {},
): { released: boolean; reason: string } {
  const base = options.base ?? PROJECT_DIR;
  const claim = currentClaim(branch, base);
  if (!claim) return { released: false, reason: `${branch} has no owner to release` };
  if (claim.released_at) return { released: false, reason: `${branch} was already released at ${claim.released_at}` };

  const now = options.now ?? new Date().toISOString();
  mkdirSync(factoryStatePathForProject(base), { recursive: true });
  appendFileSync(registryPath(base), JSON.stringify({ ...claim, released_at: now, released_by: by }) + "\n");
  return { released: true, reason: `${branch} released by ${by} at ${now}` };
}

export interface QuarantineEntry {
  branch: string;
  owner: string;
  ticket_id: string;
  claimed_at: string;
  age_days: number;
}

/**
 * Claims older than `maxAgeDays` whose branch is still held. Reported for an
 * operator to act on — this function never releases anything itself.
 */
export function staleClaims(
  options: { maxAgeDays?: number; now?: number; base?: string } = {},
): QuarantineEntry[] {
  const maxAgeDays = options.maxAgeDays ?? 14;
  const now = options.now ?? Date.now();
  const base = options.base ?? PROJECT_DIR;

  const byBranch = new Map<string, BranchClaim>();
  for (const claim of readClaims(base)) {
    const existing = byBranch.get(claim.branch);
    if (!existing || claim.claimed_at >= existing.claimed_at) byBranch.set(claim.branch, claim);
  }

  const stale: QuarantineEntry[] = [];
  for (const claim of byBranch.values()) {
    if (claim.released_at) continue;
    const claimedAt = Date.parse(claim.claimed_at);
    if (!Number.isFinite(claimedAt)) continue;
    const ageDays = (now - claimedAt) / 86_400_000;
    if (ageDays < maxAgeDays) continue;
    stale.push({
      branch: claim.branch,
      owner: claim.execution_id,
      ticket_id: claim.ticket_id,
      claimed_at: claim.claimed_at,
      age_days: Math.round(ageDays),
    });
  }
  return stale.sort((a, b) => b.age_days - a.age_days);
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      branch: { type: "string" },
      execution: { type: "string" },
      ticket: { type: "string" },
      "base-commit": { type: "string" },
      by: { type: "string" },
      "max-age-days": { type: "string" },
      json: { type: "boolean" },
    },
    strict: false,
  });

  const branch = String(values.branch ?? "").trim();
  const execution = String(values.execution ?? "").trim();

  const emit = (payload: unknown, human: string, failed: boolean) => {
    if (values.json) console.log(JSON.stringify(payload));
    else console.log(human);
    process.exit(failed ? 1 : 0);
  };

  if (cmd === "claim") {
    if (!branch || !execution || !values.ticket) {
      console.error("Usage: bun branch-ownership.ts claim --branch <b> --execution <id> --ticket <id> [--base-commit <sha>]");
      process.exit(2);
    }
    const verdict = claimBranch({
      branch,
      execution_id: execution,
      ticket_id: String(values.ticket),
      base_commit: values["base-commit"] ? String(values["base-commit"]) : null,
    });
    emit(verdict, `${verdict.allowed ? "OK" : "REFUSED"} — ${verdict.reason}`, !verdict.allowed);
  } else if (cmd === "assert") {
    if (!branch || !execution) {
      console.error("Usage: bun branch-ownership.ts assert --branch <b> --execution <id>");
      process.exit(2);
    }
    const verdict = assertOwnership(branch, execution);
    emit(verdict, `${verdict.allowed ? "OK" : "REFUSED"} — ${verdict.reason}`, !verdict.allowed);
  } else if (cmd === "status") {
    if (!branch) {
      console.error("Usage: bun branch-ownership.ts status --branch <b>");
      process.exit(2);
    }
    const claim = currentClaim(branch);
    emit(
      claim,
      claim
        ? `${branch} → ${claim.execution_id} (${claim.ticket_id})${claim.released_at ? ` [released ${claim.released_at}]` : ""}`
        : `${branch} has no owner on record`,
      false,
    );
  } else if (cmd === "release") {
    if (!branch || !values.by) {
      console.error("Usage: bun branch-ownership.ts release --branch <b> --by <operator>");
      process.exit(2);
    }
    const result = releaseBranch(branch, String(values.by));
    emit(result, result.reason, !result.released);
  } else if (cmd === "quarantine") {
    const maxAgeDays = Number.parseInt(String(values["max-age-days"] ?? "14"), 10);
    const stale = staleClaims({ maxAgeDays: Number.isFinite(maxAgeDays) ? maxAgeDays : 14 });
    emit(
      stale,
      stale.length === 0
        ? "no stale branch claims"
        : stale.map((entry) => `${entry.age_days}d ${entry.branch} → ${entry.owner} (${entry.ticket_id})`).join("\n"),
      false,
    );
  } else {
    console.log("Usage: bun branch-ownership.ts <claim|assert|status|release|quarantine> --branch <b> [--execution id] [--ticket id] [--by operator] [--json]");
    process.exit(0);
  }
}
