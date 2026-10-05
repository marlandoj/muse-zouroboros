import { describe, test, expect, afterEach } from 'bun:test';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appendDecisionRow,
  readDecisionLedger,
  verifyHashChain,
  summarizeBySeat,
  summarizeByModel,
  computeJoinStatus,
  assertOutcomeCoverage,
  buildRepairBrief,
  shouldEscalate,
} from '../ledger/decision-ledger.js';
import { ExecutorClient } from '../client/executor-client.js';
import type { ExecutorTransport } from '../transport/types.js';
import type { ExecutorRegistryEntry, TaskResult } from '../types.js';

const ledgers: string[] = [];
function tmpLedger(): string {
  const p = join(tmpdir(), `zb-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
  ledgers.push(p);
  return p;
}
afterEach(() => {
  for (const p of ledgers.splice(0)) if (existsSync(p)) rmSync(p, { force: true });
});

function row(over: Record<string, unknown> = {}) {
  return {
    traceId: 'trace-1',
    personaId: 'persona-a',
    harness: 'codex',
    status: 'success' as const,
    latencyMs: 42,
    seatDispatch: { enabled: false, bindings: [] },
    ...over,
  };
}

describe('decision ledger (G2/G3)', () => {
  test('append + read round-trips with a verifiable hash chain', () => {
    const p = tmpLedger();
    appendDecisionRow(p, row());
    appendDecisionRow(p, row({ traceId: 'trace-2', status: 'hold', verdict: 'needs-work' }));
    const rows = readDecisionLedger(p);
    expect(rows.length).toBe(2);
    expect(rows[0].prevHash).toBe('');
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(verifyHashChain(rows)).toBe(-1);
  });

  test('writer fails loudly on missing seat-keyed identity', () => {
    const p = tmpLedger();
    expect(() => appendDecisionRow(p, row({ personaId: '' }))).toThrow(/personaId/);
    expect(() => appendDecisionRow(p, row({ harness: '' }))).toThrow(/harness/);
  });

  test('seat summary is keyed by seat; model view is derived from the same rows', () => {
    const p = tmpLedger();
    appendDecisionRow(p, row({ seat: 'reviewer-1', modelId: 'm1' }));
    appendDecisionRow(p, row({ traceId: 't2', seat: 'reviewer-1', modelId: 'm1', status: 'failure' }));
    appendDecisionRow(p, row({ traceId: 't3', seat: 'reviewer-2', modelId: 'm2' }));
    const rows = readDecisionLedger(p);
    expect(summarizeBySeat(rows)['reviewer-1']).toEqual({ votes: 2, successes: 1 });
    expect(summarizeByModel(rows)['m1']).toEqual({ votes: 2, successes: 1 });
  });

  test('join status is computed, and zero outcome votes hard-fails (G3)', () => {
    const p = tmpLedger();
    appendDecisionRow(p, row());
    const rows = readDecisionLedger(p);
    expect(computeJoinStatus(rows, new Set(['trace-1']))).toBe('healthy');
    expect(computeJoinStatus(rows, new Set())).toBe('pending');
    expect(computeJoinStatus(rows, new Set(['other']))).toBe('failed');
    expect(() => assertOutcomeCoverage(rows, new Set())).toThrow(/outcome_votes is 0/);
    expect(() => assertOutcomeCoverage(rows, new Set(['trace-1']))).not.toThrow();
  });

  test('reflection primitives: structured brief required, repeat HOLD escalates', () => {
    expect(() => buildRepairBrief('t', [])).toThrow(/at least one/);
    const brief = buildRepairBrief('t', [{ file: 'a.ts', findingId: 'F1', severity: 'major', requiredChange: 'fix it' }]);
    expect(brief.maxCycles).toBe(2);
    const p = tmpLedger();
    for (let i = 0; i < 3; i++) appendDecisionRow(p, row({ status: 'hold', verdict: 'same-reason' }));
    expect(shouldEscalate(readDecisionLedger(p), 'trace-1', 'same-reason')).toBe(true);
  });
});

const STUB_ENTRY: ExecutorRegistryEntry = {
  id: 'codex',
  name: 'Codex CLI',
  executor: 'local',
  bridge: '/bin/echo',
  description: 'Test executor',
  expertise: ['code'],
  bestFor: ['code'],
  transport: 'bridge',
  config: { defaultTimeout: 120 },
};
const MOCK_RESULT: TaskResult = { task: {} as any, success: true, output: 'ok', durationMs: 5, retries: 0 };

function stubTransport(capture?: (t: any) => void): ExecutorTransport {
  return {
    execute: async (task) => { capture?.(task); return MOCK_RESULT; },
    executeWithUpdates: () => ({ updates: (async function* () {})(), result: Promise.resolve(MOCK_RESULT) }),
    healthCheck: async () => ({ healthy: true }),
    shutdown: async () => {},
  };
}

describe('ExecutorClient seat dispatch + ledger (G1/G2)', () => {
  test('run() with a ledger configured persists exactly one seat-keyed row', async () => {
    const p = tmpLedger();
    const before = readDecisionLedger(p).length;
    let task: any;
    const client = ExecutorClient._withTransport(STUB_ENTRY, stubTransport((t) => (task = t)));
    const res = await client.run('Hello world', { persona: 'reviewer-a', seat: 'reviewer-1', model: 'm-x', skipRAG: true, ledgerPath: p, traceId: 'trace-99' });
    const rows = readDecisionLedger(p);
    expect(rows.length).toBe(before + 1);
    expect(rows[0].traceId).toBe('trace-99');
    expect(rows[0].personaId).toBe('reviewer-a');
    expect(rows[0].harness).toBe('codex');
    expect(rows[0].seatDispatch.enabled).toBe(true);
    expect(task.persona).toBe('reviewer-a');
    expect(task.model).toBe('m-x');
    expect(res.persona).toBe('reviewer-a');
    expect(res.seatDispatch.enabled).toBe(true);
  });

  test('defaults are unchanged when seat options are unset', async () => {
    let task: any;
    const client = ExecutorClient._withTransport(STUB_ENTRY, stubTransport((t) => (task = t)));
    const res = await client.run('Hello world');
    expect(task.persona).toBe('alaric');
    expect(task.model).toBeUndefined();
    expect(res.seatDispatch.enabled).toBe(false);
  });

  test('skipRAG suppresses enrichment even with forceRAG', async () => {
    const client = ExecutorClient._withTransport(STUB_ENTRY, stubTransport());
    const res = await client.run('analyze the architecture deeply', { forceRAG: true, skipRAG: true });
    expect(res.ragContext).toBe('');
    expect(res.ragPatterns).toBe(0);
  });
});
