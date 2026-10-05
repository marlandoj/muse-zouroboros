/**
 * Integration: orchestrator ⇄ harness-discipline wiring (roadmap §10).
 *
 *   SMOKE (run-start):
 *     (P) SWARM_HARNESS_SMOKE=0 ⇒ smoke block skipped — no [SMOKE] output.
 *     (A) default ON ⇒ advisory: a tampered feature-list is surfaced as critical
 *         but the run is NOT aborted.
 *     (E) SWARM_HARNESS_SMOKE_ENFORCE=1 ⇒ a critical smoke finding aborts before
 *         execution (all results synthesized as failed with the smoke error).
 *
 *   RECONCILE (postFlightEval):
 *     (P) no SWARM_FEATURE_LIST ⇒ no [FEATURE-LIST] line, tally untouched.
 *     (A) configured spec ⇒ advisory done/missing split surfaced WITHOUT changing
 *         passed/successRate.
 *
 * A dummy transport is injected so preflight passes; the enforce-abort returns
 * before any dispatch, so the transport is never actually called.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmOrchestrator } from '../orchestrator.js';
import { buildFeatureList } from '../harness/index.js';
import type { TaskResult, Task } from '../types.js';
import type { ExecutorTransport } from '../transport/types.js';

let workspace: string;
let specPath: string;
let orch: SwarmOrchestrator;

const FIXED = '2026-06-30T00:00:00.000Z';

const dummyTransport: ExecutorTransport = {
  execute: async () => ({ task: {} as Task, success: true, durationMs: 1, retries: 0 }),
  executeWithUpdates: () => ({
    updates: (async function* () {})(),
    result: Promise.resolve({ task: {} as Task, success: true, durationMs: 1, retries: 0 }),
  }),
  healthCheck: async () => ({ healthy: true }),
  shutdown: async () => {},
};

function mkResult(id: string, success: boolean): TaskResult {
  return {
    task: { id, persona: 'p', task: 't', priority: 'medium' } as unknown as Task,
    success,
    output: 'ok',
    durationMs: 1,
    retries: 0,
  } as TaskResult;
}

function writeGoodSpec(): void {
  const list = buildFeatureList(
    'demo',
    [
      { id: 'f1', title: 'one' },
      { id: 'f2', title: 'two' },
    ],
    { createdAt: FIXED },
  );
  writeFileSync(specPath, JSON.stringify(list, null, 2), 'utf-8');
}

function writeTamperedSpec(): void {
  const list = buildFeatureList('demo', [{ id: 'f1', title: 'one' }], { createdAt: FIXED });
  // overwrite the body but keep the now-stale hash → integrity mismatch on load
  const tampered = { ...list, features: [{ id: 'f1', title: 'REWRITTEN BY AGENT' }] };
  writeFileSync(specPath, JSON.stringify(tampered, null, 2), 'utf-8');
}

let logs: string[] = [];
const realLog = console.log;
const realErr = console.error;
function captureConsole(): void {
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(' '));
  console.error = (...a: unknown[]) => void logs.push(a.join(' '));
}
function restoreConsole(): void {
  console.log = realLog;
  console.error = realErr;
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'harness-'));
  process.env.SWARM_WORKSPACE = workspace;
  specPath = join(workspace, 'feature-list.json');
  // gates off so run([]) does preflight → smoke → execute(0) without seed/postflight side-effects
  orch = new SwarmOrchestrator({
    dbPath: join(workspace, 'swarm.db'),
    pipelineGates: { seedValidation: false, postFlightEval: false, gapAuditLoop: false },
  });
  // inject a dummy transport so preflight (≥1 transport) passes
  (orch as unknown as { transports: Map<string, ExecutorTransport> }).transports.set(
    'dummy',
    dummyTransport,
  );
});

afterAll(() => {
  delete process.env.SWARM_WORKSPACE;
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {}
});

afterEach(() => {
  restoreConsole();
  delete process.env.SWARM_HARNESS_SMOKE;
  delete process.env.SWARM_HARNESS_SMOKE_ENFORCE;
  delete process.env.SWARM_FEATURE_LIST;
});

describe('SMOKE wiring (run-start)', () => {
  it('(P) SWARM_HARNESS_SMOKE=0 ⇒ no [SMOKE] output (skipped)', async () => {
    writeTamperedSpec();
    process.env.SWARM_HARNESS_SMOKE = '0';
    process.env.SWARM_FEATURE_LIST = specPath;
    captureConsole();
    const results = await orch.run([]);
    restoreConsole();
    expect(results).toEqual([]);
    expect(logs.some(l => l.includes('[SMOKE]'))).toBe(false);
  });

  it('(A) default ON ⇒ tampered feature-list surfaced as critical, run NOT aborted', async () => {
    writeTamperedSpec();
    process.env.SWARM_FEATURE_LIST = specPath;
    captureConsole();
    const results = await orch.run([]);
    restoreConsole();
    expect(results).toEqual([]); // no abort
    const joined = logs.join('\n');
    expect(joined).toContain('[SMOKE]');
    expect(joined).toMatch(/1 critical/);
    expect(joined).toContain('hash MISMATCH');
    expect(joined).not.toContain('aborting before execution');
  });

  it('(E) enforce ⇒ critical smoke aborts before execution', async () => {
    writeTamperedSpec();
    process.env.SWARM_FEATURE_LIST = specPath;
    process.env.SWARM_HARNESS_SMOKE_ENFORCE = '1';
    captureConsole();
    const results = await orch.run([mkResult('t1', true).task]);
    restoreConsole();
    expect(results).toHaveLength(1);
    expect(results[0].success).toBe(false);
    expect(results[0].error).toMatch(/Harness smoke failed/);
    expect(logs.join('\n')).toContain('aborting before execution');
  });

  it('(A) healthy feature-list ⇒ smoke PASS, no critical', async () => {
    writeGoodSpec();
    process.env.SWARM_FEATURE_LIST = specPath;
    captureConsole();
    const results = await orch.run([]);
    restoreConsole();
    expect(results).toEqual([]);
    const joined = logs.join('\n');
    expect(joined).toContain('[SMOKE]');
    expect(joined).toMatch(/0 critical/);
  });
});

describe('RECONCILE wiring (postFlightEval)', () => {
  it('(P) no SWARM_FEATURE_LIST ⇒ no [FEATURE-LIST] line, tally untouched', () => {
    delete process.env.SWARM_FEATURE_LIST;
    const ev = orch.postFlightEval([mkResult('f1', true)]);
    expect(ev.report).not.toContain('[FEATURE-LIST]');
    expect(ev.successRate).toBe(1);
  });

  it('(A) configured spec ⇒ done/missing split surfaced, passed/successRate unchanged', () => {
    writeGoodSpec(); // f1, f2
    process.env.SWARM_FEATURE_LIST = specPath;
    const ev = orch.postFlightEval([mkResult('f1', true)]); // only f1 landed
    expect(ev.report).toContain('[FEATURE-LIST]');
    expect(ev.report).toContain('1/2 landed');
    expect(ev.report).toContain('missing: f2');
    // tally is from results ONLY — reconcile never changes it
    expect(ev.successRate).toBe(1);
    expect(ev.passed).toBe(true);
  });

  it('(A) all features landed ⇒ all delivered', () => {
    writeGoodSpec();
    process.env.SWARM_FEATURE_LIST = specPath;
    const ev = orch.postFlightEval([mkResult('f1', true), mkResult('f2', true)]);
    expect(ev.report).toContain('2/2 landed');
    expect(ev.report).toContain('all delivered');
  });
});
