/**
 * Per-session harness smoke test — fast deterministic sanity probe at run start.
 *
 * Roadmap §10 (AIEWF 2026 corpus): re-question the harness on every session/model
 * upgrade with a cheap smoke test before doing real work, so a quietly-broken
 * harness (lost transport, unreadable durable log, a tampered feature-list spec, a
 * malformed enforce flag) is caught at the top of run() instead of corrupting a
 * long campaign. ADVISORY by default — reports, never blocks; a separate enforce
 * flag (wired in the orchestrator) may abort on a CRITICAL finding.
 *
 * PURE: every external read flows through an INJECTED probe, so the core is
 * deterministic and never touches the real db/fs in tests. Mirrors the P2-8
 * trace-verify report/severity shape it sits beside.
 *
 * @module zouroboros-swarm/harness/smoke-test
 */

import { join } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';
import { verifyFeatureListIntegrity, type FeatureList } from './feature-list.js';

export type SmokeSeverity = 'critical' | 'warning' | 'info';
export type SmokeCheckId =
  | 'feature-list-integrity'
  | 'durable-log'
  | 'transport'
  | 'config-coherence';

export interface SmokeFinding {
  check: SmokeCheckId;
  severity: SmokeSeverity;
  message: string;
  detail: string;
}

export interface SmokeReport {
  timestamp: number;
  findings: SmokeFinding[];
  summary: { critical: number; warning: number; info: number };
  /** passed = (no critical finding). */
  passed: boolean;
}

/** Result of probing the durable event log (swarm.db) for sanity. */
export interface DurableLogStatus {
  readable: boolean;
  recordCount: number;
}

/** Injected probes — keep runSmokeChecks pure/offline in tests. */
export interface SmokeProbes {
  durableLog(): DurableLogStatus;
}

export interface SmokeInput {
  /** When present, its hash integrity is checked; absent ⇒ check is a graceful no-op. */
  featureList?: FeatureList | null;
  /** Number of executor transports registered (orchestrator `this.transports.size`). */
  transportCount: number;
  /**
   * Raw env-flag values relevant to enforcement, for coherence checking. A flag
   * set to anything outside the accepted truthy/falsy vocabulary is a warning
   * (it silently won't do what the operator likely intended).
   */
  flags?: Record<string, string | undefined>;
}

const ACCEPTED_FLAG_VALUES = new Set(['0', '1', 'true', 'false', '']);

/**
 * Run the per-session smoke checks. Each check emits exactly one finding (an
 * `info` finding means healthy), so the report always shows the full harness
 * picture. passed = (no critical).
 */
export function runSmokeChecks(input: SmokeInput, probes: SmokeProbes): SmokeReport {
  const findings: SmokeFinding[] = [];

  // (a) feature-list integrity [critical on mismatch] — graceful skip when absent.
  if (input.featureList) {
    const integ = verifyFeatureListIntegrity(input.featureList);
    if (integ.ok) {
      findings.push({
        check: 'feature-list-integrity',
        severity: 'info',
        message: `feature-list "${input.featureList.campaign}" hash intact`,
        detail: `${input.featureList.features.length} feature(s)`,
      });
    } else {
      findings.push({
        check: 'feature-list-integrity',
        severity: 'critical',
        message: `feature-list "${input.featureList.campaign}" hash MISMATCH — spec was overwritten or tampered`,
        detail: `expected ${integ.expected.slice(0, 12)}… got ${integ.actual.slice(0, 12)}…`,
      });
    }
  } else {
    findings.push({
      check: 'feature-list-integrity',
      severity: 'info',
      message: 'no feature-list configured (integrity check skipped)',
      detail: 'set SWARM_FEATURE_LIST to enable',
    });
  }

  // (b) durable log readable + non-empty [warning if unreadable/empty].
  const log = probes.durableLog();
  if (!log.readable) {
    findings.push({
      check: 'durable-log',
      severity: 'warning',
      message: 'durable event log is unreadable',
      detail: 'swarm.db could not be opened — the run will execute but leave no durable trace',
    });
  } else if (log.recordCount === 0) {
    findings.push({
      check: 'durable-log',
      severity: 'warning',
      message: 'durable event log is empty',
      detail: 'swarm.db opened but holds 0 records (fresh db or a wiped log)',
    });
  } else {
    findings.push({
      check: 'durable-log',
      severity: 'info',
      message: 'durable event log readable',
      detail: `${log.recordCount} record(s)`,
    });
  }

  // (c) ≥1 transport configured [critical if zero].
  if (input.transportCount <= 0) {
    findings.push({
      check: 'transport',
      severity: 'critical',
      message: 'no executor transports registered',
      detail: 'tasks cannot be dispatched — register at least one transport',
    });
  } else {
    findings.push({
      check: 'transport',
      severity: 'info',
      message: 'executor transport(s) registered',
      detail: `${input.transportCount} transport(s)`,
    });
  }

  // (d) config coherence [warning on a malformed flag].
  const malformed: string[] = [];
  for (const [name, value] of Object.entries(input.flags ?? {})) {
    if (value === undefined) continue;
    if (!ACCEPTED_FLAG_VALUES.has(value.trim().toLowerCase())) malformed.push(`${name}=${value}`);
  }
  if (malformed.length > 0) {
    findings.push({
      check: 'config-coherence',
      severity: 'warning',
      message: 'one or more enforcement flags have a non-boolean value',
      detail: `${malformed.join(', ')} — expected one of 0/1/true/false (will be treated as OFF)`,
    });
  } else {
    findings.push({
      check: 'config-coherence',
      severity: 'info',
      message: 'enforcement flags coherent',
      detail: 'all recognized flags are well-formed',
    });
  }

  const summary = {
    critical: findings.filter(f => f.severity === 'critical').length,
    warning: findings.filter(f => f.severity === 'warning').length,
    info: findings.filter(f => f.severity === 'info').length,
  };

  return { timestamp: Date.now(), findings, summary, passed: summary.critical === 0 };
}

/** Render a one-screen smoke report, mirroring the trace-verify style. */
export function renderSmokeReport(report: SmokeReport): string {
  const lines: string[] = [];
  lines.push('='.repeat(70));
  lines.push('HARNESS SMOKE TEST (per-session sanity)');
  lines.push('='.repeat(70));
  lines.push(
    `  ${report.summary.critical} critical, ${report.summary.warning} warning, ${report.summary.info} info`,
  );
  lines.push('');
  for (const f of report.findings) {
    const icon = f.severity === 'critical' ? '✗' : f.severity === 'warning' ? '⚠' : 'ℹ';
    lines.push(`  ${icon} [${f.check}] ${f.message}`);
    lines.push(`        ${f.detail}`);
  }
  lines.push('');
  lines.push('='.repeat(70));
  lines.push(`  ${report.passed ? '✅ PASS' : '❌ FAIL'} (${report.summary.critical} critical)`);
  lines.push('='.repeat(70));
  return lines.join('\n');
}

/**
 * Canonical durable run/event tables in swarm.db. The probe sums rows across
 * whichever of these exist — a single table (e.g. swarm_heartbeats) can be empty
 * even on an active install, so "is there ANY durable trace of swarm activity"
 * is the honest signal. Tolerates schema drift (a missing table is skipped).
 */
const DURABLE_LOG_TABLES = [
  'swarm_heartbeats',
  'missions',
  'mission_steps',
  'mission_reports',
  'cost_ledger',
];

/**
 * Real durable-log probe — wired path only (lazy require keeps the core db-free).
 * Reads swarm.db READ-ONLY and counts rows across the canonical run/event tables.
 * Any failure (missing db, locked, schema drift) degrades to readable:false
 * rather than throwing.
 */
export function createRealDurableLogProbe(dbPath?: string): SmokeProbes {
  return {
    durableLog: (): DurableLogStatus => {
      try {
        const { Database } = require('bun:sqlite');
        const path = dbPath ?? process.env.SWARM_DB_PATH ?? join(getWorkspaceRoot(), '.swarm', 'swarm.db');
        const { existsSync } = require('fs');
        if (!existsSync(path)) return { readable: false, recordCount: 0 };
        const db = new Database(path, { readonly: true });
        try {
          let total = 0;
          for (const table of DURABLE_LOG_TABLES) {
            try {
              const row = db.query(`SELECT COUNT(*) AS n FROM "${table}"`).get() as
                | { n: number }
                | null;
              total += row?.n ?? 0;
            } catch {
              // table absent on this install — skip
            }
          }
          return { readable: true, recordCount: total };
        } finally {
          db.close();
        }
      } catch {
        return { readable: false, recordCount: 0 };
      }
    },
  };
}

/** Persist a smoke report to {SWARM_WORKSPACE}/.swarm/smoke/{id}.json. Wired-path only. */
export function persistSmokeReport(
  report: SmokeReport,
  opts: { dir?: string; id?: string | number } = {},
): string {
  const { mkdirSync, writeFileSync } = require('fs');
  const workspace = process.env.SWARM_WORKSPACE || getWorkspaceRoot();
  const dir = opts.dir ?? join(workspace, '.swarm', 'smoke');
  const id = String(opts.id ?? report.timestamp);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8');
  return path;
}
