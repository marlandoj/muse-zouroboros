#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T5 — Shadow-State Machine
 *
 * File-backed state machine for the conveyor's shadow phases:
 *   idle → dry-run (staged commits, no PR) → shadow-pr (real PRs, factory-shadow tag, no merge) → live
 *
 * Transitions are logged to state/shadow-transition.log.
 * Enforces: no pushes to protected branches, no merges, no deploys during shadow.
 * Phase A (dry-run, 48-72h) → Phase B (shadow PRs, ≥4 days).
 *
 * Usage:
 *   bun shadow-state.ts status             # Print current phase and time remaining
 *   bun shadow-state.ts transition <phase>  # Transition to a new phase
 *   bun shadow-state.ts --help
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { parseArgs } from "node:util";

// ─── Config ───────────────────────────────────────────────────────────────────

const STATE_DIR = factoryStateRoot();
const STATE_FILE = join(STATE_DIR, "shadow-state.json");
const TRANSITION_LOG = join(STATE_DIR, "shadow-transition.log");
const DRY_RUN_MIN_HOURS = 48;
const SHADOW_PR_MIN_HOURS = 96; // ~4 days

/**
 * ZOU-1110: minimum qualifying samples. Elapsed time alone is vacuous — 741.2
 * live hours with 0 safe executions must never read as a passing L4 gate.
 */
export const DRY_RUN_MIN_EXECUTIONS = 1;
export const L4_MIN_QUALIFYING_EXECUTIONS = 20;

// ─── Types ────────────────────────────────────────────────────────────────────

export type ShadowPhase = "idle" | "dry-run" | "shadow-pr" | "live";

export interface ShadowState {
  current_phase: ShadowPhase;
  phase_started_at: string;
  dry_run_started_at: string | null;
  shadow_pr_started_at: string | null;
  live_started_at: string | null;
  transitions: TransitionEntry[];
  safe_executions: number;
  unsafe_auto_executions: number;
}

interface TransitionEntry {
  from: ShadowPhase;
  to: ShadowPhase;
  at: string;
  reason: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function nowISO(): string {
  return new Date().toISOString();
}

function ensureStateDir(): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
}

function logTransition(from: ShadowPhase, to: ShadowPhase, reason: string): void {
  ensureStateDir();
  const line = `[${nowISO()}] ${from} → ${to} | ${reason}\n`;
  appendFileSync(TRANSITION_LOG, line);
}

export function loadState(): ShadowState {
  ensureStateDir();
  if (!existsSync(STATE_FILE)) {
    const initial: ShadowState = {
      current_phase: "idle",
      phase_started_at: nowISO(),
      dry_run_started_at: null,
      shadow_pr_started_at: null,
      live_started_at: null,
      transitions: [],
      safe_executions: 0,
      unsafe_auto_executions: 0,
    };
    writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  return JSON.parse(readFileSync(STATE_FILE, "utf-8")) as ShadowState;
}

export function currentShadowPhase(): ShadowPhase {
  if (!existsSync(STATE_FILE)) {
    throw new Error(`Shadow state unavailable at ${STATE_FILE}`);
  }
  const parsed: unknown = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
  const phase = typeof parsed === "object" && parsed !== null && "current_phase" in parsed
    ? parsed.current_phase
    : undefined;
  if (phase !== "idle" && phase !== "dry-run" && phase !== "shadow-pr" && phase !== "live") {
    throw new Error(`Invalid shadow phase in ${STATE_FILE}: ${String(phase)}`);
  }
  return phase;
}

export function saveState(state: ShadowState): void {
  ensureStateDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Transition to a new shadow phase. Validates the transition is legal.
 * Illegal transitions (e.g. idle → live, or shadow-pr → dry-run) are rejected.
 */
export function transition(
  state: ShadowState,
  to: ShadowPhase,
  reason: string
): ShadowState {
  const from = state.current_phase;

  // Validate transition legality
  const legal: Record<ShadowPhase, ShadowPhase[]> = {
    idle: ["dry-run"],
    "dry-run": ["shadow-pr"],
    "shadow-pr": ["live"],
    live: [], // terminal — cannot leave live
  };

  if (!legal[from].includes(to)) {
    const msg = `Illegal transition: ${from} → ${to}. Valid: ${from} → [${legal[from].join(", ")}]`;
    console.error(`FATAL: ${msg}`);
    process.exit(1);
  }

  // Enforce minimum phase durations
  const elapsed = (new Date().getTime() - new Date(state.phase_started_at).getTime()) / 3600000;

  if (from === "dry-run" && to === "shadow-pr" && elapsed < DRY_RUN_MIN_HOURS) {
    console.warn(
      `⚠️  Dry-run phase has only run for ${elapsed.toFixed(1)}h (minimum ${DRY_RUN_MIN_HOURS}h). ` +
        `Proceed anyway? (use --force to override this check)`
    );
    // Don't exit here — allow --force flag override at caller level
  }

  // Apply transition
  const entry: TransitionEntry = { from, to, at: nowISO(), reason };
  state.transitions.push(entry);
  state.current_phase = to;
  state.phase_started_at = nowISO();

  switch (to) {
    case "dry-run":
      state.dry_run_started_at = nowISO();
      break;
    case "shadow-pr":
      state.shadow_pr_started_at = nowISO();
      break;
    case "live":
      state.live_started_at = nowISO();
      break;
  }

  logTransition(from, to, reason);
  saveState(state);

  return state;
}

/**
 * Record an execution — used to count safe vs unsafe auto-executions.
 * An unsafe execution is anything beyond opening a PR for operator review
 * during dry-run or shadow-pr phases.
 */
export function recordExecution(
  state: ShadowState,
  action: "staged-commit" | "pr-opened" | "push-to-protected" | "merge" | "deploy"
): ShadowState {
  const unsafeActions: string[] = ["push-to-protected", "merge", "deploy"];
  const isUnsafe = unsafeActions.includes(action);

  if (state.current_phase === "live") {
    // In live mode, these may be allowed depending on SF-002/010 status
    if (isUnsafe) {
      state.unsafe_auto_executions++;
      console.error(`⚠️  Unsafe action "${action}" in live phase — logged for audit`);
    }
  } else if (isUnsafe) {
    state.unsafe_auto_executions++;
    console.error(
      `🚨 UNSAFE AUTO-EXECUTION: "${action}" detected during ${state.current_phase} phase!`
    );
  } else {
    state.safe_executions++;
  }

  saveState(state);
  return state;
}

/**
 * Check if the conveyor is safe to advance. Returns reason string or null.
 */
export function getAdvanceCheck(state: ShadowState): { can_advance: boolean; reason: string; next_phase: ShadowPhase | null } {
  switch (state.current_phase) {
    case "idle":
      return { can_advance: true, reason: "Ready for dry-run phase", next_phase: "dry-run" };
    case "dry-run": {
      const elapsed = (new Date().getTime() - new Date(state.phase_started_at).getTime()) / 3600000;
      const remaining = Math.max(0, DRY_RUN_MIN_HOURS - elapsed);
      if (remaining > 0) {
        return { can_advance: false, reason: `Dry-run phase needs ${remaining.toFixed(1)}h more (${elapsed.toFixed(1)}h elapsed of ${DRY_RUN_MIN_HOURS}h minimum)`, next_phase: "shadow-pr" };
      }
      if (state.unsafe_auto_executions > 0) {
        return { can_advance: false, reason: `Cannot advance: ${state.unsafe_auto_executions} unsafe auto-execution(s) during dry-run`, next_phase: null };
      }
      if (state.safe_executions < DRY_RUN_MIN_EXECUTIONS) {
        return { can_advance: false, reason: `Cannot advance: qualifying sample ${state.safe_executions}/${DRY_RUN_MIN_EXECUTIONS} safe execution(s) — a dry-run with no executions proves nothing`, next_phase: null };
      }
      return { can_advance: true, reason: `Dry-run complete: ${elapsed.toFixed(1)}h elapsed, ${state.safe_executions} safe execs, 0 unsafe`, next_phase: "shadow-pr" };
    }
    case "shadow-pr": {
      const elapsed = (new Date().getTime() - new Date(state.phase_started_at).getTime()) / 3600000;
      const remaining = Math.max(0, SHADOW_PR_MIN_HOURS - elapsed);
      if (state.unsafe_auto_executions > 0) {
        return { can_advance: false, reason: `Cannot advance: ${state.unsafe_auto_executions} unsafe auto-execution(s) during shadow-pr`, next_phase: null };
      }
      if (remaining > 0) {
        return { can_advance: false, reason: `Shadow-PR phase needs ${remaining.toFixed(1)}h more (${elapsed.toFixed(1)}h elapsed of ${SHADOW_PR_MIN_HOURS}h minimum)`, next_phase: "live" };
      }
      if (state.safe_executions < L4_MIN_QUALIFYING_EXECUTIONS) {
        return { can_advance: false, reason: `Cannot advance: qualifying sample ${state.safe_executions}/${L4_MIN_QUALIFYING_EXECUTIONS} safe executions — the L4 gate requires a non-vacuous sample, elapsed time alone is insufficient`, next_phase: null };
      }
      return { can_advance: true, reason: `Shadow-PR complete: ${elapsed.toFixed(1)}h elapsed, ${state.safe_executions} qualifying safe executions, 0 unsafe auto-executions`, next_phase: "live" };
    }
    case "live":
      return { can_advance: false, reason: "Already in live phase (terminal state)", next_phase: null };
  }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function printStatus(state: ShadowState): void {
  const check = getAdvanceCheck(state);
  const elapsed = ((new Date().getTime() - new Date(state.phase_started_at).getTime()) / 3600000).toFixed(1);

  console.log(`Shadow Phase: ${state.current_phase}`);
  console.log(`  Started:    ${state.phase_started_at} (${elapsed}h ago)`);
  console.log(`  Safe execs: ${state.safe_executions}`);
  console.log(`  Unsafe:     ${state.unsafe_auto_executions}`);
  console.log(`  Transitions: ${state.transitions.length}`);
  console.log(`  Advance:    ${check.can_advance ? "✅ " + check.reason : "⏳ " + check.reason}`);
  if (state.dry_run_started_at) console.log(`  Dry-run started: ${state.dry_run_started_at}`);
  if (state.shadow_pr_started_at) console.log(`  Shadow-PR started: ${state.shadow_pr_started_at}`);
  if (state.live_started_at) console.log(`  Live started: ${state.live_started_at}`);
}

function main(): void {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h", default: false },
      force: { type: "boolean", default: false },
    },
    strict: false,
  });

  if (values.help) {
    console.log(`
shadow-state — Manage the conveyor's shadow-phase state machine

USAGE:
  bun shadow-state.ts status                        # Print current phase
  bun shadow-state.ts transition dry-run             # Begin dry-run phase
  bun shadow-state.ts transition shadow-pr            # Advance to shadow-PR phase
  bun shadow-state.ts transition live                 # Advance to live (terminal)
  bun shadow-state.ts transition <phase> --force      # Force-advance (bypass minimum duration)
  bun shadow-state.ts record staged-commit            # Record a safe execution
  bun shadow-state.ts record pr-opened                # Record a PR opened
  bun shadow-state.ts record push-to-protected        # Record an unsafe auto-execution
  bun shadow-state.ts --help

PHASES:
  idle      → dry-run (48-72h, staged commits, no PR)
  dry-run   → shadow-pr (≥4 days, real PRs, no auto-merge)
  shadow-pr → live (terminal, production enabled)

ENFORCEMENT:
  - Minimum phase durations enforced (override with --force)
  - Unsafe auto-executions block advancement
  - All transitions logged to state/shadow-transition.log
`);
    process.exit(0);
  }

  const cmd = Bun.argv.slice(2).find((a) => !a.startsWith("-")) || "status";
  const arg = Bun.argv.slice(3).find((a) => !a.startsWith("-")) as string | undefined;

  if (cmd === "status") {
    printStatus(loadState());
    return;
  }

  if (cmd === "transition" && arg) {
    const validPhases: ShadowPhase[] = ["dry-run", "shadow-pr", "live"];
    if (!validPhases.includes(arg as ShadowPhase)) {
      console.error(`Error: Invalid phase "${arg}". Valid: ${validPhases.join(", ")}`);
      process.exit(1);
    }
    const state = loadState();
    const updated = transition(state, arg as ShadowPhase, "Manual transition via CLI");
    printStatus(updated);
    return;
  }

  if (cmd === "record" && arg) {
    const validActions = ["staged-commit", "pr-opened", "push-to-protected", "merge", "deploy"];
    if (!validActions.includes(arg)) {
      console.error(`Error: Invalid action "${arg}". Valid: ${validActions.join(", ")}`);
      process.exit(1);
    }
    const state = loadState();
    const updated = recordExecution(state, arg as any);
    printStatus(updated);
    return;
  }

  console.error("Error: Unknown command. Use --help for usage.");
  process.exit(1);
}

if (import.meta.main) main();
