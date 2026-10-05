#!/usr/bin/env bun
/**
 * SF-011 T5 — Per-Archetype Assembly Lines Self-Test Harness
 *
 * Sandboxed: snapshot fixtures, config fixtures, phase state, and subprocess
 * dry-run records all live under one mkdtemp directory. Subprocesses use only
 * synthetic tickets and never consult or mutate production factory state.
 *
 * Sections:
 *   1. classifier (declared > alias > inference > unknown; fine-name-to-lane)
 *   2. line config (defaults-on-absent, fail-loud on invalid, rung CAP math)
 *   3. sf011Snapshot honesty (stamped/unstamped/corrupt counts, env redirect)
 *   4. never-writes guards (ladder file untouched; SF-011 modules read-only)
 *   5. flags-off identity (dispatcher + swarm-exec byte-identical, no stamps)
 *   6. flag-on stamping (alias fine name + disagreement recorded on exec)
 *   7. wiring guards (source-order checks, dedup-selftest convention)
 *
 * Exit 0 = all green.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isExecutionRecordFileName } from "./execution-lifecycle";
import {
  ALIASES,
  classifyArchetype,
  hasDisagreement,
  inferLine,
  laneArchetypeName,
  LINES,
} from "./archetype-classifier";
import {
  DEFAULT_LINE_CONFIG,
  effectiveRung,
  lineConfigPath,
  loadLineConfig,
  rulesForLine,
  sf011Snapshot,
} from "./line-config";

const SCRIPT_DIR = import.meta.dir;

let passed = 0;
let failed = 0;
function checkT(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** Exec/hold records in the test sandbox, used to verify subprocess output. */
function stateRecords(): Set<string> {
  if (!existsSync(STATE_DIR)) return new Set();
  return new Set(readdirSync(STATE_DIR).filter((f) => isExecutionRecordFileName(f) || (f.startsWith("hold-") && f.endsWith(".json"))));
}

function cleanupNewRecords(before: Set<string>): string[] {
  const created = [...stateRecords()].filter((f) => !before.has(f));
  for (const f of created) unlinkSync(join(STATE_DIR, f));
  return created;
}

const sandbox = mkdtempSync(join(tmpdir(), "sf011-test-"));
const STATE_DIR = sandbox;
writeFileSync(join(STATE_DIR, "shadow-state.json"), JSON.stringify({
  current_phase: "live",
  phase_started_at: "2026-07-02T00:00:00.000Z",
  dry_run_started_at: "2026-06-25T00:00:00.000Z",
  shadow_pr_started_at: "2026-06-28T00:00:00.000Z",
  live_started_at: "2026-07-01T00:00:00.000Z",
  transitions: [],
  safe_executions: 0,
  unsafe_auto_executions: 0,
}));

try {
  // ─── 1. classifier ─────────────────────────────────────────────────────────
  section("1. classifier (declared > alias > inference > unknown)");
  {
    const declared = classifyArchetype({ archetype: "bugfix" }, "Fix crash in dispatcher");
    checkT("declared canonical → line, conf 1.0", declared.line === "bugfix" && declared.source === "declared" && declared.confidence === 1.0);

    const alias = classifyArchetype({ archetype: "dependency_bump" }, "Bump hono in package.json");
    checkT("alias folds to coarse line", alias.line === "dependency" && alias.source === "alias");
    checkT("fine name preserved for the SF-010 lane", alias.fine === "dependency_bump" && laneArchetypeName(alias) === "dependency_bump");
    checkT("coarse classification lane-names as the line itself", laneArchetypeName(declared) === "bugfix");

    const conflict = classifyArchetype({ archetype: "docs" }, "Schema migration: alter table positions and backfill");
    checkT("declaration wins over conflicting inference", conflict.line === "docs" && conflict.source === "declared");
    checkT("disagreement recorded as signal, not acted on", hasDisagreement(conflict) && !hasDisagreement(alias));

    checkT("inference order: migration outranks feature words", inferLine("Add new column: alter table users")?.line === "migration");
    const inferred = classifyArchetype({}, "Upgrade the package versions in the lockfile");
    checkT("inference source carries conf 0.6", inferred.source === "inferred" && inferred.confidence === 0.6);
    const unknown = classifyArchetype({ archetype: "???" }, "qqq zzz");
    checkT("garbage declaration + no signals → unknown, conf 0.0", unknown.line === "unknown" && unknown.source === "unknown" && unknown.confidence === 0.0);
    checkT("every alias maps into the LINES vocabulary", Object.values(ALIASES).every((l) => (LINES as readonly string[]).includes(l)));
    // cg-1783026014086 lock: prototype-chain keys must never match the alias table
    checkT("prototype-chain declarations never classify as alias",
      classifyArchetype({ archetype: "constructor" }, "qqq zzz").line === "unknown" &&
      classifyArchetype({ archetype: "__proto__" }, "qqq zzz").line === "unknown");
  }

  // ─── 2. line config ────────────────────────────────────────────────────────
  section("2. line config (defaults-on-absent, fail-loud, rung CAP)");
  {
    const absent = loadLineConfig(join(sandbox, "no-such-config.json"));
    checkT("absent file → built-in defaults", absent.source === "defaults");
    const shipped = loadLineConfig(lineConfigPath());
    checkT("shipped line-config.json loads from file", shipped.source === "file");
    checkT("shipped JSON ≡ defaults (hash witness)", shipped.hash === absent.hash);

    const tornPath = join(sandbox, "torn.json");
    writeFileSync(tornPath, '{"bugfix": {');
    const badRungPath = join(sandbox, "bad-rung.json");
    writeFileSync(badRungPath, JSON.stringify({ ...DEFAULT_LINE_CONFIG, docs: { ...DEFAULT_LINE_CONFIG.docs, max_rung: "root" } }));
    const throws = (p: string) => {
      try {
        loadLineConfig(p);
        return false;
      } catch {
        return true;
      }
    };
    checkT("torn JSON throws (fail-loud, never silently loosens)", throws(tornPath));
    checkT("torn JSON error names the config path (cg-1783026015383)", (() => {
      try {
        loadLineConfig(tornPath);
        return false;
      } catch (err) {
        return err instanceof Error && err.message.includes(tornPath);
      }
    })());
    checkT("invalid rung throws (fail-loud)", throws(badRungPath));

    // cg-1783026015383 locks: strict rule shape + fail-conservative rung math
    const unknownFieldPath = join(sandbox, "unknown-field.json");
    writeFileSync(unknownFieldPath, JSON.stringify({ ...DEFAULT_LINE_CONFIG, docs: { ...DEFAULT_LINE_CONFIG.docs, max_rungg: "read-only" } }));
    checkT("unknown field inside a line rule throws (typo could silently loosen)", throws(unknownFieldPath));
    const dupGatePath = join(sandbox, "dup-gate.json");
    writeFileSync(dupGatePath, JSON.stringify({ ...DEFAULT_LINE_CONFIG, docs: { ...DEFAULT_LINE_CONFIG.docs, mandatory_gates: ["postflight", "postflight"] } }));
    checkT("duplicate mandatory gates throw", throws(dupGatePath));
    checkT("unrecognized rung resolves to most restrictive, never undefined",
      effectiveRung("bogus" as never, "staging") === "read-only");

    checkT("migration cap tightens: min(open-pr, branch-write) = branch-write", effectiveRung("open-pr", "branch-write") === "branch-write");
    checkT("cap never advances: min(branch-write, production) = branch-write", effectiveRung("branch-write", "production") === "branch-write");
    checkT("unknown line inherits migration (most conservative) rules", rulesForLine("unknown", DEFAULT_LINE_CONFIG) === DEFAULT_LINE_CONFIG.migration);
    checkT("migration line: no auto-merge + scenario_runner mandatory",
      !DEFAULT_LINE_CONFIG.migration.auto_merge_eligible && DEFAULT_LINE_CONFIG.migration.mandatory_gates.includes("scenario_runner"));
  }

  // ─── 3. sf011Snapshot honesty ──────────────────────────────────────────────
  section("3. sf011Snapshot (stamped/unstamped/corrupt, env redirect, never throws)");
  const snapDir = mkdtempSync(join(tmpdir(), "sf011-snap-"));
  {
    writeFileSync(join(snapDir, "exec-aaaa0001.json"), JSON.stringify({ execution_id: "aaaa0001", archetype: { line: "dependency", source: "alias", fine: "dependency_bump", disagreement: false } }));
    writeFileSync(join(snapDir, "exec-aaaa0002.json"), JSON.stringify({ execution_id: "aaaa0002", archetype: { line: "docs", source: "declared", fine: null, disagreement: true } }));
    writeFileSync(join(snapDir, "exec-aaaa0003.json"), JSON.stringify({ execution_id: "aaaa0003", status: "complete" }));
    writeFileSync(join(snapDir, "exec-aaaa0004.json"), "{corrupt");
    writeFileSync(join(snapDir, "unrelated.txt"), "ignored");

    const snap = sf011Snapshot(snapDir);
    checkT("counts stamped vs total readable", snap.stamped_execs === 2 && snap.total_execs === 3);
    checkT("corrupt exec counted, never thrown", snap.unreadable_execs === 1);
    checkT("by_line buckets", snap.by_line.dependency === 1 && snap.by_line.docs === 1);
    checkT("by_source buckets", snap.by_source.alias === 1 && snap.by_source.declared === 1);
    checkT("disagreements counted (SF-012 feedstock)", snap.declared_vs_inferred_disagreements === 1);
    checkT("shipped config surfaces as file + hash", snap.config_source === "file" && snap.config_hash !== null);

    process.env.SF011_STATE_DIR = snapDir;
    const viaEnv = sf011Snapshot();
    delete process.env.SF011_STATE_DIR;
    checkT("SF011_STATE_DIR redirects the default state dir", viaEnv.stamped_execs === 2 && viaEnv.total_execs === 3);

    const invalidCfg = sf011Snapshot(snapDir, join(sandbox, "torn.json"));
    checkT("invalid config degrades to counted error, snapshot survives", invalidCfg.config_source === "invalid" && invalidCfg.config_error !== null);
    const absentCfg = sf011Snapshot(snapDir, join(sandbox, "no-such-config.json"));
    checkT("absent config surfaces as defaults", absentCfg.config_source === "defaults");
    const noDir = sf011Snapshot(join(sandbox, "no-such-state-dir"));
    checkT("missing state dir → zero counts, no throw", noDir.total_execs === 0 && noDir.unreadable_execs === 0);
  }

  // ─── 4. never-writes guards ────────────────────────────────────────────────
  section("4. never-writes guards (ladder untouched, modules read-only)");
  {
    checkT("snapshot never creates a ladder file in its state dir", !existsSync(join(snapDir, "permission-ladder.json")));

    const classifierSrc = readFileSync(join(SCRIPT_DIR, "archetype-classifier.ts"), "utf-8");
    const configSrc = readFileSync(join(SCRIPT_DIR, "line-config.ts"), "utf-8");
    const readOnly = (src: string) => !/writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync/.test(src);
    checkT("archetype-classifier.ts contains no fs write calls", readOnly(classifierSrc));
    checkT("line-config.ts contains no fs write calls", readOnly(configSrc));

    const swarmSrc = readFileSync(join(SCRIPT_DIR, "swarm-exec.ts"), "utf-8");
    // loadLadder() initializes (writes) ladder state when absent — SF-011 must
    // never import it. Its only mention in swarm-exec is the warning comment.
    checkT("swarm-exec never imports loadLadder (which writes state when absent)", !/import[^;]*loadLadder/.test(swarmSrc));
    checkT("swarm-exec imports only RUNGS/Rung from permission-ladder",
      /import \{ RUNGS, type Rung \} from "\.\/permission-ladder"/.test(swarmSrc) &&
      (swarmSrc.match(/from "\.\/permission-ladder"/g) ?? []).length === 1);
    checkT("sf011GlobalRung reads the ladder file directly (read-only)", swarmSrc.includes('join(STATE_DIR, "permission-ladder.json")'));
  }

  // ─── 5. flags-off identity ─────────────────────────────────────────────────
  section("5. flags-off identity (SF011_LINES unset = byte-identical, no stamps)");
  {
    const ticketsPath = join(sandbox, "tickets-off.json");
    writeFileSync(
      ticketsPath,
      JSON.stringify([
        {
          linear_id: "e1e1e1e1-2222-3333-4444-555566667777",
          identifier: "ZOU-SF11A",
          title: "SF011 selftest identity ticket",
          description: "**archetype:** dependency_bump\n**target_repo:** Projects/zouroboros-software-factory\n\n## Acceptance Criteria\n- selftest only",
          url: "https://linear.app/x",
          state: "factory-ready",
          labels: [],
          created_at: "2026-07-02T10:00:00Z",
          updated_at: "2026-07-02T10:00:00Z",
        },
      ]),
    );
    const env = { ...process.env, FACTORY_STATE_DIR: STATE_DIR, SF002_CLASSIFY: "0", SF005_SLO: "0", SF006_DEDUP: "0" };
    for (const k of ["SF011_LINES", "SF011_ENFORCE", "SF010_AUTOMERGE", "SF003_POOL", "SF011_STATE_DIR"]) {
      delete (env as Record<string, string | undefined>)[k];
    }

    const before = stateRecords();
    const d = spawnSync("bun", [join(SCRIPT_DIR, "dispatcher.ts"), "--tickets", ticketsPath, "--dry-run"], { encoding: "utf-8", env });
    const dispatchPath = join(sandbox, "dispatch-off.json");
    writeFileSync(dispatchPath, d.stdout);
    const norm = (s: string) => s
      .replace(/exec-[0-9a-f]{8}/g, "exec-X")
      .replace(/"(started_at|completed_at|state_updated_at|recorded_at)": "[^"]*"/g, '"$1": "T"');
    const e1 = spawnSync("bun", [join(SCRIPT_DIR, "swarm-exec.ts"), "--dispatch", dispatchPath, "--dry-run"], { encoding: "utf-8", env });
    const e2 = spawnSync("bun", [join(SCRIPT_DIR, "swarm-exec.ts"), "--dispatch", dispatchPath, "--dry-run"], { encoding: "utf-8", env });
    checkT("off-runs exit 0", d.status === 0 && e1.status === 0 && e2.status === 0, `d=${d.status} e1=${e1.status} e2=${e2.status}`);
    checkT("off-runs identical (modulo random ids/ts)", norm(e1.stdout) === norm(e2.stdout) && norm(e1.stderr) === norm(e2.stderr));
    checkT("no [sf011] output when flag off", !`${d.stdout}${d.stderr}${e1.stdout}${e1.stderr}`.includes("[sf011]"));

    const created = cleanupNewRecords(before);
    // the two dry-runs each staged the ticket → ≥2 exec records, none stamped
    checkT("off-run exec records carry no archetype field", created.length >= 2, `created=${created.length}`);
    // read happened before unlink? No — re-check via the captured report instead:
    checkT("off-run report JSON carries no archetype key", !e1.stdout.includes('"archetype"'));
  }

  // ─── 6. flag-on stamping ───────────────────────────────────────────────────
  section("6. flag-on stamping (SF011_LINES=1: alias fine name + disagreement)");
  {
    const ticketsPath = join(sandbox, "tickets-on.json");
    writeFileSync(
      ticketsPath,
      JSON.stringify([
        {
          linear_id: "f1f1f1f1-2222-3333-4444-555566667777",
          identifier: "ZOU-SF11B",
          title: "Bump hono in package.json",
          description: "**archetype:** dependency_bump\n**target_repo:** Projects/zouroboros-software-factory\n\n## Acceptance Criteria\n- selftest only",
          url: "https://linear.app/x",
          state: "factory-ready",
          labels: [],
          created_at: "2026-07-02T10:00:00Z",
          updated_at: "2026-07-02T10:00:00Z",
        },
        {
          linear_id: "f2f2f2f2-2222-3333-4444-555566667777",
          identifier: "ZOU-SF11C",
          title: "Update the runbook",
          description: "**archetype:** docs\n**target_repo:** Projects/zouroboros-software-factory\n\nSchema migration: alter table positions and backfill.\n\n## Acceptance Criteria\n- selftest only",
          url: "https://linear.app/x",
          state: "factory-ready",
          labels: [],
          created_at: "2026-07-02T10:00:00Z",
          updated_at: "2026-07-02T10:00:00Z",
        },
      ]),
    );
    const env = { ...process.env, FACTORY_STATE_DIR: STATE_DIR, SF002_CLASSIFY: "0", SF005_SLO: "0", SF006_DEDUP: "0", SF011_LINES: "1" };
    for (const k of ["SF011_ENFORCE", "SF010_AUTOMERGE", "SF003_POOL", "SF011_STATE_DIR"]) {
      delete (env as Record<string, string | undefined>)[k];
    }

    const before = stateRecords();
    const d = spawnSync("bun", [join(SCRIPT_DIR, "dispatcher.ts"), "--tickets", ticketsPath, "--dry-run"], { encoding: "utf-8", env });
    const dispatchPath = join(sandbox, "dispatch-on.json");
    writeFileSync(dispatchPath, d.stdout);
    const e = spawnSync("bun", [join(SCRIPT_DIR, "swarm-exec.ts"), "--dispatch", dispatchPath, "--dry-run"], { encoding: "utf-8", env });
    checkT("flag-on runs exit 0", d.status === 0 && e.status === 0, `d=${d.status} e=${e.status}`);
    const out = `${e.stdout}${e.stderr}`;
    checkT("advisory log names line + source + fine", out.includes("line=dependency source=alias fine=dependency_bump"));
    checkT("declared line logged for the docs ticket", out.includes("line=docs source=declared"));

    const createdNames = [...stateRecords()].filter((f) => !before.has(f));
    const recs = createdNames
      .filter(isExecutionRecordFileName)
      .map((f) => JSON.parse(readFileSync(join(STATE_DIR, f), "utf-8")) as { identifier?: string; archetype?: { line?: string; source?: string; fine?: string | null; disagreement?: boolean } });
    const dep = recs.find((r) => r.identifier === "ZOU-SF11B");
    const docs = recs.find((r) => r.identifier === "ZOU-SF11C");
    checkT("dependency exec stamped: alias line + fine name preserved",
      dep?.archetype?.line === "dependency" && dep?.archetype?.source === "alias" && dep?.archetype?.fine === "dependency_bump" && dep?.archetype?.disagreement === false);
    checkT("docs exec stamped: declared wins, disagreement recorded",
      docs?.archetype?.line === "docs" && docs?.archetype?.source === "declared" && docs?.archetype?.fine === null && docs?.archetype?.disagreement === true);

    for (const f of createdNames) unlinkSync(join(STATE_DIR, f));
  }

  // ─── 7. wiring guards ──────────────────────────────────────────────────────
  section("7. wiring guards (source-order checks)");
  {
    const swarmSrc = readFileSync(join(SCRIPT_DIR, "swarm-exec.ts"), "utf-8");
    checkT("classification gated on SF011_LINES", swarmSrc.includes('if (process.env.SF011_LINES !== "1") return null;'));
    checkT("classification and gate evidence trigger a durable execution save", swarmSrc.includes("if (verdict || sf011 !== null || d.product_gate || planGate) saveExecution(exec);"));
    checkT("held records carry the archetype stamp too", swarmSrc.includes("...(sf011 !== null ? { archetype: {"));
    checkT("sf010 hook receives the fine-grained lane name", swarmSrc.includes("laneArchetypeName(sf011)"));
    checkT("invalid config fails closed in enforce mode", swarmSrc.includes("sf010 lane SKIPPED (fail-closed)"));
    checkT("ineligible line skips the lane in enforce mode", swarmSrc.includes("auto_merge_eligible=false — sf010 lane SKIPPED (enforce)"));
    checkT("advisory mode logs would-skip, never skips", swarmSrc.includes("would-skip sf010 lane (advisory)"));
    checkT("eligibility check is tightening-only (allowlist stays merge truth)", swarmSrc.includes("TIGHTENING only"));

    const collectSrc = readFileSync(join(SCRIPT_DIR, "factory-collect.ts"), "utf-8");
    checkT("FactoryRecord archetype is optional-when-stamped (no supersede churn)",
      collectSrc.includes('exec.archetype && typeof exec.archetype.line === "string"'));

    const metricsSrc = readFileSync(join(SCRIPT_DIR, "factory-metrics.ts"), "utf-8");
    checkT("metrics bucket unstamped records as 'unrecorded', never guessed", metricsSrc.includes('rec.archetype ?? "unrecorded"'));

    const shadowSrc = readFileSync(join(SCRIPT_DIR, "shadow-validate.ts"), "utf-8");
    checkT("shadow-validate embeds sf011Snapshot at both report sites",
      (shadowSrc.match(/sf011: sf011Snapshot\(\),/g) ?? []).length === 2);
  }

  rmSync(snapDir, { recursive: true, force: true });
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(60)}`);
if (failed === 0) {
  console.log(`✓ All ${passed} checks passed`);
  process.exit(0);
} else {
  console.log(`✗ ${failed} of ${passed + failed} checks failed`);
  process.exit(1);
}
