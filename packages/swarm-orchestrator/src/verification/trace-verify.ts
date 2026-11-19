/**
 * Deterministic trace-verify pass — catches "agent declared success but lied".
 *
 * Roadmap §8 (AIEWF 2026 corpus — IBM + Arize): a post-hoc step that reflects
 * over the captured trace to assert claimed work actually landed, instead of
 * trusting the executor's self-reported exit code. The swarm today treats
 * exit-code-0 as success and postFlightEval() counts those successes WITHOUT
 * ever confirming the claimed work exists on disk. That is the "declared success
 * but lied" gap.
 *
 * HONEST SCOPE: the swarm captures NO per-tool-call tape (t3-run
 * synthesizeTrajectory builds a minimal 2-turn trajectory). So this is NOT a
 * tool-action replay. It verifies CLAIM-VS-DISK-GROUND-TRUTH on what the swarm
 * DOES capture, via four check classes against every TaskResult that DECLARED
 * success (a declared FAILURE cannot be a lie and is skipped):
 *
 *   (1) expectedMutations [critical] — completes the documented-but-unwired R3:
 *       each {file, contains} contract file must exist AND contain the substring.
 *   (2) artifacts          [critical] — each reported artifact path (incl. child
 *       records) must exist on disk and be non-empty.
 *   (3) prose-claims        [info]    — conservative scan of output prose for
 *       explicit write/creation claims naming an ABSOLUTE path; never critical
 *       (prose is noisy — info-only to avoid eroding trust on false positives).
 *   (4) consistency         [warning] — success===true while error is populated,
 *       or empty output on a declared success.
 *
 * PURE: the filesystem is reached only through an INJECTED probe, so the core is
 * deterministic and never touches real disk in tests. Reuses the gap-audit
 * categorized-report shape.
 *
 * @module zouroboros-swarm/verification/trace-verify
 */

import { getWorkspaceRoot } from 'zouroboros-core';
import type { TaskResult } from '../types.js';

export type TraceViolationCategory =
  | 'expected-mutation'
  | 'artifact'
  | 'prose-claim'
  | 'consistency';

export type TraceViolationSeverity = 'critical' | 'warning' | 'info';

export interface TraceViolation {
  taskId: string;
  category: TraceViolationCategory;
  severity: TraceViolationSeverity;
  /** What the task declared / claimed. */
  claim: string;
  /** The ground-truth condition that should hold. */
  expected: string;
  /** What was actually found. */
  actual: string;
  message: string;
  remediation: string;
}

export interface TraceVerifyReport {
  timestamp: number;
  totalResults: number;
  /** Results with success===true that were actually verified. */
  checkedResults: number;
  violations: TraceViolation[];
  /** passed = (no critical violations). */
  passed: boolean;
  summary: {
    critical: number;
    warning: number;
    info: number;
    byCategory: Record<TraceViolationCategory, number>;
  };
}

/**
 * Injected filesystem probe — keeps verifyTrace pure and deterministic in tests.
 * `read` returns null when the path is missing OR unreadable.
 */
export interface FsProbe {
  exists(path: string): boolean;
  read(path: string): string | null;
}

export interface VerifyTraceOptions {
  /** Enable conservative prose-claim scanning (default true). */
  proseScan?: boolean;
}

/**
 * Conservative prose-claim matcher: a write/creation verb followed, within a
 * short slash-free window, by an ABSOLUTE path. The slash-free gap guarantees we
 * capture the FIRST absolute path after the verb; the `(?<=\s)` lookbehind forces
 * the path's leading slash to sit on a whitespace boundary so a relative token
 * like "foo/bar.txt" is NOT mis-split into a fake absolute "/bar.txt"; and the
 * restricted path charset (no spaces/quotes) keeps false positives low.
 */
const CLAIM_PATH_RE =
  /\b(?:wrote|created|saved|generated|written|updated)\b[^\n/]{0,40}(?<=\s)(\/[A-Za-z0-9._\-/]+)/gi;

/** Extract absolute paths explicitly claimed as written/created in output prose. */
export function extractClaimedPaths(output: string): string[] {
  const paths = new Set<string>();
  CLAIM_PATH_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CLAIM_PATH_RE.exec(output)) !== null) {
    // Strip trailing sentence punctuation that the charset may have swept up.
    const p = m[1].replace(/[.,;:)\]}'"]+$/, '');
    if (p.length > 1) paths.add(p);
  }
  return [...paths];
}

/** Gather all reported artifact paths from a result and its child records. */
function collectArtifactPaths(r: TaskResult): string[] {
  const out: string[] = [];
  for (const a of r.artifacts ?? []) if (a && a.trim()) out.push(a);
  for (const c of r.childRecords ?? [])
    for (const a of c.artifacts ?? []) if (a && a.trim()) out.push(a);
  return out;
}

/**
 * Verify declared-success TaskResults against on-disk ground truth.
 * Pure: all filesystem access flows through the injected `probe`.
 */
export function verifyTrace(
  results: TaskResult[],
  probe: FsProbe,
  opts: VerifyTraceOptions = {},
): TraceVerifyReport {
  const proseScan = opts.proseScan !== false;
  const violations: TraceViolation[] = [];
  let checkedResults = 0;

  for (const r of results) {
    // A declared FAILURE cannot be a lie — skip it.
    if (!r.success) continue;
    checkedResults++;
    const taskId = r.task?.id ?? '(unknown)';

    // ── (1) expectedMutations [critical] — completes the unwired R3 ──
    for (const em of r.task?.expectedMutations ?? []) {
      const content = probe.read(em.file);
      if (content === null) {
        violations.push({
          taskId,
          category: 'expected-mutation',
          severity: 'critical',
          claim: `declared success with an expectedMutation on ${em.file}`,
          expected: `${em.file} exists and contains "${em.contains}"`,
          actual: 'file is missing or unreadable',
          message: `Declared-success task "${taskId}" did not produce its required mutation: ${em.file} is missing.`,
          remediation: `Confirm the task actually wrote ${em.file}; if the path moved, update Task.expectedMutations.`,
        });
      } else if (!content.includes(em.contains)) {
        violations.push({
          taskId,
          category: 'expected-mutation',
          severity: 'critical',
          claim: `declared success with an expectedMutation on ${em.file}`,
          expected: `${em.file} contains "${em.contains}"`,
          actual: 'file present but required substring absent',
          message: `Declared-success task "${taskId}" mutation incomplete: ${em.file} does not contain "${em.contains}".`,
          remediation: `Verify the task wrote the expected content; update expectedMutations.contains if the contract changed.`,
        });
      }
    }

    // ── (2) artifacts [critical] ──
    for (const p of collectArtifactPaths(r)) {
      if (!probe.exists(p)) {
        violations.push({
          taskId,
          category: 'artifact',
          severity: 'critical',
          claim: `reported artifact ${p}`,
          expected: `${p} exists and is non-empty`,
          actual: 'does not exist on disk',
          message: `Declared-success task "${taskId}" reported an artifact that is not on disk: ${p}.`,
          remediation: `Confirm the artifact path is correct and was actually written.`,
        });
        continue;
      }
      const content = probe.read(p);
      if (content !== null && content.trim() === '') {
        violations.push({
          taskId,
          category: 'artifact',
          severity: 'critical',
          claim: `reported artifact ${p}`,
          expected: `${p} is non-empty`,
          actual: 'exists but is empty',
          message: `Declared-success task "${taskId}" artifact is empty: ${p}.`,
          remediation: `Confirm the task wrote real content, not an empty placeholder.`,
        });
      }
    }

    // ── (3) prose-claims [info] — never critical ──
    if (proseScan && r.output) {
      for (const claimed of extractClaimedPaths(r.output)) {
        if (!probe.exists(claimed)) {
          violations.push({
            taskId,
            category: 'prose-claim',
            severity: 'info',
            claim: `output prose claims it wrote/created ${claimed}`,
            expected: `${claimed} exists`,
            actual: 'not found on disk',
            message: `Task "${taskId}" output claims a file at ${claimed} but it was not found (prose heuristic — advisory only).`,
            remediation: `If the claim is real, ensure the file was written; otherwise the agent may be over-claiming.`,
          });
        }
      }
    }

    // ── (4) consistency [warning] ──
    if (r.error && r.error.trim() !== '') {
      violations.push({
        taskId,
        category: 'consistency',
        severity: 'warning',
        claim: 'success === true',
        expected: 'no error populated on a successful result',
        actual: `error is set: ${r.error.slice(0, 120)}`,
        message: `Task "${taskId}" declared success but carries an error field.`,
        remediation: `Reconcile the executor's success signal with the error it reported.`,
      });
    }
    if (r.output === undefined || r.output.trim() === '') {
      violations.push({
        taskId,
        category: 'consistency',
        severity: 'warning',
        claim: 'success === true',
        expected: 'non-empty output on a successful result',
        actual: 'output is empty',
        message: `Task "${taskId}" declared success with empty output.`,
        remediation: `Confirm the executor produced real output; empty output on success often signals a silent failure.`,
      });
    }
  }

  const critical = violations.filter(v => v.severity === 'critical').length;
  const warning = violations.filter(v => v.severity === 'warning').length;
  const info = violations.filter(v => v.severity === 'info').length;
  const byCategory: Record<TraceViolationCategory, number> = {
    'expected-mutation': 0,
    artifact: 0,
    'prose-claim': 0,
    consistency: 0,
  };
  for (const v of violations) byCategory[v.category]++;

  return {
    timestamp: Date.now(),
    totalResults: results.length,
    checkedResults,
    violations,
    passed: critical === 0,
    summary: { critical, warning, info, byCategory },
  };
}

/**
 * Real filesystem probe backed by node fs (matches gap-audit.ts's convention).
 * Only invoked from the wired path; the pure verifyTrace core never imports fs.
 */
export function createRealFsProbe(): FsProbe {
  // Lazy require keeps the pure module importable without fs in test contexts.
  const { existsSync, readFileSync } = require('fs');
  return {
    exists: (p: string): boolean => {
      try {
        return existsSync(p);
      } catch {
        return false;
      }
    },
    read: (p: string): string | null => {
      try {
        return readFileSync(p, 'utf-8');
      } catch {
        return null;
      }
    },
  };
}

/**
 * Persist a trace-verify report to {SWARM_WORKSPACE}/.swarm/trace-verify/{id}.json.
 * Wired-path only — lazy require keeps the pure verifyTrace core fs-free.
 * Returns the written path. `id` defaults to the report timestamp.
 */
export function persistTraceVerifyReport(
  report: TraceVerifyReport,
  opts: { dir?: string; id?: string | number } = {},
): string {
  const { mkdirSync, writeFileSync } = require('fs');
  const { join } = require('path');
  const workspace = process.env.SWARM_WORKSPACE || getWorkspaceRoot();
  const dir = opts.dir ?? join(workspace, '.swarm', 'trace-verify');
  const id = String(opts.id ?? report.timestamp);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(path, JSON.stringify(report, null, 2), 'utf-8');
  return path;
}

/** Render a readable per-task violation block, mirroring printGapAuditReport's style. */
export function renderTraceVerifyReport(report: TraceVerifyReport): string {
  const lines: string[] = [];
  lines.push('='.repeat(70));
  lines.push('TRACE-VERIFY REPORT (declared-success vs on-disk ground truth)');
  lines.push('='.repeat(70));
  lines.push(`  Results: ${report.totalResults} total, ${report.checkedResults} declared-success checked`);
  lines.push(
    `  Violations: ${report.summary.critical} critical, ${report.summary.warning} warning, ${report.summary.info} info`,
  );
  lines.push('');

  if (report.violations.length === 0) {
    lines.push('  ✅ No trace-verify violations — every declared success is backed by disk.');
  } else {
    const byTask = new Map<string, TraceViolation[]>();
    for (const v of report.violations) {
      const list = byTask.get(v.taskId) ?? [];
      list.push(v);
      byTask.set(v.taskId, list);
    }
    for (const [taskId, vs] of byTask) {
      lines.push(`  Task "${taskId}":`);
      for (const v of vs) {
        const icon = v.severity === 'critical' ? '✗' : v.severity === 'warning' ? '⚠' : 'ℹ';
        lines.push(`    ${icon} [${v.category}] ${v.message}`);
        lines.push(`        claim:    ${v.claim}`);
        lines.push(`        expected: ${v.expected}`);
        lines.push(`        actual:   ${v.actual}`);
        lines.push(`        → ${v.remediation}`);
      }
      lines.push('');
    }
  }

  lines.push('='.repeat(70));
  lines.push(`  ${report.passed ? '✅ PASS' : '❌ FAIL'} (${report.summary.critical} critical violations)`);
  lines.push('='.repeat(70));
  return lines.join('\n');
}
