#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T2 (SF-011) — Per-Archetype Line Config
 *
 * Committed JSON (line-config.json, SF-005 slo-config.json precedent) declaring
 * the harness posture of each assembly line: mandatory gates (declarative in
 * v1), a permission-rung CAP, auto-merge eligibility, and a risk-posture label.
 *
 * Invariants:
 *  - max_rung is a CAP: effectiveRung = min(global ladder rung, line max_rung).
 *    SF-011 NEVER advances the ladder and NEVER writes ladder state.
 *  - auto_merge_eligible=false only TIGHTENS: the sf010 hook skips lane
 *    evaluation for that line; the SF-010 allowlist stays the merge truth.
 *  - Absent config file ⇒ built-in defaults identical to the shipped JSON.
 *    Present-but-invalid ⇒ fail-loud (a torn config must never silently
 *    loosen the migration line).
 *
 * Usage:
 *   bun line-config.ts show [--json]
 *   bun line-config.ts self-test
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { RUNGS, type Rung } from "./permission-ladder";
import { LINES, type Line } from "./archetype-classifier";
import { isExecutionRecordFileName } from "./execution-lifecycle";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RiskPosture = "aggressive" | "standard" | "conservative";

/** Gate names declarable as mandatory (v1: declarative, from the existing surface). */
export const KNOWN_GATES = [
  "sf002_classify",
  "seed_eval",
  "postflight",
  "consensus",
  "scenario_runner",
  "snake_pit",
] as const;
export type GateName = (typeof KNOWN_GATES)[number];

export interface LineRules {
  mandatory_gates: GateName[];
  max_rung: Rung;
  auto_merge_eligible: boolean;
  risk_posture: RiskPosture;
}

export type LineConfig = Record<Line, LineRules>;

export interface LoadedLineConfig {
  config: LineConfig;
  /** "file" when line-config.json parsed, "defaults" when absent. */
  source: "file" | "defaults";
  /** sha256 of the effective config (canonical JSON) — observability witness. */
  hash: string;
}

// ─── Defaults (identical to the shipped line-config.json) ─────────────────────

export const DEFAULT_LINE_CONFIG: LineConfig = {
  bugfix: {
    mandatory_gates: ["sf002_classify", "postflight"],
    max_rung: "staging",
    auto_merge_eligible: true,
    risk_posture: "aggressive",
  },
  dependency: {
    mandatory_gates: ["sf002_classify", "postflight"],
    max_rung: "staging",
    auto_merge_eligible: true,
    risk_posture: "aggressive",
  },
  docs: {
    mandatory_gates: ["sf002_classify", "postflight"],
    max_rung: "staging",
    auto_merge_eligible: true,
    risk_posture: "aggressive",
  },
  feature: {
    mandatory_gates: ["sf002_classify", "seed_eval", "postflight"],
    max_rung: "open-pr",
    auto_merge_eligible: true,
    risk_posture: "standard",
  },
  refactor: {
    mandatory_gates: ["sf002_classify", "seed_eval", "postflight"],
    max_rung: "open-pr",
    auto_merge_eligible: true,
    risk_posture: "standard",
  },
  migration: {
    mandatory_gates: ["sf002_classify", "seed_eval", "postflight", "scenario_runner"],
    max_rung: "branch-write",
    auto_merge_eligible: false,
    risk_posture: "conservative",
  },
};

const PROJECT_DIR = join(import.meta.dir, "..");

export function lineConfigPath(base = PROJECT_DIR): string {
  return join(base, "line-config.json");
}

// ─── Validation (fail-loud) ───────────────────────────────────────────────────

function validateLineConfig(raw: unknown, path: string): LineConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${path}: config root must be an object keyed by line name`);
  }
  const obj = raw as Record<string, unknown>;
  const keys = Object.keys(obj);
  for (const k of keys) {
    if (!(LINES as readonly string[]).includes(k)) {
      throw new Error(`${path}: unknown line '${k}' (valid: ${LINES.join(", ")})`);
    }
  }
  const RULE_KEYS = ["mandatory_gates", "max_rung", "auto_merge_eligible", "risk_posture"];
  for (const line of LINES) {
    if (!(line in obj)) throw new Error(`${path}: missing line '${line}' — all 6 lines must be declared`);
    const r = obj[line] as Record<string, unknown>;
    if (typeof r !== "object" || r === null) throw new Error(`${path}: line '${line}' must be an object`);
    // Strict shape: an unknown key is likely a typo of a tightening knob —
    // silently ignoring it would loosen the line (cg-1783026015383).
    for (const k of Object.keys(r)) {
      if (!RULE_KEYS.includes(k)) {
        throw new Error(`${path}: ${line} has unknown field '${k}' (valid: ${RULE_KEYS.join(", ")})`);
      }
    }
    if (!Array.isArray(r.mandatory_gates)) throw new Error(`${path}: ${line}.mandatory_gates must be an array`);
    for (const g of r.mandatory_gates) {
      if (!(KNOWN_GATES as readonly string[]).includes(g as string)) {
        throw new Error(`${path}: ${line}.mandatory_gates has unknown gate '${g}' (valid: ${KNOWN_GATES.join(", ")})`);
      }
    }
    if (new Set(r.mandatory_gates).size !== r.mandatory_gates.length) {
      throw new Error(`${path}: ${line}.mandatory_gates has duplicate entries`);
    }
    if (!(RUNGS as readonly string[]).includes(r.max_rung as string)) {
      throw new Error(`${path}: ${line}.max_rung '${r.max_rung}' invalid (valid: ${RUNGS.join(", ")})`);
    }
    if (typeof r.auto_merge_eligible !== "boolean") {
      throw new Error(`${path}: ${line}.auto_merge_eligible must be boolean`);
    }
    if (!["aggressive", "standard", "conservative"].includes(r.risk_posture as string)) {
      throw new Error(`${path}: ${line}.risk_posture '${r.risk_posture}' invalid`);
    }
  }
  return obj as unknown as LineConfig;
}

/** sha256 PREFIX (16 hex / 64 bits): a drift witness for observability, not a security primitive. */
function configHash(config: LineConfig): string {
  const canonical = JSON.stringify(
    Object.fromEntries((LINES as readonly Line[]).map((l) => [l, config[l]])),
  );
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

/**
 * Load the line config. Absent file ⇒ defaults; present-but-invalid ⇒ THROW
 * (fail-loud — a torn config must never silently loosen a conservative line).
 */
export function loadLineConfig(path = lineConfigPath()): LoadedLineConfig {
  if (!existsSync(path)) {
    return { config: DEFAULT_LINE_CONFIG, source: "defaults", hash: configHash(DEFAULT_LINE_CONFIG) };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${path}: unparseable line config — ${err instanceof Error ? err.message : err}`);
  }
  const config = validateLineConfig(raw, path);
  return { config, source: "file", hash: configHash(config) };
}

// ─── Rung cap (pure) ──────────────────────────────────────────────────────────

/**
 * effective = min(global, cap) on the RUNGS ladder. Cap only — never advances.
 * A value outside RUNGS (type-erred caller) resolves to the most restrictive
 * rung instead of undefined — fail-conservative (cg-1783026015383).
 */
export function effectiveRung(global: Rung, cap: Rung): Rung {
  const gi = RUNGS.indexOf(global);
  const ci = RUNGS.indexOf(cap);
  if (gi === -1 || ci === -1) return RUNGS[0];
  return RUNGS[Math.min(gi, ci)];
}

/** Rules for a classified line; "unknown" gets the most conservative line's rules. */
export function rulesForLine(line: Line | "unknown", config: LineConfig): LineRules {
  return line === "unknown" ? config.migration : config[line];
}

// ─── Observability (SF-011 snapshot for shadow-validate) ─────────────────────

export interface SF011Snapshot {
  flag_lines: boolean;
  flag_enforce: boolean;
  config_source: "file" | "defaults" | "invalid";
  config_hash: string | null;
  config_error: string | null;
  /** exec records carrying an SF-011 archetype stamp (of total readable). */
  stamped_execs: number;
  total_execs: number;
  by_line: Record<string, number>;
  by_source: Record<string, number>;
  declared_vs_inferred_disagreements: number;
  unreadable_execs: number;
}

/** Never throws — corrupt state/config degrade to counted warnings, not errors. */
export function sf011Snapshot(
  stateDir = resolveFactoryStateOverride(process.env.SF011_STATE_DIR),
  configPath = lineConfigPath(),
): SF011Snapshot {
  const snap: SF011Snapshot = {
    flag_lines: process.env.SF011_LINES === "1",
    flag_enforce: process.env.SF011_ENFORCE === "1",
    config_source: "invalid",
    config_hash: null,
    config_error: null,
    stamped_execs: 0,
    total_execs: 0,
    by_line: {},
    by_source: {},
    declared_vs_inferred_disagreements: 0,
    unreadable_execs: 0,
  };
  try {
    const loaded = loadLineConfig(configPath);
    snap.config_source = loaded.source;
    snap.config_hash = loaded.hash;
  } catch (err) {
    snap.config_error = err instanceof Error ? err.message : String(err);
  }
  try {
    if (existsSync(stateDir)) {
      for (const f of readdirSync(stateDir).sort()) {
        if (!isExecutionRecordFileName(f)) continue;
        try {
          const rec = JSON.parse(readFileSync(join(stateDir, f), "utf-8")) as {
            archetype?: { line?: string; source?: string; disagreement?: boolean };
          };
          snap.total_execs++;
          const a = rec.archetype;
          if (a && typeof a.line === "string" && typeof a.source === "string") {
            snap.stamped_execs++;
            snap.by_line[a.line] = (snap.by_line[a.line] ?? 0) + 1;
            snap.by_source[a.source] = (snap.by_source[a.source] ?? 0) + 1;
            if (a.disagreement === true) snap.declared_vs_inferred_disagreements++;
          }
        } catch {
          snap.unreadable_execs++;
        }
      }
    }
  } catch {
    // stateDir listing failure: leave zero counts — snapshot never throws
  }
  return snap;
}

// ─── Self-test ────────────────────────────────────────────────────────────────

function selfTest(): number {
  let failed = 0;
  const check = (name: string, ok: boolean) => {
    if (!ok) failed++;
    console.log(`${ok ? "✓" : "✗"} ${name}`);
  };

  // Defaults sanity
  check("defaults: migration conservative, branch-write, no auto-merge",
    DEFAULT_LINE_CONFIG.migration.risk_posture === "conservative" &&
    DEFAULT_LINE_CONFIG.migration.max_rung === "branch-write" &&
    DEFAULT_LINE_CONFIG.migration.auto_merge_eligible === false &&
    DEFAULT_LINE_CONFIG.migration.mandatory_gates.includes("scenario_runner"));
  check("defaults: bugfix/dependency/docs aggressive @ staging",
    (["bugfix", "dependency", "docs"] as const).every(
      (l) => DEFAULT_LINE_CONFIG[l].risk_posture === "aggressive" && DEFAULT_LINE_CONFIG[l].max_rung === "staging"));

  // effectiveRung math
  check("effectiveRung: migration cap branch-write vs global open-pr → branch-write",
    effectiveRung("open-pr", "branch-write") === "branch-write");
  check("effectiveRung: cap above global never advances (global branch-write, cap production → branch-write)",
    effectiveRung("branch-write", "production") === "branch-write");
  check("effectiveRung: equal is identity", effectiveRung("staging", "staging") === "staging");
  check("effectiveRung: unrecognized rung resolves to most restrictive, never undefined (cg-1783026015383)",
    effectiveRung("bogus" as Rung, "staging") === RUNGS[0] && effectiveRung("open-pr", "bogus" as Rung) === RUNGS[0]);

  // unknown line → conservative rules
  check("unknown line inherits migration (most conservative) rules",
    rulesForLine("unknown", DEFAULT_LINE_CONFIG).risk_posture === "conservative");

  // Fail-loud validation
  const expectThrow = (name: string, raw: unknown) => {
    try {
      validateLineConfig(raw, "test");
      check(`${name} (should throw)`, false);
    } catch {
      check(name, true);
    }
  };
  expectThrow("reject unknown line name", { ...DEFAULT_LINE_CONFIG, hotfix: DEFAULT_LINE_CONFIG.bugfix });
  expectThrow("reject bad rung name", {
    ...DEFAULT_LINE_CONFIG,
    docs: { ...DEFAULT_LINE_CONFIG.docs, max_rung: "root" },
  });
  expectThrow("reject bad gate name", {
    ...DEFAULT_LINE_CONFIG,
    docs: { ...DEFAULT_LINE_CONFIG.docs, mandatory_gates: ["vibes"] },
  });
  expectThrow("reject missing line", (() => { const { migration: _m, ...rest } = DEFAULT_LINE_CONFIG; return rest; })());
  expectThrow("reject unknown field inside a line rule (typo could silently loosen)", {
    ...DEFAULT_LINE_CONFIG,
    docs: { ...DEFAULT_LINE_CONFIG.docs, max_rungg: "read-only" },
  });
  expectThrow("reject duplicate mandatory gates", {
    ...DEFAULT_LINE_CONFIG,
    docs: { ...DEFAULT_LINE_CONFIG.docs, mandatory_gates: ["postflight", "postflight"] },
  });
  check("valid defaults pass validation", (() => {
    try { validateLineConfig(DEFAULT_LINE_CONFIG, "test"); return true; } catch { return false; }
  })());

  // Unreadable config carries the path in the error (fail-loud with location).
  // A directory path exists but cannot be read as JSON — no fixture write
  // needed (this module stays fs-write-free; lines-selftest locks the torn-file case).
  check("unreadable config error names the config path", (() => {
    try {
      loadLineConfig(import.meta.dir);
      return false;
    } catch (err) {
      return err instanceof Error && err.message.includes(import.meta.dir);
    }
  })());

  // Committed file must exist AND be byte-equivalent to defaults (hash equal).
  // Pre-enable drift guard: while SF011_LINES defaults OFF, the absent-file
  // fallback must be behavior-identical to the shipped JSON. An operator who
  // later customizes line-config.json updates this lock as part of that
  // (operator-only) change — divergence must always be deliberate.
  const loaded = loadLineConfig();
  check("shipped line-config.json loads from file", loaded.source === "file");
  check("shipped JSON ≡ built-in defaults (hash equal)", loaded.hash === loadLineConfig("/nonexistent-sf011").hash);
  check("absent file → defaults source", loadLineConfig("/nonexistent-sf011").source === "defaults");

  const total = 18;
  console.log(`\n${failed === 0 ? "PASS" : "FAIL"} — ${total - failed}/${total} checks`);
  return failed === 0 ? 0 : 1;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function main() {
  const cmd = Bun.argv[2];
  if (cmd === "self-test") process.exit(selfTest());
  if (cmd === "show") {
    const loaded = loadLineConfig();
    if (Bun.argv.includes("--json")) {
      console.log(JSON.stringify(loaded, null, 2));
    } else {
      console.log(`source=${loaded.source} hash=${loaded.hash}`);
      for (const line of LINES) {
        const r = loaded.config[line];
        console.log(
          `  ${line.padEnd(10)} posture=${r.risk_posture.padEnd(12)} max_rung=${r.max_rung.padEnd(12)} auto_merge=${r.auto_merge_eligible} gates=[${r.mandatory_gates.join(",")}]`,
        );
      }
    }
    process.exit(0);
  }
  console.error("Commands: show [--json] | self-test");
  process.exit(2);
}

if (import.meta.main) main();
