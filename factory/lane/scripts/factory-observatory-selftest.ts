#!/usr/bin/env bun
/**
 * FR-09 (ZOU-1118) — Factory Observatory selftest.
 *
 * Sandboxed via SF003_POOL_STATE_DIR / FACTORY_APPROVAL_LEDGER_PATH /
 * FACTORY_AUTOMERGE_AUDIT_DIR plus explicit cost/worktrees paths; the real
 * state/ directory is never written. Verifies the honesty invariants:
 * null-not-zero denominators, unmeasured never counted as success, mechanical
 * mode derivation, alert thresholds for stale reconciliation and
 * evidence/config drift, and missing sources reported as unavailable.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import {
  COST_STALE_DAYS,
  DEFAULT_STALE_HOURS,
  collectFlagsHome,
  createObservatorySnapshot,
  deriveAlerts,
  deriveSurfaces,
  rate,
  readLastConveyorTick,
  renderObservatory,
  type FlagsHome,
  type ObservatorySnapshot,
  type SurfaceMode,
} from "./factory-observatory";
import type { RuntimeConfigFile } from "./runtime-config";
import { FLAG_SCHEMA, loadRuntimeConfig } from "./runtime-config";
import type { QualificationStatus } from "./l4-qualification";
import type { SF003Snapshot } from "./pool-manager";

let passed = 0;
let failed = 0;
const root = `/tmp/factory-observatory-selftest-${process.pid}`;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function fixtureConfig(overrides: Record<string, string> = {}): RuntimeConfigFile {
  const flags: Record<string, string> = {};
  for (const [key, spec] of Object.entries(FLAG_SCHEMA)) {
    if (spec.kind === "bool01") flags[key] = "0";
    else if (spec.kind === "enum") flags[key] = spec.values[0];
    else if (spec.kind === "int") flags[key] = String(spec.min ?? 0);
    else flags[key] = "/dev/null";
  }
  Object.assign(flags, overrides);
  return { version: 1, updated_at: "2026-08-07T00:00:00Z", updated_by: "selftest", flags };
}

function fixtureLine(overrides: Partial<SF003Snapshot> = {}): SF003Snapshot {
  // Assertion, not annotation: the fixture must stay assignable across minor
  // SF003Snapshot revisions (e.g. max_dispatch_per_reconcile exists locally
  // but not yet in every deployed checkout).
  return {
    pool_enabled: true,
    mode: "act",
    queue_depth_ready: 0,
    in_flight: 0,
    external_in_flight: 0,
    capacity_used: 0,
    global_cap: 20,
    max_dispatch_per_reconcile: 1,
    parked: [],
    retried_items: 0,
    failover_dispatches: 0,
    campaigns: [],
    reconcile_events: 1,
    last_reconcile: new Date().toISOString(),
    fleet_separation_ok: true,
    fleet_separation_reason: "fixture",
    supervisor: { workers: [], active_leases: [], expired_leases: 0, checkpoints: 0, dead_letters: [] },
    oldest_ready_wait_min: null,
    upstream_blocked: [],
    ...overrides,
  } as SF003Snapshot;
}

function fixtureQualification(overrides: Partial<QualificationStatus> = {}): QualificationStatus {
  return {
    state_dir: "/tmp/fixture",
    scanned_dirs: ["/tmp/fixture"],
    duplicate_records_merged: 0,
    generated_at: new Date().toISOString(),
    live_started_at: null,
    records_total: 20,
    records_unreadable: 0,
    qualifying_count: 20,
    evidence_complete_count: 19,
    evidence_complete_rate: 0.95,
    window_days: 10,
    distinct_utc_days: 10,
    stamp_mismatches: 0,
    unsafe_auto_executions: 0,
    false_approvals: 0,
    interventions_held: 0,
    min_required: { executions: 20, window_days: 7, evidence_rate: 0.9 },
    certified: true,
    blockers: [],
    executions: [],
    ...overrides,
  };
}

function fixtureFlagsHome(overrides: Partial<FlagsHome> = {}): FlagsHome {
  return {
    path: "/etc/zouroboros/factory/runtime-flags.json",
    overridden: true,
    override_env: "FACTORY_RUNTIME_FLAGS_PATH",
    version: 12,
    sha256: "a".repeat(64),
    config_hash: "1111111111111111",
    ticks_path: "/var/lib/zouroboros/runtime/factory-state/v1/config-ticks.jsonl",
    last_tick: { at: "2026-10-07T10:41:04.510Z", source: "lane-utilization begin", version: 15, hash: "8e2e33845ef0bc0b", persona_mode: "shadow" },
    ...overrides,
  };
}

function fixtureSnapshot(input: {
  line?: SF003Snapshot;
  qualification?: QualificationStatus;
  costAgeDays?: number | null;
  costAvailable?: boolean;
}): Omit<ObservatorySnapshot, "alerts"> {
  const config = fixtureConfig();
  const surfaces = deriveSurfaces(config);
  const actionsByMode: Record<SurfaceMode, string[]> = { advisory: [], shadow: [], canary: [], live: [], off: [], measurement: [] };
  for (const s of surfaces) actionsByMode[s.mode].push(s.id);
  const costAvailable = input.costAvailable ?? true;
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    sources: { project_dir: "/tmp", pool_state_dir: "/tmp", config_path: null, cost_path: "/tmp/cost.json", worktrees_root: "/tmp", read_errors: [] },
    modes: { shadow_phase: "live", flags_home: fixtureFlagsHome(), surfaces, actions_by_mode: actionsByMode },
    line: input.line ?? fixtureLine(),
    worktrees: { root: "/tmp", count: 0, entries: [] },
    gates: {
      approval_ledger: { available: true, entries: 0, operator_approved: 0, operator_rejected: 0, operator_pending: 0, operator_excluded: 0, agreement: rate(0, 0), agreement_unmeasured: 0 },
      auto_merge_audit: { available: true, records: 0, by_method: {}, live_merges: 0, last_at: null },
      qualification: input.qualification ?? fixtureQualification(),
    },
    outcomes: {
      metrics: { available: false, error: "fixture" },
      first_pass_quality: {
        ledger_available: false,
        ledger_rows: 0,
        ledger_errors: [],
        candidate_count: 0,
        contract_complete_count: 0,
        contract_completeness: null,
        by_stratum: {},
        metrics: null,
      },
      evidence: {
        ledger_available: true,
        ledger_rows: 0,
        ledger_errors: 0,
        terminal_count: 0,
        eligible_terminal_count: 0,
        measured_count: 0,
        excluded_count: 0,
        held_unmeasured_count: 0,
        evidence_coverage: null,
        coverage_floor: 0.95,
        minimum_eligible_sample: 30,
        promotion_ready: false,
        successful_eligible_count: 0,
        successful_measured_count: 0,
        successful_evidence_coverage: null,
        by_terminal_state: { accepted: 0, failed: 0, held: 0, dry_run: 0 },
        exclusions: { invalid: 0, duplicate: 0, canceled: 0, superseded: 0, operator_aborted: 0, pre_instrumentation: 0 },
        evidence_failures: { missing: 0, stale: 0, malformed: 0, duplicate: 0, forged: 0, mismatched: 0 },
      },
      survivability: { available: true, global: null, escaped_defects: 0, reverted: 0, hotfixed: 0, torn_lines: 0, note: "fixture" },
      cost: {
        available: costAvailable,
        path: "/tmp/cost.json",
        generated_at: costAvailable ? new Date().toISOString() : null,
        age_days: input.costAgeDays ?? (costAvailable ? 0 : null),
        cost_per_accepted_outcome_usd: costAvailable ? 0.05 : null,
        accepted_runs: costAvailable ? 10 : 0,
        joined_runs: costAvailable ? 20 : 0,
        unjoined_cost_runs: 0,
        unjoined_verdicts: 0,
        by_outcome: {},
        note: "fixture",
      },
    },
  };
}

function alertIds(snapshot: Omit<ObservatorySnapshot, "alerts">, config: RuntimeConfigFile | null, staleHours = DEFAULT_STALE_HOURS): string[] {
  return deriveAlerts(snapshot, config, config === null ? ["fixture invalid"] : [], staleHours, new Date()).map((a) => `${a.severity}:${a.id}`);
}

function run(): void {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });

  console.log("Rates never fabricate a value");
  const empty = rate(0, 0);
  check("empty denominator yields null rate, not 0 or 1", empty.rate === null && empty.denominator === 0);
  const three4 = rate(3, 4);
  check("rate carries explicit numerator and denominator", three4.rate === 0.75 && three4.numerator === 3 && three4.denominator === 4);

  console.log("Mode derivation is mechanical");
  const offSurfaces = deriveSurfaces(null);
  check("missing config derives no live surface", offSurfaces.every((s) => s.mode !== "live" && s.mode !== "canary"));
  const liveSurfaces = deriveSurfaces(fixtureConfig({ SF003_POOL: "1", SF003_POOL_MODE: "act", SF009_SCENARIOS: "1" }));
  check("pool act flag derives live assembly line", liveSurfaces.find((s) => s.id === "assembly_line")?.mode === "live");
  check("auto-merge off derives advisory, not off", liveSurfaces.find((s) => s.id === "auto_merge")?.mode === "advisory");
  const canary = deriveSurfaces(fixtureConfig({ SF010_AUTOMERGE: "1" }));
  check("auto-merge on derives canary, never silent live", canary.find((s) => s.id === "auto_merge")?.mode === "canary");
  const shadowPool = deriveSurfaces(fixtureConfig({ SF003_POOL: "1", SF003_POOL_MODE: "shadow" }));
  check("pool shadow flag derives shadow assembly line", shadowPool.find((s) => s.id === "assembly_line")?.mode === "shadow");
  const diversityShadow = deriveSurfaces(fixtureConfig({ FACTORY_PERSONA_ROUTING_MODE: "shadow", FACTORY_MODEL_REVIEW: "off" }));
  check("persona review shadow is visible while legacy model consensus stays off",
    diversityShadow.find((s) => s.id === "diversity_review")?.mode === "shadow"
      && diversityShadow.find((s) => s.id === "consensus_review")?.mode === "off");

  console.log("Persona surface uses the runner's canary bound (V2 board honesty)");
  const panelDir = join(root, "panel");
  mkdirSync(panelDir, { recursive: true });
  const panelPath = join(panelDir, "lineup.consensus.panel.json");
  const enforceConfig = fixtureConfig({ FACTORY_PERSONA_ROUTING_MODE: "enforce" });
  const unpromoted = deriveSurfaces(enforceConfig, { panelPath, env: { HOME: panelDir } }).find((s) => s.id === "diversity_review");
  check("enforce + missing panel promotion renders canary (low-risk only), never live",
    unpromoted?.mode === "canary" && unpromoted.detail === "canary (low-risk only)", JSON.stringify(unpromoted));
  writeFileSync(panelPath, JSON.stringify({ schemaVersion: 2, profile: "consensus-persona-panel", status: "shadow" }));
  const shadowPanel = deriveSurfaces(enforceConfig, { panelPath }).find((s) => s.id === "diversity_review");
  check("enforce + shadow panel still renders canary", shadowPanel?.mode === "canary", JSON.stringify(shadowPanel));
  writeFileSync(panelPath, JSON.stringify({ schemaVersion: 2, profile: "consensus-persona-panel", status: "promoted" }));
  const promoted = deriveSurfaces(enforceConfig, { panelPath }).find((s) => s.id === "diversity_review");
  check("enforce + promoted panel renders live for all risk tiers", promoted?.mode === "live" && (promoted.detail ?? "").includes("panel promoted"), JSON.stringify(promoted));
  const withTick = deriveSurfaces(enforceConfig, { panelPath: join(panelDir, "absent.json"), lastTick: fixtureFlagsHome().last_tick }).find((s) => s.id === "diversity_review");
  check("persona surface carries the last conveyor tick beside the mode",
    withTick?.detail === "canary (low-risk only) · last conveyor tick: 2026-10-07T10:41:04.510Z (flag at tick: shadow)", withTick?.detail);
  const neverTicked = deriveSurfaces(enforceConfig, { panelPath: join(panelDir, "absent.json"), lastTick: null }).find((s) => s.id === "diversity_review");
  check("a never-ticked conveyor says so", (neverTicked?.detail ?? "").includes("last conveyor tick: never"));

  console.log("Flags home and last tick are read from disk, not assumed");
  const ticksPath = join(root, "config-ticks.jsonl");
  writeFileSync(ticksPath, `${JSON.stringify({ at: "2026-10-06T00:00:00.000Z", source: "old", valid: true, version: 14, hash: "0".repeat(16), effective: {} })}\n${JSON.stringify({ at: "2026-10-07T10:41:04.510Z", source: "lane-utilization begin", valid: true, version: 15, hash: "8e2e33845ef0bc0b", effective: { FACTORY_PERSONA_ROUTING_MODE: "shadow" } })}\n`);
  const tick = readLastConveyorTick(ticksPath, []);
  check("last tick is the final config-ticks.jsonl line", tick?.at === "2026-10-07T10:41:04.510Z" && tick.version === 15 && tick.hash === "8e2e33845ef0bc0b" && tick.persona_mode === "shadow", JSON.stringify(tick));
  check("absent ticks file yields null (never fabricated)", readLastConveyorTick(join(root, "absent.jsonl"), []) === null);
  const flagsPath = join(root, "runtime-flags.json");
  const seed = readFileSync(join(import.meta.dir, "..", "config", "runtime-flags.json"), "utf8");
  writeFileSync(flagsPath, seed);
  const home = collectFlagsHome(loadRuntimeConfig(flagsPath), [], { configPath: flagsPath, overridden: true, ticksPath });
  check("flags home reports the path, version and file sha256 it read",
    home.path === flagsPath && home.overridden && home.version === (JSON.parse(seed) as { version: number }).version
      && home.sha256 === createHash("sha256").update(seed).digest("hex") && home.last_tick?.version === 15, JSON.stringify(home));
  const renderedHome = renderObservatory({ ...fixtureSnapshot({}), alerts: [] });
  check("board renders the authoritative flags path, version and sha",
    renderedHome.includes(`flags: /etc/zouroboros/factory/runtime-flags.json (authoritative, FACTORY_RUNTIME_FLAGS_PATH) v12 sha256=${"a".repeat(64)}`));
  check("board renders the last conveyor tick and flags drift against it",
    renderedHome.includes("last conveyor tick: 2026-10-07T10:41:04.510Z v15 hash=8e2e33845ef0bc0b (differs from current flags)"));
  const canarySnapshot = fixtureSnapshot({});
  canarySnapshot.modes.surfaces = deriveSurfaces(enforceConfig, { panelPath: join(panelDir, "absent.json") });
  check("board renders the persona canary label", renderObservatory({ ...canarySnapshot, alerts: [] }).includes("[CANARY     ] Persona Diversity of Thought review — canary (low-risk only)"));
  const savedFirstPassMode = process.env.FIRST_PASS_VALIDATION_MODE;
  process.env.FIRST_PASS_VALIDATION_MODE = "shadow";
  const firstPassShadow = deriveSurfaces(fixtureConfig());
  if (savedFirstPassMode === undefined) delete process.env.FIRST_PASS_VALIDATION_MODE;
  else process.env.FIRST_PASS_VALIDATION_MODE = savedFirstPassMode;
  check("first-pass validation defaults off and exposes explicit shadow activation",
    offSurfaces.find((s) => s.id === "first_pass_validation")?.mode === "off"
      && firstPassShadow.find((s) => s.id === "first_pass_validation")?.mode === "shadow");

  console.log("Stale-reconciliation alerts");
  const fresh = alertIds(fixtureSnapshot({}), fixtureConfig());
  check("fresh reconcile raises no stale alert", !fresh.some((id) => id.includes("stale_reconciliation")), fresh.join(","));
  const stale = alertIds(fixtureSnapshot({ line: fixtureLine({ last_reconcile: new Date(Date.now() - 48 * 3_600_000).toISOString() }) }), fixtureConfig());
  check("48h-old reconcile raises critical alert at 24h threshold", stale.includes("critical:stale_reconciliation"));
  const never = alertIds(fixtureSnapshot({ line: fixtureLine({ last_reconcile: null }) }), fixtureConfig());
  check("absent reconcile evidence alerts explicitly (absence is not success)", never.includes("critical:stale_reconciliation"));

  console.log("Evidence and config drift alerts");
  const lowEvidence = alertIds(fixtureSnapshot({ qualification: fixtureQualification({ evidence_complete_rate: 0.85, certified: false }) }), fixtureConfig());
  check("evidence completeness below 90% raises evidence_drift", lowEvidence.includes("critical:evidence_drift"));
  const okEvidence = alertIds(fixtureSnapshot({}), fixtureConfig());
  check("evidence at 95% raises no evidence_drift", !okEvidence.some((id) => id.includes("evidence_drift")));
  check("unreadable config raises config_drift", alertIds(fixtureSnapshot({}), null).includes("critical:config_drift"));
  const saved = process.env.SF004_METRICS;
  process.env.SF004_METRICS = "1";
  const diverged = alertIds(fixtureSnapshot({}), fixtureConfig());
  if (saved === undefined) delete process.env.SF004_METRICS;
  else process.env.SF004_METRICS = saved;
  check("config/env divergence raises config_drift", diverged.includes("critical:config_drift"));

  console.log("Dead letters and cost honesty");
  const dead = alertIds(
    fixtureSnapshot({
      line: fixtureLine({
        supervisor: {
          workers: [],
          active_leases: [],
          expired_leases: 0,
          checkpoints: 0,
          dead_letters: [{ dead_letter_id: "d1", assignment_id: "a1", campaign_id: "c", task_id: "t", worker_id: "w", lease_id: "l", reason: "expired", recorded_at: new Date().toISOString() } as never],
        },
      }),
    }),
    fixtureConfig(),
  );
  check("dead letters raise a warning alert", dead.includes("warning:dead_letters"));
  const staleCost = alertIds(fixtureSnapshot({ costAgeDays: COST_STALE_DAYS + 3 }), fixtureConfig());
  check("stale cost store raises warning, data kept historical", staleCost.includes("warning:cost_stale"));
  const noCost = alertIds(fixtureSnapshot({ costAvailable: false }), fixtureConfig());
  check("missing cost store reports unmeasured, never $0", noCost.includes("warning:cost_unmeasured"));

  console.log("Sandboxed end-to-end snapshot");
  const poolDir = join(root, "pool");
  mkdirSync(poolDir, { recursive: true });
  process.env.SF003_POOL_STATE_DIR = poolDir;
  process.env.FACTORY_APPROVAL_LEDGER_PATH = join(root, "approval-ledger.jsonl");
  process.env.FACTORY_AUTOMERGE_AUDIT_DIR = join(root, "auto-merge-audit");
  writeFileSync(join(root, "cost-missing-marker"), "");
  const snapshot = createObservatorySnapshot({
    costFile: join(root, "cost-per-outcome.json"),
    worktreesRoot: join(root, "worktrees"),
  });
  delete process.env.SF003_POOL_STATE_DIR;
  delete process.env.FACTORY_APPROVAL_LEDGER_PATH;
  delete process.env.FACTORY_AUTOMERGE_AUDIT_DIR;

  check("sandboxed snapshot completes with schema_version 1", snapshot.schema_version === 1);
  const line = snapshot.line as SF003Snapshot;
  check("empty pool yields empty line, not fabricated activity", !("available" in snapshot.line) && line.campaigns.length === 0 && line.queue_depth_ready === 0);
  check("empty ledger agreement is unmeasured null", snapshot.gates.approval_ledger.agreement.rate === null);
  check("missing cost store yields null cost with note", !snapshot.outcomes.cost.available && snapshot.outcomes.cost.cost_per_accepted_outcome_usd === null);
  check("missing audit dir reported unavailable, not zero-success", snapshot.gates.auto_merge_audit.available === false);
  check("every surface carries a mode tag", snapshot.modes.surfaces.every((s) => ["advisory", "shadow", "canary", "live", "off", "measurement"].includes(s.mode)));
  check("export groups actions by mode", Object.values(snapshot.modes.actions_by_mode).flat().length === snapshot.modes.surfaces.length);
  check("JSON export round-trips", JSON.parse(JSON.stringify(snapshot)).schema_version === 1);
  const rendered = renderObservatory(snapshot);
  check("render carries mode tags and no NaN", rendered.includes("MODES") && rendered.includes("ALERTS") && !rendered.includes("NaN"));
  check("render never prints a fabricated 100% for empty denominators", !rendered.includes("100.0% (0/0)"));
  const excludedFixture = fixtureSnapshot({});
  excludedFixture.gates.approval_ledger.operator_excluded = 1;
  excludedFixture.gates.approval_ledger.entries = 1;
  const excludedRendered = renderObservatory({ ...excludedFixture, alerts: [] });
  check("render separates excluded supersessions from unresolved pending", excludedRendered.includes("pending=0 excluded=1"));

  rmSync(root, { recursive: true, force: true });
  console.log(`\n${passed}/${passed + failed} checks passed`);
  if (failed > 0) process.exit(1);
}

run();
