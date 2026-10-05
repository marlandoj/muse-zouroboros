#!/usr/bin/env bun
/**
 * ZOU-437 T1 — Speculative Pre-Spec Runner (SF-P3).
 *
 * Warms the conveyor: for the top-N most-likely-next pullable tickets, pre-runs the
 * spec-first interview and writes seed-<id>.yaml ahead of the pull, so when the
 * conveyor pulls the ticket it hits the cached seed at swarm-exec.ts:368 and skips
 * the inline interview latency.
 *
 * "Most-likely-next" is NOT a learned model — it is the top-N of the EXACT pull
 * ranking (pickHighestPriority: priority→FIFO). We only pre-spec candidates the
 * decision gate routes SWARM/FORCE_SWARM (DIRECT tickets never read a seed, so
 * pre-spec'ing them is pure wasted /zo/ask spend).
 *
 * Sharp edge (D3): a speculative seed built against an old ticket description must
 * never execute against a since-re-scoped ticket. Each speculative seed is stamped
 * with source_hash = sha256(title + "\n" + description). The always-on consume-guard
 * (swarm-exec T3) re-derives it at pull and ignores a stale cache. This runner also
 * uses that stamp to skip re-interviewing a still-fresh cache and to avoid clobbering
 * a hand-authored (unstamped) seed.
 *
 * Default OFF: SF_PRESPEC unset → no candidates processed, conveyor byte-identical.
 * Dry-run = zero /zo/ask spend.
 *
 * Flags:
 *   SF_PRESPEC=1                 producer on (opt-in; spends /zo/ask). Default OFF.
 *   SF_PRESPEC_TOP_N=<n>         candidates per run. Default 3.
 *   SF_PRESPEC_COOLDOWN_HOURS=<h> regenerate a cache older than this. Default 72.
 *
 * CLI:
 *   bun prespec-runner.ts [--dry-run] [--top <n>] [--json]
 *     --dry-run   select + plan only; zero /zo/ask spend; writes nothing.
 *     --top <n>   override SF_PRESPEC_TOP_N for this run.
 *     --json      emit the plan/result as JSON.
 *
 * Exit codes: 0 ok · 1 error.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { isPullable, normalizePriority, type IntakeTicket } from "./linear-puller";
import { runGate, type GateDecision } from "./dispatcher";
import {
  parseCascadeValidationCommands,
  parseSeedContractDocument,
  parseSeedTasksYaml,
  readSeedPersonaLineage,
  readSeedSourceHash,
  type PersonaAssociationLineage,
} from "./pool-queue";
import { appendRow, canonicalSeedHash, sourceHash } from "./intake-ledger";
import { askWithFailover, formatTrail, loadModelChain } from "./model-chain";
import { generatePrespecWithOverflow } from "./modal-generation";
import { atomicPublishSeed, parseSeedYaml } from "./recovery-artifacts";
import { productGateMode, runProductPreflight, type ProductPreflightResult } from "./product-lifecycle-gate";

// ─── Config ─────────────────────────────────────────────────────────────────

const ZO_ASK_URL = "https://api.zo.computer/zo/ask";
export const PRESPEC_ZO_REQUEST_TIMEOUT_MS = 45_000;
export const PRESPEC_ZO_CHAIN_DEPTH = 1;
const API = process.env.LINEAR_API_URL ?? "https://api.linear.app/graphql";
// Read-only twins of linear-puller's private constants — the runner fetches the
// pullable set WITHOUT the puller's reap side-effect (which strips labels and
// would corrupt the queue on a speculative read).
const INTAKE_PROJECT_ID = "b621d7a1-bb3d-4df9-ae11-3034789e204c";
const FACTORY_READY_LABEL = "f4a73851-6c6b-4a19-b397-c2bd62eeb694";

const SEED_DELIM = "===SEED_YAML===";
const NOTES_DELIM = "===INTERVIEW_NOTES===";
const END_DELIM = "===END===";

export interface PrespecFlags {
  enabled: boolean;
  topN: number;
  cooldownHours: number;
}

export function currentPrespecFlags(
  env: Record<string, string | undefined> = process.env,
  topOverride?: number,
): PrespecFlags {
  const topEnv = Number.parseInt(env.SF_PRESPEC_TOP_N ?? "", 10);
  const coolEnv = Number.parseInt(env.SF_PRESPEC_COOLDOWN_HOURS ?? "", 10);
  return {
    enabled: env.SF_PRESPEC === "1",
    topN: topOverride ?? (Number.isFinite(topEnv) && topEnv > 0 ? topEnv : 3),
    cooldownHours: Number.isFinite(coolEnv) && coolEnv > 0 ? coolEnv : 72,
  };
}

export function prespecZoModelChain(chain: string[]): string[] {
  return chain.slice(0, PRESPEC_ZO_CHAIN_DEPTH);
}

// ─── Candidate selection (pure) ───────────────────────────────────────────────

export type GateFn = (ticket: IntakeTicket) => GateDecision;

/** Rank the whole pullable set with the EXACT pull comparator (priority→FIFO). */
export function rankPullable(tickets: IntakeTicket[]): IntakeTicket[] {
  return [...tickets].sort((a, b) => {
    const byPriority = normalizePriority(a.priority) - normalizePriority(b.priority);
    if (byPriority !== 0) return byPriority;
    return (a.created_at ?? "").localeCompare(b.created_at ?? "");
  });
}

/**
 * Walk the ranked set in pull order, gate each candidate, and keep the first `topN`
 * that route SWARM/FORCE_SWARM. Non-SWARM tickets are dropped (they never read a
 * seed). Stops as soon as topN SWARM candidates are found — a lower-ranked SWARM
 * ticket is correctly skipped once the top-N is full.
 */
export function selectPrespecCandidates(
  pullable: IntakeTicket[],
  topN: number,
  gateFn: GateFn,
): IntakeTicket[] {
  const picked: IntakeTicket[] = [];
  for (const t of rankPullable(pullable)) {
    if (picked.length >= topN) break;
    const decision = gateFn(t);
    if (decision === "SWARM" || decision === "FORCE_SWARM") picked.push(t);
  }
  return picked;
}

// ─── Freshness (pure) ──────────────────────────────────────────────────────────

export type FreshnessDecision = "interview" | "skip-fresh-cache" | "skip-hand-authored";

export interface FreshnessInput {
  exists: boolean;
  /** Top-level source_hash stamp from the cached seed; null if absent (hand-authored). */
  stampedSourceHash: string | null;
  /** File mtime in ms; null if it cannot be stat'd. */
  mtimeMs: number | null;
  currentSourceHash: string;
  cooldownHours: number;
  nowMs: number;
}

/**
 * Decide whether a candidate needs a (re-)interview.
 *   - no file            → interview (no cache)
 *   - unstamped file     → skip (hand-authored seed; the runner never clobbers it)
 *   - stamp mismatch     → interview (ticket re-scoped since last pre-spec)
 *   - stamp match, stale → interview (cache older than cooldown → refresh)
 *   - stamp match, fresh → skip (valid speculative cache)
 */
export function evaluateFreshness(i: FreshnessInput): { decision: FreshnessDecision; reason: string } {
  if (!i.exists) return { decision: "interview", reason: "no cached seed" };
  if (i.stampedSourceHash === null) {
    return { decision: "skip-hand-authored", reason: "existing seed carries no source_hash stamp — hand-authored, never clobbered" };
  }
  if (i.stampedSourceHash !== i.currentSourceHash) {
    return { decision: "interview", reason: "stamped source_hash mismatch — ticket re-scoped since last pre-spec" };
  }
  if (i.mtimeMs === null) {
    return { decision: "interview", reason: "cannot stat cached seed mtime" };
  }
  const ageHours = (i.nowMs - i.mtimeMs) / 3_600_000;
  if (ageHours > i.cooldownHours) {
    return { decision: "interview", reason: `cache age ${ageHours.toFixed(1)}h > cooldown ${i.cooldownHours}h — refresh` };
  }
  return { decision: "skip-fresh-cache", reason: `fresh cache (age ${ageHours.toFixed(1)}h ≤ ${i.cooldownHours}h, source_hash match)` };
}

/** Disk wrapper around evaluateFreshness. */
export function freshnessFor(
  ticket: IntakeTicket,
  seedPath: string,
  cooldownHours: number,
  nowMs: number = Date.now(),
): { decision: FreshnessDecision; reason: string } {
  const exists = existsSync(seedPath);
  let mtimeMs: number | null = null;
  if (exists) {
    try {
      mtimeMs = statSync(seedPath).mtimeMs;
    } catch {
      mtimeMs = null;
    }
  }
  return evaluateFreshness({
    exists,
    stampedSourceHash: exists ? readSeedSourceHash(seedPath) : null,
    mtimeMs,
    currentSourceHash: sourceHash(ticket.title, ticket.description),
    cooldownHours,
    nowMs,
  });
}

// ─── Seed stamping + interview parsing (pure) ──────────────────────────────────

/**
 * Prepend (or replace) a top-level source_hash stamp on a seed YAML document.
 *
 * If the seed opens with a `---` document marker, the stamp is placed AFTER it,
 * inside the same document. Prepending before `---` would split the file into two
 * YAML documents, which `Bun.YAML.parse` returns as an array — silently dropping
 * the stamp (readSeedSourceHash → null → the consume-guard treats a stamped
 * speculative seed as hand-authored and trusts it) AND breaking task parsing.
 */
export function stampSourceHash(seedYaml: string, hash: string): string {
  const withoutExisting = seedYaml.replace(/^source_hash:.*\r?\n?/m, "");
  const body = withoutExisting.replace(/^\s*\n/, "");
  const docMarker = body.match(/^---[ \t]*\r?\n/);
  if (docMarker) {
    return `${docMarker[0]}source_hash: "${hash}"\n${body.slice(docMarker[0].length)}`;
  }
  return `source_hash: "${hash}"\n${body}`;
}

/** Strip surrounding ```/```yaml fences a model may wrap a block in. */
function stripFences(block: string): string {
  return block
    .replace(/^\s*```[a-zA-Z]*\s*\n?/, "")
    .replace(/\n?```\s*$/, "")
    .trim();
}

export interface ParsedInterview {
  seedYaml: string | null;
  notes: string | null;
}

/**
 * Publication validation for a speculative seed.
 *
 * ZOU-1282: the persona-association contract is validated HERE, before the seed
 * is cached, so a speculative seed that escalates authority or names a role
 * outside its exact association can never reach the consume path. Validation is
 * structural only — no persona is resolved, no directory is called, and a seed
 * that declares no association is accepted exactly as before.
 */
export function validatePrespecSeed(seedYaml: string): Record<string, unknown> {
  const parsed = parseSeedYaml(seedYaml);
  parseSeedTasksYaml(seedYaml, "pre-spec seed");
  parseCascadeValidationCommands(parsed.validation_commands, "pre-spec seed");
  if (declaresPersonaContract(parsed)) parseSeedContractDocument(parsed, "pre-spec seed");
  return parsed;
}

/** True only when the seed carries persona metadata — keeps legacy seeds on the
 *  exact pre-ZOU-1282 acceptance surface. */
export function declaresPersonaContract(doc: Record<string, unknown>): boolean {
  if (doc.persona_association !== undefined && doc.persona_association !== null) return true;
  const tasks = doc.tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((task) => {
    if (typeof task !== "object" || task === null) return false;
    const value = (task as Record<string, unknown>).persona_assignments;
    return value !== undefined && value !== null;
  });
}

export function cachedSeedValidationError(seedPath: string): string | null {
  try {
    validatePrespecSeed(readFileSync(seedPath, "utf8"));
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Split a /zo/ask pre-spec response on the SEED_YAML / INTERVIEW_NOTES delimiters. */
export function parsePrespecOutput(output: string): ParsedInterview {
  const seedIdx = output.indexOf(SEED_DELIM);
  const notesIdx = output.indexOf(NOTES_DELIM);
  if (seedIdx < 0 || notesIdx < 0 || notesIdx < seedIdx) return { seedYaml: null, notes: null };
  const seedRaw = output.slice(seedIdx + SEED_DELIM.length, notesIdx);
  let notesRaw = output.slice(notesIdx + NOTES_DELIM.length);
  const endIdx = notesRaw.indexOf(END_DELIM);
  if (endIdx >= 0) notesRaw = notesRaw.slice(0, endIdx);
  const seedYaml = stripFences(seedRaw);
  const notes = notesRaw.trim();
  return { seedYaml: seedYaml.length ? seedYaml : null, notes: notes.length ? notes : null };
}

export function buildPrespecPrompt(ticket: IntakeTicket): string {
  return [
    `You are running ONLY the spec-first-interview phase of the Zouroboros Software Factory.`,
    `You are pre-computing a spec for a backlog ticket that has NOT been pulled yet.`,
    `Do NOT implement, execute, run code, create branches, commit, or write any files.`,
    `Produce ONLY a seed specification and interview notes for the ticket below.`,
    ``,
    `## Ticket`,
    `- ID: ${ticket.identifier} (${ticket.linear_id})`,
    `- Title: ${ticket.title}`,
    ``,
    `## Description`,
    ticket.description || "(no description)",
    ``,
    `## Your task`,
    `1. Run the spec-first interview (surface the load-bearing facts, decisions, out-of-scope).`,
    `2. Produce a seed YAML spec: id, title, archetype, target_repo, branch, context,`,
    `   repositories[] (each repository/ref/commit_sha), tasks[] (each id/name/package/files/change/deps),`,
    `   build_plumbing_allowance (max_changed_lines/path_patterns), performance_baseline when any`,
    `   performance criterion exists, acceptance_criteria[], validation_commands[] (each entry requires`,
    `   label, command, string[] args, and optional positive timeout_ms), dag, out_of_scope.`,
    `   Validation commands must be deterministic, non-interactive, and runnable from the repository root.`,
    `   Resolve every repository commit_sha and expected ref from the current checkout; never invent a pin.`,
    `   Build archetypes must bound incidental config/dotfile/type-shim scope. A host-relative performance`,
    `   baseline must name a real-hardware release_verification environment. Game/rendering work that scopes`,
    `   gameplay entities must include an acceptance criterion proving visible pixels or scene-graph nodes.`,
    `3. Produce concise interview notes (problem framing, decisions with rationale, out-of-scope).`,
    ``,
    `## Response format — EXACT`,
    `Emit the two sections below with these literal delimiter lines and nothing after ${END_DELIM}:`,
    SEED_DELIM,
    `<the seed YAML document — a top-level mapping, no code fences>`,
    NOTES_DELIM,
    `<markdown interview notes>`,
    END_DELIM,
  ].join("\n");
}

// ─── Linear fetch (read-only, no reap) ─────────────────────────────────────────

const ISSUES_QUERY = `
  query FactoryReadyTickets($projectId: ID!, $labelId: ID!) {
    issues(filter: { project: { id: { eq: $projectId } }, labels: { id: { eq: $labelId } } }) {
      nodes {
        id identifier title description url priority createdAt updatedAt
        state { id name type }
        labels { nodes { id name } }
      }
    }
  }
`;

async function fetchPullable(): Promise<IntakeTicket[]> {
  const key = process.env.LINEAR_API_KEY;
  if (!key) throw new Error("LINEAR_API_KEY not set");
  const r = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: key },
    body: JSON.stringify({ query: ISSUES_QUERY, variables: { projectId: INTAKE_PROJECT_ID, labelId: FACTORY_READY_LABEL } }),
  });
  if (!r.ok) throw new Error(`Linear API ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = (await r.json()) as any;
  if (j.errors?.length) throw new Error(`Linear GQL: ${JSON.stringify(j.errors)}`);
  const nodes = (j.data?.issues?.nodes ?? []) as any[];
  return nodes
    .filter((n) => isPullable(n.state?.type))
    .map((n): IntakeTicket => ({
      linear_id: n.id,
      identifier: n.identifier,
      title: n.title ?? "",
      description: n.description ?? "",
      url: n.url ?? "",
      state: n.state?.name ?? "",
      state_type: n.state?.type ?? "",
      labels: (n.labels?.nodes ?? []).map((l: any) => l.name),
      created_at: n.createdAt ?? "",
      updated_at: n.updatedAt ?? "",
      priority: typeof n.priority === "number" ? n.priority : 0,
    }));
}

// ─── Runner ────────────────────────────────────────────────────────────────────

const seedPathFor = (identifier: string): string =>
  join(import.meta.dir, "..", `seed-${identifier.toLowerCase()}.yaml`);
const notesPathFor = (identifier: string): string =>
  join(import.meta.dir, "..", `interview-notes-${identifier.toLowerCase()}.md`);

export interface CandidatePlan {
  identifier: string;
  ticket_id: string;
  title: string;
  decision: FreshnessDecision;
  reason: string;
  seed_path: string;
  /**
   * ZOU-1282: lineage of the persona association already present in the cached
   * seed. Recorded, never resolved — the pre-spec stage makes no directory call
   * and holds no identity. Absent when the cached seed declares no association,
   * so a legacy plan serializes exactly as before.
   */
  persona_association?: PersonaAssociationLineage;
}

export interface RunResult {
  enabled: boolean;
  dry_run: boolean;
  top_n: number;
  cooldown_hours: number;
  selected: number;
  plans: CandidatePlan[];
  interviewed: string[];
  skipped: string[];
  product_gate_held?: string[];
}

/**
 * Injectable side-effect surface so the selftest can drive run() with zero network:
 * a fake pullable set, a deterministic gate, and an interview spy. Defaults are the
 * real Linear fetch, the real decision-gate subprocess, and the real /zo/ask cache.
 */
export interface RunDeps {
  fetchPullable: () => Promise<IntakeTicket[]>;
  gateFn: GateFn;
  interview: (ticket: IntakeTicket, seedPath: string) => Promise<void>;
  productGate: (ticket: IntakeTicket, dryRun: boolean) => Promise<ProductPreflightResult>;
  nowMs: number;
}

function defaultDeps(): RunDeps {
  return {
    fetchPullable,
    // The gate wants a "title\ndescription" summary and fills ticket itself.
    gateFn: (t) => runGate(`${t.title}\n\n${t.description}`).decision,
    interview: interviewAndCache,
    productGate: (ticket, dryRun) => runProductPreflight(ticket, {
      persist: !dryRun,
      mutate: !dryRun,
    }),
    nowMs: Date.now(),
  };
}

export async function run(opts: {
  dryRun: boolean;
  topOverride?: number;
  deps?: Partial<RunDeps>;
}): Promise<RunResult> {
  const deps = { ...defaultDeps(), ...opts.deps };
  const flags = currentPrespecFlags(process.env, opts.topOverride);
  const result: RunResult = {
    enabled: flags.enabled,
    dry_run: opts.dryRun,
    top_n: flags.topN,
    cooldown_hours: flags.cooldownHours,
    selected: 0,
    plans: [],
    interviewed: [],
    skipped: [],
    ...(productGateMode() === "off" ? {} : { product_gate_held: [] }),
  };

  // Default OFF: unset SF_PRESPEC → no candidates processed, byte-identical no-op.
  // (--dry-run is diagnostic and MAY run with the flag off to preview the plan.)
  if (!flags.enabled && !opts.dryRun) return result;

  const pullable = await deps.fetchPullable();
  const productEligible: IntakeTicket[] = [];
  for (const ticket of pullable) {
    try {
      const decision = await deps.productGate(ticket, opts.dryRun);
      if (decision.acted) {
        (result.product_gate_held ??= []).push(ticket.identifier);
      } else {
        productEligible.push(ticket);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (productGateMode() === "enforce") throw new Error(`[product-gate] ${ticket.identifier}: ${detail}`);
      console.error(`[product-gate] ${ticket.identifier}: prespec preflight unavailable (shadow) — ${detail}`);
      productEligible.push(ticket);
    }
  }
  const candidates = selectPrespecCandidates(productEligible, flags.topN, deps.gateFn);
  result.selected = candidates.length;

  for (const ticket of candidates) {
    const seedPath = seedPathFor(ticket.identifier);
    let { decision, reason } = freshnessFor(ticket, seedPath, flags.cooldownHours, deps.nowMs);
    if (decision === "skip-fresh-cache") {
      const validationError = cachedSeedValidationError(seedPath);
      if (validationError !== null) {
        decision = "interview";
        reason = `cached seed failed publication validation — ${validationError}`;
      }
    }
    const personaLineage = existsSync(seedPath) ? readSeedPersonaLineage(seedPath) : null;
    result.plans.push({
      identifier: ticket.identifier,
      ticket_id: ticket.linear_id,
      title: ticket.title,
      decision,
      reason,
      seed_path: seedPath,
      ...(personaLineage ? { persona_association: personaLineage } : {}),
    });

    if (decision !== "interview") {
      result.skipped.push(ticket.identifier);
      continue;
    }
    if (opts.dryRun) {
      // Plan recorded; zero spend, no writes.
      continue;
    }
    await deps.interview(ticket, seedPath);
    result.interviewed.push(ticket.identifier);
  }

  return result;
}

async function interviewAndCache(ticket: IntakeTicket, seedPath: string): Promise<void> {
  const token = process.env.ZO_CLIENT_IDENTITY_TOKEN;
  if (!token) throw new Error("ZO_CLIENT_IDENTITY_TOKEN not set — cannot run pre-spec interview");

  const input = buildPrespecPrompt(ticket);
  const askRes = await generatePrespecWithOverflow({
    input,
    zoCall: () => askWithFailover({
      url: ZO_ASK_URL,
      token,
      input,
      chain: prespecZoModelChain(loadModelChain()),
      timeoutMs: PRESPEC_ZO_REQUEST_TIMEOUT_MS,
      maxAttemptsPerModel: 1,
    }),
  });
  const { seedYaml, notes } = parsePrespecOutput(askRes.output || "");
  if (!seedYaml) {
    throw new Error(`pre-spec for ${ticket.identifier}: /zo/ask returned no parseable seed (model=${askRes.model})`);
  }
  validatePrespecSeed(seedYaml);

  const hash = sourceHash(ticket.title, ticket.description);
  const stamped = stampSourceHash(seedYaml, hash);
  atomicPublishSeed(seedPath, stamped.endsWith("\n") ? stamped : `${stamped}\n`);
  writeFileSync(
    notesPathFor(ticket.identifier),
    `# Pre-Spec Interview — ${ticket.identifier}\n\n` +
      `_Speculative pre-spec (SF-P3). Model: ${askRes.model}. Trail: ${formatTrail(askRes.trail)}._\n\n` +
      `${notes ?? "(no notes emitted)"}\n`,
  );

  // Audit-only ledger row: stage="prespec", seed_hash=canonical seed hash. No new
  // required field; source_hash lives stamped in the seed, not the ledger.
  appendRow({
    ticket_id: ticket.linear_id,
    identifier: ticket.identifier,
    execution_id: `prespec-${Date.now()}`,
    stage: "prespec",
    seed_hash: canonicalSeedHash(parseSeedYaml(stamped)),
  });
}

// ─── CLI ────────────────────────────────────────────────────────────────────

function renderHuman(r: RunResult): string {
  const lines: string[] = [];
  const mode = r.dry_run ? "DRY-RUN (zero spend)" : r.enabled ? "LIVE" : "DISABLED (no-op)";
  lines.push(`prespec-runner: ${mode} · top-N=${r.top_n} · cooldown=${r.cooldown_hours}h`);
  if (!r.enabled && !r.dry_run) {
    lines.push("  SF_PRESPEC unset → no candidates processed (conveyor byte-identical).");
    return lines.join("\n");
  }
  lines.push(`  selected ${r.selected} SWARM candidate(s)`);
  for (const p of r.plans) {
    const tag = p.decision === "interview" ? (r.dry_run ? "would interview" : "interviewed") : p.decision;
    lines.push(`  - ${p.identifier} [${tag}] ${p.reason}`);
    lines.push(`      → ${p.seed_path}`);
    if (p.persona_association) {
      lines.push(
        `      personas: ${p.persona_association.template_reference} assoc ${p.persona_association.version}@${p.persona_association.sha256.slice(0, 12)} — ${p.persona_association.fleet_role_ids.length} role(s), ${p.persona_association.required_role_ids.length} required (unresolved)`,
      );
    }
  }
  if (!r.dry_run) {
    lines.push(`  interviewed: ${r.interviewed.length ? r.interviewed.join(", ") : "none"}`);
    lines.push(`  skipped (fresh/hand-authored): ${r.skipped.length ? r.skipped.join(", ") : "none"}`);
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      "dry-run": { type: "boolean", default: false },
      top: { type: "string" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(
      "prespec-runner — pre-generate seeds for the top-N most-likely-next SWARM tickets\n" +
        "  bun prespec-runner.ts [--dry-run] [--top <n>] [--json]",
    );
    return;
  }

  const topOverride = values.top !== undefined ? Number.parseInt(String(values.top), 10) : undefined;
  if (topOverride !== undefined && (!Number.isFinite(topOverride) || topOverride <= 0)) {
    throw new Error(`--top must be a positive integer (got "${values.top}")`);
  }

  const result = await run({ dryRun: Boolean(values["dry-run"]), topOverride });
  console.log(values.json ? JSON.stringify(result, null, 2) : renderHuman(result));
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`prespec-runner: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
