/**
 * Integration: postFlightEval ⇄ trace-verify wiring.
 *
 * Proves the three contract points of the T2/T3 wiring:
 *   (P) flag OFF (SWARM_TRACE_VERIFY=0) ⇒ byte-identical tally + no [TRACE-VERIFY]
 *       output and no traceVerify field (parity with pre-change main).
 *   (A) report ON (default) ⇒ advisory: traceVerify attached, artifact persisted,
 *       a critical lie is REPORTED but does NOT change `passed`/successRate.
 *   (E) enforce ON ⇒ a critical trace violation flips that task's counted success
 *       → false (enforce_target = A), dropping successRate and listing the task.
 *
 * Disk writes are isolated via a temp SWARM_WORKSPACE; the orchestrator's sqlite
 * singleton is pinned to a temp dbPath (first getDb() call in this isolated file).
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SwarmOrchestrator } from '../orchestrator.js';
import type { TaskResult } from '../types.js';

let workspace: string;
let orch: SwarmOrchestrator;

function mkResult(p: Partial<TaskResult> & { id: string; success: boolean }): TaskResult {
  const { id, success, ...rest } = p;
  return {
    task: rest.task ?? { id, persona: 'p', task: 't', priority: 'medium' },
    success,
    output: rest.output ?? 'did the thing',
    durationMs: 1,
    retries: 0,
    ...rest,
  } as TaskResult;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => T): T {
  const prev: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    prev[k] = process.env[k];
    if (env[k] === undefined) delete process.env[k];
    else process.env[k] = env[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (prev[k] === undefined) delete process.env[k];
      else process.env[k] = prev[k];
    }
  }
}

beforeAll(() => {
  workspace = mkdtempSync(join(tmpdir(), 'tv-postflight-'));
  process.env.SWARM_WORKSPACE = workspace;
  orch = new SwarmOrchestrator({ dbPath: join(workspace, 'swarm.db') });
});

afterAll(() => {
  delete process.env.SWARM_WORKSPACE;
  try {
    rmSync(workspace, { recursive: true, force: true });
  } catch {}
});

describe('postFlightEval ⇄ trace-verify', () => {
  it('(P) flag OFF ⇒ byte-identical tally, no traceVerify, no [TRACE-VERIFY] in report', () => {
    const honest = mkResult({ id: 'a', success: true, output: 'fine' });
    const lie = mkResult({
      id: 'b',
      success: true,
      task: { id: 'b', persona: 'p', task: 't', priority: 'medium', expectedMutations: [{ file: '/definitely/missing.ts', contains: 'X' }] } as any,
    });
    const ev = withEnv({ SWARM_TRACE_VERIFY: '0', SWARM_TRACE_VERIFY_ENFORCE: undefined }, () =>
      orch.postFlightEval([honest, lie]),
    );
    // Both declared success → tally sees 2/2 (the lie is invisible without verify).
    expect(ev.successRate).toBe(1);
    expect(honest.success).toBe(true);
    expect(ev.passed).toBe(true);
    expect(ev.failedTasks).toEqual([]);
    expect(ev.traceVerify).toBeUndefined();
    expect(ev.report).not.toContain('[TRACE-VERIFY]');
  });

  it('(A) report ON (default) ⇒ advisory: lie reported, passed unchanged, artifact written', () => {
    const honest = mkResult({ id: 'a', success: true, output: 'fine' });
    const lie = mkResult({
      id: 'b',
      success: true,
      task: { id: 'b', persona: 'p', task: 't', priority: 'medium', expectedMutations: [{ file: '/definitely/missing.ts', contains: 'X' }] } as any,
    });
    const ev = withEnv({ SWARM_TRACE_VERIFY: undefined, SWARM_TRACE_VERIFY_ENFORCE: undefined }, () =>
      orch.postFlightEval([honest, lie]),
    );
    // Advisory: tally still 2/2 (passed unchanged) but the violation is surfaced.
    expect(ev.successRate).toBe(1);
    expect(ev.passed).toBe(true);
    expect(ev.failedTasks).toEqual([]);
    expect(ev.traceVerify).toBeDefined();
    expect(ev.traceVerify!.summary.critical).toBe(1);
    expect(ev.traceVerify!.passed).toBe(false);
    expect(ev.report).toContain('[TRACE-VERIFY]');
    // artifact persisted under the temp workspace
    const dir = join(workspace, '.swarm', 'trace-verify');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir).some(f => f.endsWith('.json'))).toBe(true);
  });

  it('(E) enforce ON ⇒ critical lie flips that task success→fail in the tally', () => {
    const honest = mkResult({ id: 'a', success: true, output: 'fine' });
    const lie = mkResult({
      id: 'b',
      success: true,
      task: { id: 'b', persona: 'p', task: 't', priority: 'medium', expectedMutations: [{ file: '/definitely/missing.ts', contains: 'X' }] } as any,
    });
    const ev = withEnv({ SWARM_TRACE_VERIFY: undefined, SWARM_TRACE_VERIFY_ENFORCE: '1' }, () =>
      orch.postFlightEval([honest, lie]),
    );
    expect(ev.successRate).toBe(0.5);
    expect(ev.failedTasks).toContain('b');
    expect(ev.failedTasks).not.toContain('a');
    expect(ev.report).toContain('ENFORCE');
    expect(lie.success).toBe(false);
    expect(lie.error).toContain('Post-flight verification failed');
    expect(honest.success).toBe(true);
  });

  it('(E) enforce does NOT flip a task whose expectedMutation truly landed', () => {
    const realFile = join(workspace, 'landed.ts');
    writeFileSync(realFile, "export const ok = 'LANDED';", 'utf-8');
    const honest = mkResult({
      id: 'good',
      success: true,
      task: { id: 'good', persona: 'p', task: 't', priority: 'medium', expectedMutations: [{ file: realFile, contains: 'LANDED' }] } as any,
    });
    const ev = withEnv({ SWARM_TRACE_VERIFY: undefined, SWARM_TRACE_VERIFY_ENFORCE: '1' }, () =>
      orch.postFlightEval([honest]),
    );
    expect(ev.successRate).toBe(1);
    expect(ev.passed).toBe(true);
    expect(ev.failedTasks).toEqual([]);
  });
});
