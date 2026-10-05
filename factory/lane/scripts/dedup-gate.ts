#!/usr/bin/env bun
/**
 * SF-006 T2 — Dedup decision gate.
 *
 * Pure core: (ticket, index, probe, now, flags) → DedupDecision. No live calls
 * in the core — the PR/issue liveness probe and the clock are injected
 * (P2-11 ProbeRunner discipline), so every path is testable offline.
 *
 * Decision order (first hit wins):
 *   1. exact  — this ticket's ledger row claims a PR → live-verify:
 *               open → skip_duplicate · merged/closed → clear (re-run of a
 *               landed/abandoned ticket is legitimate new work, interview D4)
 *               · error/unknown → park_verify_failed (FAIL-CLOSED)
 *   2. resume — this ticket's latest checkpoint is mid-pipeline (no PR yet)
 *               → resume_from_checkpoint at the stage after the checkpoint
 *   3. fuzzy  — an OTHER ticket's row carries the same canonical seed hash
 *               within the 72h cooldown → live-verify the match:
 *               PR open OR merged → skip (in-flight or already-landed dup —
 *               the "same work, new ticket" case the fuzzy layer exists for)
 *               · PR closed → proceed (abandoned) · no PR → verify the Linear
 *               issue (open → skip, closed → proceed)
 *               · error/unknown → park_verify_failed (FAIL-CLOSED)
 *   4. proceed
 *
 * acted is true only when SF006_ENFORCE is on AND the decision alters routing
 * — shadow mode always reports acted=false (log-only).
 *
 * CLI (real probes: gh CLI for PRs, Linear GraphQL for issues):
 *   bun dedup-gate.ts check --ticket <uuid> --identifier <ZOU-nnn> [--seed-hash <h>]
 *   bun dedup-gate.ts hash --seed <seed.yaml>
 *
 * Exit codes: 0 ok (decision in JSON on stdout) · 1 error · 2 usage.
 */

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type LedgerFlags,
  type LedgerIndex,
  type LedgerRow,
  type LedgerStage,
  LEDGER_STAGES,
  canonicalSeedHash,
  currentFlags,
  deriveIndex,
  ledgerPath,
} from "./intake-ledger";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProbeKind = "pr" | "issue";
export type ProbeState = "open" | "closed" | "merged" | "unknown" | "error";

export interface VerifyProbe {
  kind: ProbeKind;
  ref: string;
  result: ProbeState;
}

/** Injected liveness check — the only boundary the pure core reaches through. */
export type ProbeRunner = (kind: ProbeKind, ref: string) => Promise<ProbeState>;

export type DedupVerdict =
  | "proceed"
  | "skip_duplicate"
  | "resume_from_checkpoint"
  | "park_verify_failed";
export type DedupLayer = "exact" | "fuzzy" | "none";

export interface DedupDecision {
  decision: DedupVerdict;
  layer: DedupLayer;
  matched_execution_id?: string;
  checkpoint_stage?: LedgerStage;
  reason: string;
  acted: boolean;
  probes: VerifyProbe[];
}

export interface DedupTicketRef {
  ticket_id: string; // Linear issue UUID
  identifier: string; // ZOU-nnn
  seed_hash?: string | null;
}

export const FUZZY_COOLDOWN_MS = 72 * 60 * 60 * 1000;

/** Stage the pipeline should re-enter after a completed checkpoint. */
export function resumeTarget(checkpoint: LedgerStage): LedgerStage | "complete" {
  const i = LEDGER_STAGES.indexOf(checkpoint);
  return i >= 0 && i < LEDGER_STAGES.length - 1 ? LEDGER_STAGES[i + 1] : "complete";
}

// ─── Pure decision core ───────────────────────────────────────────────────────

export async function decideDedup(
  ticket: DedupTicketRef,
  index: LedgerIndex,
  probe: ProbeRunner,
  nowMs: number,
  flags: LedgerFlags = currentFlags(),
): Promise<DedupDecision> {
  const probes: VerifyProbe[] = [];

  const runProbe = async (kind: ProbeKind, ref: string): Promise<ProbeState> => {
    let result: ProbeState;
    try {
      result = await probe(kind, ref);
    } catch {
      result = "error"; // a throwing probe is an uncertain probe — fail-closed
    }
    probes.push({ kind, ref, result });
    return result;
  };

  const decide = (
    decision: DedupVerdict,
    layer: DedupLayer,
    reason: string,
    extra: Partial<Pick<DedupDecision, "matched_execution_id" | "checkpoint_stage">> = {},
  ): DedupDecision => ({
    decision,
    layer,
    reason,
    acted: flags.enforce && decision !== "proceed",
    probes,
    ...extra,
  });

  // 1. exact — most recent PR claim for this ticket, even if later checkpoint
  //    rows shadow it in latestByTicket (ledger-first, live-verify on hit)
  const prClaim = latestPrClaim(index, ticket.ticket_id);
  if (prClaim && prClaim.pr_number !== null) {
    const state = await runProbe("pr", String(prClaim.pr_number));
    if (state === "open") {
      if (prClaim.stage === "evidence-blocked") {
        return decide(
          "resume_from_checkpoint",
          "exact",
          `PR #${prClaim.pr_number} is open with blocked evidence — resume post-flight evidence only and never create another PR`,
          { matched_execution_id: prClaim.execution_id, checkpoint_stage: prClaim.stage },
        );
      }
      return decide(
        "skip_duplicate",
        "exact",
        `PR #${prClaim.pr_number} for ${prClaim.identifier} verified open — re-run is a no-op`,
        { matched_execution_id: prClaim.execution_id },
      );
    }
    if (state !== "merged" && state !== "closed") {
      return decide(
        "park_verify_failed",
        "exact",
        `PR #${prClaim.pr_number} liveness ${state} — cannot rule out a duplicate PR, parking (fail-closed)`,
        { matched_execution_id: prClaim.execution_id },
      );
    }
    // merged/closed → landed or abandoned; a re-run is legitimate new work
  }

  // 2. resume — latest checkpoint is mid-pipeline and newer than any PR claim
  const latest = index.latestByTicket.get(ticket.ticket_id);
  if (
    latest &&
    latest.stage !== "pr" &&
    latest.pr_number === null &&
    (!prClaim || Date.parse(latest.ts) > Date.parse(prClaim.ts))
  ) {
    return decide(
      "resume_from_checkpoint",
      "exact",
      `checkpoint stage=${latest.stage} (exec ${latest.execution_id}) — resume at ${resumeTarget(latest.stage)}`,
      { matched_execution_id: latest.execution_id, checkpoint_stage: latest.stage },
    );
  }

  // 3. fuzzy — same canonical seed hash from a DIFFERENT ticket within cooldown
  const hash = ticket.seed_hash ?? latestSeedHash(index, ticket.ticket_id);
  if (hash) {
    const match = latestFuzzyMatch(index, hash, ticket.ticket_id, nowMs);
    if (match) {
      const ageH = ((nowMs - Date.parse(match.ts)) / 3_600_000).toFixed(1);
      if (match.pr_number !== null) {
        const state = await runProbe("pr", String(match.pr_number));
        if (state === "open" || state === "merged") {
          return decide(
            "skip_duplicate",
            "fuzzy",
            `seed hash matches ${match.identifier} (${ageH}h ago, PR #${match.pr_number} ${state}) — same work, different ticket`,
            { matched_execution_id: match.execution_id },
          );
        }
        if (state !== "closed") {
          return decide(
            "park_verify_failed",
            "fuzzy",
            `seed hash matches ${match.identifier} but PR #${match.pr_number} liveness ${state} — parking (fail-closed)`,
            { matched_execution_id: match.execution_id },
          );
        }
        // closed (not merged) → abandoned duplicate, proceeding is safe
      } else {
        const state = await runProbe("issue", match.ticket_id);
        if (state === "open") {
          return decide(
            "skip_duplicate",
            "fuzzy",
            `seed hash matches ${match.identifier} (${ageH}h ago, issue open, stage=${match.stage}) — pipeline in flight elsewhere`,
            { matched_execution_id: match.execution_id, checkpoint_stage: match.stage },
          );
        }
        if (state !== "closed" && state !== "merged") {
          return decide(
            "park_verify_failed",
            "fuzzy",
            `seed hash matches ${match.identifier} but issue liveness ${state} — parking (fail-closed)`,
            { matched_execution_id: match.execution_id },
          );
        }
      }
    }
  }

  // 4. proceed
  return decide("proceed", "none", "no exact, resume, or fuzzy conflict in ledger");
}

/** Most recent row where this ticket claims a PR (rows are append-ordered). */
function latestPrClaim(index: LedgerIndex, ticketId: string): LedgerRow | null {
  for (let i = index.rows.length - 1; i >= 0; i--) {
    const r = index.rows[i];
    if (r.ticket_id === ticketId && r.pr_number !== null) return r;
  }
  return null;
}

/** Most recent seed_hash this ticket ever checkpointed (rows are append-ordered). */
function latestSeedHash(index: LedgerIndex, ticketId: string): string | null {
  for (let i = index.rows.length - 1; i >= 0; i--) {
    const r = index.rows[i];
    if (r.ticket_id === ticketId && r.seed_hash) return r.seed_hash;
  }
  return null;
}

/** Most recent other-ticket row with this hash inside the cooldown window. */
function latestFuzzyMatch(
  index: LedgerIndex,
  hash: string,
  ticketId: string,
  nowMs: number,
): LedgerRow | null {
  let latest: LedgerRow | null = null;
  for (const row of index.bySeedHash.get(hash) ?? []) {
    if (row.ticket_id === ticketId) continue;
    const ts = Date.parse(row.ts);
    if (Number.isNaN(ts) || nowMs - ts > FUZZY_COOLDOWN_MS) continue;
    if (!latest || ts > Date.parse(latest.ts)) latest = row;
  }
  return latest;
}

// ─── Seed hashing ─────────────────────────────────────────────────────────────

/** Canonical seed hash. Corrupt input is advisory at dispatch and disables fuzzy matching. */
export function hashSeedFile(seedPath: string): string | null {
  try {
    return canonicalSeedHash(Bun.YAML.parse(readFileSync(seedPath, "utf8")));
  } catch (error) {
    console.error(
      `[sf006] corrupt seed at ${seedPath}; continuing with advisory null seed hash: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

// ─── Decision log (observability — shadow-validate reads this) ───────────────

export function decisionsPath(): string {
  return join(dirname(ledgerPath()), "dedup-decisions.jsonl");
}

export interface DedupDecisionRecord extends DedupDecision {
  ts: string;
  ticket_id: string;
  identifier: string;
}

/** Append-only decision audit. Fail-safe: logging failure never blocks routing. */
export function logDecision(ticketId: string, identifier: string, d: DedupDecision): void {
  const rec: DedupDecisionRecord = {
    ts: new Date().toISOString(),
    ticket_id: ticketId,
    identifier,
    ...d,
  };
  try {
    mkdirSync(dirname(decisionsPath()), { recursive: true });
    appendFileSync(decisionsPath(), `${JSON.stringify(rec)}\n`);
  } catch (err) {
    console.error(
      `[sf006] decision log append failed (non-blocking) — ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

export function readDecisions(path: string = decisionsPath()): DedupDecisionRecord[] {
  if (!existsSync(path)) return [];
  const out: DedupDecisionRecord[] = [];
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line) as DedupDecisionRecord);
    } catch {
      // torn trailing line tolerated, same discipline as the ledger
    }
  }
  return out;
}

// ─── Shadow-validate snapshot (SF-002/003 sfNNNSnapshot convention) ──────────

export interface SF006Snapshot {
  dedup_enabled: boolean;
  enforce_enabled: boolean;
  ledger_rows: number;
  ledger_tickets: number;
  ledger_executions: number;
  ledger_seed_hashes: number;
  ledger_torn_lines: number;
  decisions_total: number;
  decisions_by_type: Record<DedupVerdict, number>;
  shadow_would: { would_skip: number; would_resume: number; would_park: number };
  enforced: { skipped: number; resumed: number; parked: number };
  last_decision: string | null;
}

/** Read-only: derives everything from the ledger + decision log on disk. */
export function sf006Snapshot(): SF006Snapshot {
  const flags = currentFlags();
  const index = deriveIndex();
  const decisions = readDecisions();
  const byType: Record<DedupVerdict, number> = {
    proceed: 0,
    skip_duplicate: 0,
    resume_from_checkpoint: 0,
    park_verify_failed: 0,
  };
  const shadowWould = { would_skip: 0, would_resume: 0, would_park: 0 };
  const enforced = { skipped: 0, resumed: 0, parked: 0 };
  for (const d of decisions) {
    if (d.decision in byType) byType[d.decision]++;
    if (d.decision === "skip_duplicate") d.acted ? enforced.skipped++ : shadowWould.would_skip++;
    if (d.decision === "resume_from_checkpoint") d.acted ? enforced.resumed++ : shadowWould.would_resume++;
    if (d.decision === "park_verify_failed") d.acted ? enforced.parked++ : shadowWould.would_park++;
  }
  const last = decisions[decisions.length - 1];
  return {
    dedup_enabled: flags.dedup,
    enforce_enabled: flags.enforce,
    ledger_rows: index.rows.length,
    ledger_tickets: index.latestByTicket.size,
    ledger_executions: index.byExecution.size,
    ledger_seed_hashes: index.bySeedHash.size,
    ledger_torn_lines: index.torn_lines,
    decisions_total: decisions.length,
    decisions_by_type: byType,
    shadow_would: shadowWould,
    enforced,
    last_decision: last ? `${last.identifier} ${last.decision} @ ${last.ts}` : null,
  };
}

// ─── Real probes (CLI / wiring boundary — never called by the core) ──────────

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const LINEAR_API = "https://api.linear.app/graphql";

function verifyPrLive(ref: string): ProbeState {
  // strict: "123abc" must not silently probe PR 123 (consensus cg-1783001607502)
  if (!/^\d+$/.test(ref)) return "error";
  const prNumber = Number.parseInt(ref, 10);
  try {
    const out = execSync(`gh pr view ${prNumber} --json state`, {
      cwd: REPO_ROOT,
      encoding: "utf-8",
      timeout: 15000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const state = (JSON.parse(out) as { state?: string }).state;
    if (state === "OPEN") return "open";
    if (state === "MERGED") return "merged";
    if (state === "CLOSED") return "closed";
    return "unknown";
  } catch {
    return "error";
  }
}

async function verifyIssueLive(ref: string): Promise<ProbeState> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return "error";
  try {
    const r = await fetch(LINEAR_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({
        query: "query($id: String!) { issue(id: $id) { state { type } } }",
        variables: { id: ref },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json()) as { data?: { issue?: { state?: { type?: string } } } };
    const type = j?.data?.issue?.state?.type;
    if (!type) return "unknown";
    return type === "completed" || type === "canceled" ? "closed" : "open";
  } catch {
    return "error";
  }
}

export function realProbe(): ProbeRunner {
  return async (kind, ref) => (kind === "pr" ? verifyPrLive(ref) : verifyIssueLive(ref));
}

/**
 * Enforce-path Linear comment for skip/park (never silent — interview D4).
 * Fail-safe: a failed comment must not crash the pipeline; callers log the
 * false return and the decision stays visible in state/dedup-decisions.jsonl.
 */
export async function postDedupComment(ticketId: string, d: DedupDecision): Promise<boolean> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) return false;
  // collapse whitespace so ledger-sourced values can't inject fake lines (SF-005 precedent)
  const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
  const headline =
    d.decision === "park_verify_failed"
      ? "🅿️ **Factory dedup gate parked this ticket** (fail-closed)"
      : "♻️ **Factory dedup gate skipped this ticket as a duplicate** (no-op)";
  const footer =
    d.decision === "park_verify_failed"
      ? `Liveness verification could not confirm PR/issue state, so the pipeline ` +
        `refused to proceed rather than risk a duplicate PR. Re-run after resolving.`
      : `The work this ticket describes is already open or landed, so re-running ` +
        `it would file a duplicate PR. Close/merge the matched work first if a re-run is intended.`;
  const body =
    `${headline}\n\n` +
    `- Decision: \`${d.decision}\` (layer: ${d.layer})\n` +
    `- Reason: ${oneLine(d.reason)}\n` +
    (d.matched_execution_id ? `- Matched execution: \`${oneLine(d.matched_execution_id)}\`\n` : "") +
    `\n${footer}`;
  try {
    const r = await fetch(LINEAR_API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({
        query:
          "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }",
        variables: { input: { issueId: ticketId, body } },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const j = (await r.json()) as { data?: { commentCreate?: { success?: boolean } } };
    return j?.data?.commentCreate?.success ?? false;
  } catch {
    return false;
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function usage(): never {
  console.error(
    [
      "usage:",
      "  dedup-gate.ts check --ticket <uuid> --identifier <ZOU-nnn> [--seed-hash <h>]",
      "  dedup-gate.ts hash --seed <seed.yaml>",
    ].join("\n"),
  );
  process.exit(2);
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "check": {
      const ticket = flagValue(args, "--ticket");
      const identifier = flagValue(args, "--identifier");
      if (!ticket || !identifier) usage();
      const decision = await decideDedup(
        { ticket_id: ticket, identifier, seed_hash: flagValue(args, "--seed-hash") ?? null },
        deriveIndex(),
        realProbe(),
        Date.now(),
      );
      console.log(JSON.stringify(decision, null, 2));
      break;
    }
    case "hash": {
      const seed = flagValue(args, "--seed");
      if (!seed) usage();
      console.log(hashSeedFile(seed));
      break;
    }
    default:
      usage();
  }
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`dedup-gate: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
