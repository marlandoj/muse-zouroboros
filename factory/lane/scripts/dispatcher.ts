#!/usr/bin/env bun
/**
 * T3 — Decision-Gate Dispatcher
 *
 * For each valid ticket, runs swarm-decision-gate.ts --json with the
 * ticket title + description. Routes by exit code + parsed JSON:
 *   DIRECT (exit 2)     → execute directly (no swarm overhead)
 *   SWARM (exit 0, score>0.45) → full pipeline (interview→seed→eval→execute→post-flight→gap audit)
 *   FORCE_SWARM (exit 0, override) → full pipeline (mandatory)
 *   SUGGEST (exit 3)    → operator judgment (default: proceed direct with note)
 *   Error (exit 1)      → proceed without gate, do not block
 *
 * The dispatcher parses BOTH 'decision' and 'override' JSON fields —
 * exit codes alone are insufficient to distinguish SWARM from FORCE_SWARM.
 *
 * Usage:
 *   bun dispatcher.ts --tickets <json-file>     # Dispatch from JSON file
 *   bun dispatcher.ts --tickets -              # Dispatch from stdin
 *   bun dispatcher.ts --dry-run --tickets <json>  # Route only, no execution
 *   bun dispatcher.ts --help
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { assertLegacyLinearTicket } from "./factory-work-contract";
import { execSync } from "node:child_process";
import {
  runFactoryControlGate,
  type FactoryControlOutcome,
} from "../../../packages/capability-runtime/src/index";

const ZCR_SHADOW_HOOK = "zcr-008/v1";

// ZCR-008 shadow observation: fire-and-forget, fail-open by design — the
// host flow must never block or fail because observation is unavailable.
function zcrShadowObserve(adapter: "autoloop" | "swarm" | "factory", input: Record<string, unknown>): void {
  try {
    if (process.env.ZCR_SHADOW === "0" || process.env.FACTORY_STATE_MODE === "test") return;
    const stateDir = process.env.ZCR_SHADOW_STATE_DIR ?? "/home/workspace/.zouroboros/zcr-shadow";
    if (process.env.ZCR_SHADOW !== "1" && !existsSync(join(stateDir, "ENABLED"))) return;
    const cli = [
      process.env.ZCR_SHADOW_CLI,
      new URL("../../../packages/capability-runtime/bin/shadow-observe.ts", import.meta.url).pathname,
      join(stateDir, "runtime/packages/capability-runtime/bin/shadow-observe.ts"),
      "/home/workspace/zouroboros/packages/capability-runtime/bin/shadow-observe.ts",
    ].find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0 && existsSync(candidate));
    if (cli === undefined) return;
    const child = Bun.spawn(["bun", cli], {
      stdin: new TextEncoder().encode(JSON.stringify({ hook: ZCR_SHADOW_HOOK, adapter, input })),
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env },
    });
    child.unref();
  } catch {
    return;
  }
}
import { buildInputs, parseContractFields, scoreRisk, tierFor, type RiskTier } from "./risk-classifier";
import {
  type DedupDecision,
  decideDedup,
  hashSeedFile,
  logDecision,
  postDedupComment,
  realProbe,
} from "./dedup-gate";
import { type LedgerIndex, currentFlags, deriveIndex } from "./intake-ledger";
import { ticketAuthor, type AgentIdentity } from "./factory-evidence";
import {
  resolvePromotedOutcomePolicy,
  type ModelProfile,
  type OutcomePolicyResolution,
  type PromotedOutcomePolicy,
} from "./outcome-routing-core";
import {
  productGateMode,
  productGateSummary,
  runProductPreflight,
  type ProductPreflightResult,
} from "./product-lifecycle-gate";
import {
  gameSeedPreflightSummary,
  runGameSeedPreflight,
  type GameSeedPreflightResult,
} from "../game-gauntlet/scripts/game-seed-preflight";
import {
  gameManifestPreflightSummary,
  runGameManifestPreflight,
  type GameManifestPreflightResult,
} from "../game-gauntlet/scripts/game-manifest-preflight";
import {
  gameHarnessPreflightSummary,
  runGameHarnessPreflight,
  type GameHarnessPreflightResult,
} from "../game-gauntlet/scripts/game-harness-preflight";
import {
  gameScorePreflightSummary,
  runGameScorePreflight,
  type GameScorePreflightResult,
} from "../game-gauntlet/scripts/game-score-preflight";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IntakeTicket {
  linear_id: string;
  identifier: string;
  title: string;
  description: string;
  url: string;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
}

export type GateDecision = "DIRECT" | "SWARM" | "FORCE_SWARM" | "SUGGEST" | "ERROR";

export interface DispatchResult {
  ticket: IntakeTicket;
  decision: GateDecision;
  score: number;
  override: boolean;
  raw_exit: number;
  reason: string;
  risk_preview?: { tier: RiskTier; score: number };
  dedup?: DedupDecision;
  author_identity?: AgentIdentity;
  outcome_policy?: OutcomePolicyResolution;
  product_gate?: ProductPreflightResult;
  game_seed_gate?: GameSeedPreflightResult;
  game_manifest_gate?: GameManifestPreflightResult;
  game_harness_gate?: GameHarnessPreflightResult;
  game_score_gate?: GameScorePreflightResult;
}

// ─── Gate runner ──────────────────────────────────────────────────────────────

const GATE_SCRIPT = "/home/workspace/Skills/tier-resolver/scripts/swarm-decision-gate.ts";

/**
 * Run the swarm decision gate on a ticket summary and parse the result.
 *
 * The gate script writes JSON to stdout and exits with a code:
 *   0 → SWARM (score > 0.45) or FORCE_SWARM (override detected)
 *   1 → Error
 *   2 → DIRECT
 *   3 → SUGGEST
 *
 * SWARM vs FORCE_SWARM is disambiguated by parsing the JSON 'decision' and
 * 'override' fields — exit codes alone are insufficient.
 */
export function runGate(ticketSummary: string): DispatchResult {
  const escaped = ticketSummary.replace(/'/g, "'\\''").replace(/"/g, '\\"');

  let stdout = "";
  let exitCode = 0;

  try {
    stdout = execSync(
      `bun ${GATE_SCRIPT} --json '${escaped}' 2>&1`,
      { encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
    ).trim();
  } catch (e: any) {
    stdout = (e.stdout || "").trim();
    exitCode = e.status ?? 1;
  }

  // Parse JSON from stdout (gate may prepend log lines — find the JSON object)
  let parsed: any = null;
  const jsonStart = stdout.indexOf("{");
  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse(stdout.slice(jsonStart));
    } catch {
      // Partial JSON — fall through to exit-code-only routing
    }
  }

  // Determine decision from JSON + exit code
  const decision = resolveDecision(parsed, exitCode);

  return {
    ticket: undefined as any, // filled by caller
    decision: decision.decision,
    score: parsed?.score ?? 0,
    override: parsed?.override ?? false,
    raw_exit: exitCode,
    reason: decision.reason,
  };
}

/**
 * Resolve the final gate decision from parsed JSON + exit code.
 * The JSON 'decision' field takes priority; exit code is the fallback.
 */
function resolveDecision(parsed: any, exitCode: number): { decision: GateDecision; reason: string } {
  if (parsed && parsed.decision) {
    const dec = parsed.decision.toUpperCase();
    // Check for explicit override (FORCE_SWARM)
    if (parsed.override === true || dec === "FORCE_SWARM") {
      return { decision: "FORCE_SWARM", reason: "Gate override detected — full pipeline mandatory" };
    }
    if (dec === "SWARM") {
      return { decision: "SWARM", reason: `Gate score ${parsed.score?.toFixed(2)} > 0.45 — full pipeline` };
    }
    if (dec === "DIRECT") {
      return { decision: "DIRECT", reason: "Gate score below threshold — direct execution" };
    }
    if (dec === "SUGGEST") {
      return { decision: "SUGGEST", reason: "Gate suggests swarm — operator judgment (default: direct)" };
    }
  }

  // Fall back to exit code
  switch (exitCode) {
    case 0:
      // Exit 0 without parseable decision — treat as SWARM (score > 0.45 assumed)
      return { decision: "SWARM", reason: `Exit code ${exitCode} — SWARM (JSON parse fell back)` };
    case 1:
      return { decision: "ERROR", reason: "Gate error — proceeding without swarm (do not block)" };
    case 2:
      return { decision: "DIRECT", reason: "Exit code 2 — DIRECT" };
    case 3:
      return { decision: "SUGGEST", reason: "Exit code 3 — SUGGEST" };
    default:
      return { decision: "ERROR", reason: `Unknown exit code ${exitCode}` };
  }
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

export interface DispatchBatch {
  results: DispatchResult[];
  counts: { DIRECT: number; SWARM: number; FORCE_SWARM: number; SUGGEST: number; ERROR: number };
}

export interface DispatcherDeps {
  productPreflight: (ticket: IntakeTicket) => Promise<ProductPreflightResult>;
  gameSeedPreflight: (ticket: IntakeTicket) => Promise<GameSeedPreflightResult>;
  gameManifestPreflight: (ticket: IntakeTicket) => Promise<GameManifestPreflightResult>;
  gameHarnessPreflight: (ticket: IntakeTicket) => Promise<GameHarnessPreflightResult>;
  gameScorePreflight: (ticket: IntakeTicket) => Promise<GameScorePreflightResult>;
  swarmGate: (ticketSummary: string) => DispatchResult;
  factoryControl: (
    input: { readonly ticket_identifier: string; readonly dispatch_result: DispatchResult },
    continuation: () => DispatchResult | Promise<DispatchResult>,
  ) => Promise<FactoryControlOutcome<DispatchResult>>;
}

/**
 * SF-006 T3: pre-dispatch dedup check for one ticket. Ledger-first with an
 * injected-at-callsite real probe; the incoming seed hash comes from a
 * pre-generated seed-<identifier>.yaml when one exists. Returns null when the
 * check itself fails in shadow (advisory — never blocks); rethrows in enforce
 * (fail-loud, never silently proceed past a broken gate).
 */
async function dedupCheck(ticket: IntakeTicket, index: LedgerIndex): Promise<DedupDecision | null> {
  const flags = currentFlags();
  try {
    let seedHash: string | null = null;
    const seedPath = join(import.meta.dir, "..", `seed-${ticket.identifier.toLowerCase()}.yaml`);
    if (existsSync(seedPath)) seedHash = hashSeedFile(seedPath);
    const decision = await decideDedup(
      { ticket_id: ticket.linear_id, identifier: ticket.identifier, seed_hash: seedHash },
      index,
      realProbe(),
      Date.now(),
      flags,
    );
    logDecision(ticket.linear_id, ticket.identifier, decision);
    return decision;
  } catch (err: any) {
    if (flags.enforce) throw err;
    console.error(`[sf006] ${ticket.identifier}: dedup check failed (shadow, advisory) — ${err.message}`);
    return null;
  }
}

export function resolveOutcomePolicy(ticket: IntakeTicket, risk: RiskTier | undefined): OutcomePolicyResolution | null {
  const policyPath = process.env.FACTORY_OUTCOME_POLICY_PATH;
  const catalogPath = process.env.FACTORY_OUTCOME_MODEL_CATALOG_PATH;
  if (!policyPath && !catalogPath) return null;
  if (!policyPath || !catalogPath) throw new Error("outcome routing requires both FACTORY_OUTCOME_POLICY_PATH and FACTORY_OUTCOME_MODEL_CATALOG_PATH");
  if (!existsSync(policyPath) || !existsSync(catalogPath)) throw new Error("configured outcome routing policy or model catalog is missing");
  const policy = JSON.parse(readFileSync(policyPath, "utf8")) as PromotedOutcomePolicy;
  const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as ModelProfile[];
  const fields = parseContractFields(ticket.description || "");
  const routeKey = (fields.archetype || fields.target_repo || "default").trim().toLowerCase();
  return resolvePromotedOutcomePolicy({ route_key: routeKey, risk_tier: risk ?? "high" }, policy, catalog);
}

/**
 * Dispatch a batch of valid tickets through the decision gate.
 * Each ticket gets its own gate invocation with title + description summary.
 *
 * SF-006 T3: when SF006_DEDUP is on, every ticket passes the dedup gate first.
 * Shadow logs would-skip/would-resume/would-park and routes unchanged; enforce
 * (SF006_ENFORCE=1, operator-only) makes skip/park terminal no-ops with a
 * Linear comment and hands resume context to swarm-exec via result.dedup.
 * Both flags off → this function's behavior is byte-identical to pre-SF-006.
 */
export async function dispatchTickets(
  tickets: IntakeTicket[],
  deps: Partial<DispatcherDeps> = {},
): Promise<DispatchBatch> {
  const results: DispatchResult[] = [];
  if (!Array.isArray(tickets)) throw new Error("LINEAR_TICKETS_REQUIRED");
  for (const ticket of tickets) assertLegacyLinearTicket(ticket);
  const counts = { DIRECT: 0, SWARM: 0, FORCE_SWARM: 0, SUGGEST: 0, ERROR: 0 };
  const productPreflight = deps.productPreflight ?? ((ticket) => runProductPreflight(ticket));
  const gameSeedPreflight = deps.gameSeedPreflight ?? (() => Promise.resolve(runGameSeedPreflight()));
  const gameManifestPreflight = deps.gameManifestPreflight ?? (() => Promise.resolve(runGameManifestPreflight()));
  const gameHarnessPreflight = deps.gameHarnessPreflight ?? (() => Promise.resolve(runGameHarnessPreflight()));
  const gameScorePreflight = deps.gameScorePreflight ?? (() => Promise.resolve(runGameScorePreflight()));
  const swarmGate = deps.swarmGate ?? runGate;
  const factoryControl = deps.factoryControl ?? runFactoryControlGate;

  const sf006 = currentFlags();
  let dedupIndex: LedgerIndex | null = null;
  if (sf006.dedup) {
    try {
      dedupIndex = deriveIndex();
    } catch (err: any) {
      if (sf006.enforce) throw new Error(`[sf006] ledger index unreadable in ENFORCE — refusing to dispatch: ${err.message}`);
      console.error(`[sf006] ledger index failed (shadow, advisory) — ${err.message}`);
    }
  }

  for (const ticket of tickets) {
    let productGate: ProductPreflightResult | undefined;
    try {
      productGate = await productPreflight(ticket);
      if (productGate.mode !== "off") {
        console.error(`[product-gate] ${ticket.identifier}: ${productGateSummary(productGate)}`);
      }
      if (productGate.acted) continue;
      if (productGate.mode === "off") productGate = undefined;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (productGateMode() === "enforce") {
        throw new Error(`[product-gate] ${ticket.identifier}: preflight unavailable in enforce mode: ${detail}`);
      }
      console.error(`[product-gate] ${ticket.identifier}: preflight unavailable (shadow) — ${detail}`);
    }

    const gameSeedGate = await gameSeedPreflight(ticket);
    if (gameSeedGate.mode !== "off") {
      console.error(`[game-seed-gate] ${ticket.identifier}: ${gameSeedPreflightSummary(gameSeedGate)}`);
      if (!gameSeedGate.allowed) continue;
    }

    const gameManifestGate = await gameManifestPreflight(ticket);
    if (gameManifestGate.mode !== "off") {
      console.error(`[game-manifest-gate] ${ticket.identifier}: ${gameManifestPreflightSummary(gameManifestGate)}`);
      if (!gameManifestGate.allowed) continue;
    }

    const gameHarnessGate = await gameHarnessPreflight(ticket);
    if (gameHarnessGate.mode !== "off") {
      console.error(`[game-harness-gate] ${ticket.identifier}: ${gameHarnessPreflightSummary(gameHarnessGate)}`);
      if (!gameHarnessGate.allowed) continue;
    }

    const gameScoreGate = await gameScorePreflight(ticket);
    if (gameScoreGate.mode !== "off") {
      console.error(`[game-score-gate] ${ticket.identifier}: ${gameScorePreflightSummary(gameScoreGate)}`);
      if (!gameScoreGate.allowed) continue;
    }

    let dedup: DedupDecision | null = null;
    if (sf006.dedup && dedupIndex) {
      dedup = await dedupCheck(ticket, dedupIndex);
      if (dedup && dedup.decision !== "proceed") {
        if (dedup.acted && (dedup.decision === "skip_duplicate" || dedup.decision === "park_verify_failed")) {
          console.error(`[sf006] ${ticket.identifier}: ${dedup.decision.toUpperCase()} (ENFORCE) — ${dedup.reason}`);
          const commented = await postDedupComment(ticket.linear_id, dedup);
          if (!commented) {
            console.error(`[sf006] ${ticket.identifier}: Linear comment FAILED — decision remains logged in state/dedup-decisions.jsonl`);
          }
          continue; // terminal no-op: no gate run, no execution
        }
        if (dedup.acted) {
          console.error(`[sf006] ${ticket.identifier}: RESUME_FROM_CHECKPOINT (ENFORCE) — ${dedup.reason}`);
        } else {
          const would =
            dedup.decision === "skip_duplicate"
              ? "would-skip"
              : dedup.decision === "resume_from_checkpoint"
                ? "would-resume"
                : "would-park";
          console.error(`[sf006] ${ticket.identifier}: ${would} (shadow) — ${dedup.reason}`);
        }
      }
    }

    // Build a concise summary for the gate
    const summary = buildTicketSummary(ticket);
    const gateResult = swarmGate(summary);
    gateResult.ticket = ticket;
    gateResult.author_identity = ticketAuthor(ticket, {
      provider: process.env.FACTORY_AUTHOR_PROVIDER || "unknown",
      model: process.env.FACTORY_AUTHOR_MODEL || "unknown",
    });
    if (productGate) gateResult.product_gate = productGate;
    if (gameSeedGate.mode !== "off") gateResult.game_seed_gate = gameSeedGate;
    if (gameManifestGate.mode !== "off") gateResult.game_manifest_gate = gameManifestGate;
    if (gameHarnessGate.mode !== "off") gateResult.game_harness_gate = gameHarnessGate;
    if (gameScoreGate.mode !== "off") gateResult.game_score_gate = gameScoreGate;
    if (dedup) gateResult.dedup = dedup;

    // SF-002 T4: advisory risk preview (authoritative verdict is written by swarm-exec)
    if (process.env.SF002_CLASSIFY !== "0") {
      try {
        const f = parseContractFields(ticket.description || "");
        const inputs = buildInputs(
          { archetype: f.archetype, target_repo: f.target_repo, repro: f.repro ?? f.area, acceptance_criteria: f.acceptance_criteria },
          `${ticket.title}\n${ticket.description || ""}`,
          gateResult.decision,
          null
        );
        const { score } = scoreRisk(inputs);
        gateResult.risk_preview = { tier: tierFor(score), score };
      } catch {
        // advisory only — never block dispatch
      }
    }
    const outcomePolicy = resolveOutcomePolicy(ticket, gateResult.risk_preview?.tier);
    if (outcomePolicy) gateResult.outcome_policy = outcomePolicy;

    const continueDispatch = (): DispatchResult => {
      results.push(gateResult);
      counts[gateResult.decision]++;
      zcrShadowObserve("factory", {
        ticketIdentifier: ticket.identifier,
        decision: gateResult.decision,
        score: gateResult.score,
        dispatchId: `${ticket.identifier}/${Date.now().toString(36)}`,
      });
      console.error(
        `[dispatch] ${ticket.identifier}: ${gateResult.decision} (score=${gateResult.score.toFixed(2)}, override=${gateResult.override}) — ${gateResult.reason}` +
          (gateResult.risk_preview ? ` [risk=${gateResult.risk_preview.tier} ${gateResult.risk_preview.score}]` : "")
      );
      return gateResult;
    };
    const control = await factoryControl(
      { ticket_identifier: ticket.identifier, dispatch_result: gateResult },
      continueDispatch,
    );
    if (control.host_effect !== "performed") {
      console.error(
        `[factory-control] ${ticket.identifier}: ${control.decision.toUpperCase()} (${control.mode}, ${control.host_effect}) — ${control.reason_codes.join(",") || "no_reason"}`,
      );
    }
  }

  return { results, counts };
}

/**
 * Build a concise summary for the decision gate.
 *
 * Extracts the semantic contract fields (acceptance_criteria, repro/area) and
 * leads the summary with them so the gate scores implementation density, not
 * factory-contract boilerplate that dominates the first 500 chars of every
 * Intake ticket. Falls back to raw description truncation when no fields parse.
 */
function buildTicketSummary(ticket: IntakeTicket): string {
  const desc = ticket.description || "";
  const fields = parseContractFields(desc);
  const ac = fields["acceptance_criteria"] || "";
  const repro = fields["repro"] || fields["area"] || fields["repro_/_area"] || "";
  const archetype = fields["archetype"] ? `[${fields["archetype"]}]` : "";

  if (ac || repro) {
    // Lead with implementation substance; cap total to ~800 chars to stay under shell arg limits
    const parts = [ticket.title, archetype, ac, repro].filter(Boolean).join(". ");
    return parts.slice(0, 800);
  }

  // Fallback: raw description, but use a wider window than the old 500-char cap
  return `${ticket.title}. ${desc.slice(0, 700)}`;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function loadTickets(source: string): IntakeTicket[] {
  const raw = source === "-" ? readFileSync("/dev/stdin", "utf-8") : readFileSync(source, "utf-8");
  return coerceTicketArray(JSON.parse(raw));
}

/**
 * Accept both a bare IntakeTicket[] and the { valid, rejected } wrapper that
 * ticket-contract.ts emits — the conveyor pipes the validator's output straight
 * in, and dispatch only ever routes the `valid` tickets. Without this, the
 * wrapper object reaches the `for…of` loop and dies with "undefined is not a
 * function (…ticket of tickets…)".
 */
export function coerceTicketArray(parsed: unknown): IntakeTicket[] {
  if (Array.isArray(parsed)) {
    for (const ticket of parsed) assertLegacyLinearTicket(ticket);
    return parsed as IntakeTicket[];
  }
  if (parsed && typeof parsed === "object" && Array.isArray((parsed as { valid?: unknown }).valid)) {
    const tickets = (parsed as { valid: unknown[] }).valid;
    for (const ticket of tickets) assertLegacyLinearTicket(ticket);
    return tickets as IntakeTicket[];
  }
  throw new Error("--tickets input must be an IntakeTicket[] or a { valid: IntakeTicket[] } object (from ticket-contract.ts)");
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      tickets: { type: "string", short: "t" },
      "dry-run": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: false,
  });

  if (values.help || !values.tickets) {
    console.log(`
dispatcher — Route valid tickets through the swarm decision gate

USAGE:
  bun dispatcher.ts --tickets <json-file>     # Dispatch from JSON file
  bun dispatcher.ts --tickets -               # Dispatch from stdin
  bun dispatcher.ts --dry-run --tickets <json>  # Route only, no execution
  bun dispatcher.ts --help

ROUTING:
  DIRECT (exit 2)       → execute directly (no swarm overhead)
  SWARM (exit 0, >0.45) → full pipeline (interview → seed → eval → execute → post-flight → gap audit)
  FORCE_SWARM (override)→ full pipeline (mandatory, no judgment call)
  SUGGEST (exit 3)      → operator judgment (default: proceed direct with note)
  ERROR (exit 1)        → proceed without gate, do not block

OUTPUT:
  JSON array of DispatchResult to stdout.
`);
    process.exit(0);
  }

  const dryRun = Boolean(values["dry-run"]);
  const tickets = loadTickets(values.tickets as string);

  if (tickets.length === 0) {
    console.log("[]");
    process.exit(0);
  }

  console.error(`[dispatch] Dispatching ${tickets.length} ticket(s) through the gate...`);
  const batch = await dispatchTickets(tickets);

  console.error(
    `[dispatch] Results: DIRECT=${batch.counts.DIRECT} SWARM=${batch.counts.SWARM} FORCE_SWARM=${batch.counts.FORCE_SWARM} SUGGEST=${batch.counts.SUGGEST} ERROR=${batch.counts.ERROR}`
  );

  if (dryRun) {
    console.error("[dispatch] Dry-run mode — no execution invoked");
  }

  // Output results as JSON to stdout
  console.log(JSON.stringify(batch.results, null, 2));
}

// Guarded so the module is importable (e.g. by prespec-runner, which reuses
// runGate) WITHOUT executing the dispatch CLI at import time.
if (import.meta.main) {
  main().catch((err) => {
    console.error("FATAL:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
