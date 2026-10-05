#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T2 (SF-002) — Progressive-Permission Ladder
 *
 * File-backed ladder at state/permission-ladder.json.
 * Rungs: read-only → branch-write → open-pr → staging → production.
 * Initialized at 'open-pr' (SF-002 seed). NEVER auto-advances — rung
 * changes only via explicit operator CLI, every change logged.
 *
 * Usage:
 *   bun permission-ladder.ts status
 *   bun permission-ladder.ts set <rung> --note "why"
 *   bun permission-ladder.ts check <action>   # exit 0 allowed / 1 denied
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";

// ─── Types ────────────────────────────────────────────────────────────────────

export const RUNGS = ["read-only", "branch-write", "open-pr", "staging", "production"] as const;
export type Rung = (typeof RUNGS)[number];

export type FactoryAction = "read" | "branch-write" | "open-pr" | "deploy-staging" | "deploy-production";

const ACTION_MIN_RUNG: Record<FactoryAction, Rung> = {
  read: "read-only",
  "branch-write": "branch-write",
  "open-pr": "open-pr",
  "deploy-staging": "staging",
  "deploy-production": "production",
};

export interface RungTransition {
  from: Rung | null;
  to: Rung;
  at: string;
  by: string;
  note: string;
}

export interface LadderState {
  current_rung: Rung;
  set_at: string;
  set_by: string;
  note: string;
  transition_log: RungTransition[];
}

// ─── State I/O ────────────────────────────────────────────────────────────────

const STATE_DIR = factoryStateRoot();
const LADDER_PATH = join(STATE_DIR, "permission-ladder.json");

function initState(): LadderState {
  const t: RungTransition = {
    from: null,
    to: "open-pr",
    at: new Date().toISOString(),
    by: "init",
    note: "initialized at open-pr per SF-002 seed (production output is always a PR)",
  };
  return { current_rung: "open-pr", set_at: t.at, set_by: t.by, note: t.note, transition_log: [t] };
}

export function loadLadder(): LadderState {
  if (!existsSync(LADDER_PATH)) {
    const state = initState();
    saveLadder(state);
    return state;
  }
  const state = JSON.parse(readFileSync(LADDER_PATH, "utf-8")) as LadderState;
  if (!RUNGS.includes(state.current_rung)) {
    console.error(`FATAL: corrupt ladder state — unknown rung '${state.current_rung}' in ${LADDER_PATH}`);
    process.exit(2);
  }
  return state;
}

function saveLadder(state: LadderState): void {
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(LADDER_PATH, JSON.stringify(state, null, 2));
}

// ─── API ──────────────────────────────────────────────────────────────────────

export function isActionAllowed(action: FactoryAction, state?: LadderState): boolean {
  const s = state ?? loadLadder();
  const need = RUNGS.indexOf(ACTION_MIN_RUNG[action]);
  const have = RUNGS.indexOf(s.current_rung);
  return have >= need;
}

export function setRung(to: Rung, by: string, note: string): LadderState {
  if (!RUNGS.includes(to)) {
    console.error(`FATAL: unknown rung '${to}'. Valid: ${RUNGS.join(" | ")}`);
    process.exit(2);
  }
  if (!note.trim()) {
    console.error("FATAL: --note is required for rung changes (audit discipline)");
    process.exit(2);
  }
  const state = loadLadder();
  const t: RungTransition = {
    from: state.current_rung,
    to,
    at: new Date().toISOString(),
    by,
    note,
  };
  state.transition_log.push(t);
  state.current_rung = to;
  state.set_at = t.at;
  state.set_by = by;
  state.note = note;
  saveLadder(state);
  return state;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function main() {
  const cmd = Bun.argv[2];
  const { values, positionals } = parseArgs({
    args: Bun.argv.slice(3),
    options: {
      note: { type: "string" },
      by: { type: "string", default: "operator-cli" },
    },
    allowPositionals: true,
    strict: false,
  });

  if (cmd === "status") {
    const s = loadLadder();
    console.log(`Current rung : ${s.current_rung}`);
    console.log(`Set at       : ${s.set_at} by ${s.set_by}`);
    console.log(`Note         : ${s.note}`);
    console.log(`Transitions  : ${s.transition_log.length}`);
    console.log(`\nAction permissions:`);
    for (const a of Object.keys(ACTION_MIN_RUNG) as FactoryAction[]) {
      console.log(`  ${isActionAllowed(a, s) ? "✓ allowed" : "✗ denied "} ${a}`);
    }
    process.exit(0);
  }

  if (cmd === "set") {
    const to = positionals[0] as Rung | undefined;
    if (!to) {
      console.error(`Usage: permission-ladder.ts set <${RUNGS.join("|")}> --note "why"`);
      process.exit(2);
    }
    const s = setRung(to, String(values.by ?? "operator-cli"), String(values.note ?? ""));
    console.log(`Rung set: ${s.transition_log[s.transition_log.length - 1].from} → ${s.current_rung}`);
    process.exit(0);
  }

  if (cmd === "check") {
    const action = positionals[0] as FactoryAction | undefined;
    if (!action || !(action in ACTION_MIN_RUNG)) {
      console.error(`Usage: permission-ladder.ts check <${Object.keys(ACTION_MIN_RUNG).join("|")}>`);
      process.exit(2);
    }
    const allowed = isActionAllowed(action);
    console.log(`${action}: ${allowed ? "ALLOWED" : "DENIED"} (rung: ${loadLadder().current_rung})`);
    process.exit(allowed ? 0 : 1);
  }

  console.error("Commands: status | set <rung> --note <why> | check <action>");
  process.exit(2);
}

if (import.meta.main) main();
