/**
 * Synthesizer unit tests — regression guard for the TaskResult → T2 Trajectory
 * mapping, especially the cost-accounting integrity path.
 *
 * Why this test matters: before P4 was resolved, the bridge did not populate
 * `tokensUsed` at all, so `cost_swarm = $0` in real-CLI smokes. The labeling
 * formula `swarm_worth_score = Δpass^3 / Δcost` would then divide by a negative
 * denominator and invert sign. These tests pin the contract:
 *   1. Bridge surfaces precise input/output → trajectory uses them verbatim and
 *      prefers the executor-reported cost when present.
 *   2. Older bridges that report only `tokensUsed` → 70/30 in/out split fallback
 *      (matches `orchestrator.ts` recordUsage convention).
 *   3. Failure paths classify terminate_reason correctly even when tokens are 0.
 */

import { test, expect } from 'bun:test';
import { synthesizeTrajectory } from './t3-run.js';
import type { T3Envelope } from './t3-run.js';
import type { Task, TaskResult } from '../types.js';

const ENV: T3Envelope = {
  id: 't3-fixture-001',
  domain: 'lookup',
  difficulty: 'easy',
  problem: {
    statement: 'Print the SHA of HEAD.',
    initial_state: { workspace_path: '/tmp', tools_available: ['bash'] },
  },
  budgets: { max_turns: 4, max_input_tokens: 4000, max_output_tokens: 500, wall_clock_s: 10 },
  contamination: { uuid: '11111111-1111-1111-1111-111111111111' },
};

const TASK: Task = {
  id: ENV.id,
  persona: 'zourobench-t3',
  task: ENV.problem.statement,
  priority: 'medium',
  executor: 'claude-code',
  model: 'claude-sonnet-4-6',
};

function baseArgs(result: TaskResult) {
  return {
    envelope: ENV,
    seed: 1,
    consensus_gate: 'off' as const,
    result,
    model: 'claude-sonnet-4-6',
    startedAt: '2026-05-28T00:00:00Z',
    finishedAt: '2026-05-28T00:00:05Z',
  };
}

test('synthesizer prefers bridge-reported input/output tokens and CLI cost when present', () => {
  const result: TaskResult = {
    task: TASK,
    success: true,
    output: 'a1b2c3',
    durationMs: 1234,
    retries: 0,
    inputTokens: 700,
    outputTokens: 300,
    tokensUsed: 1000,
    costUsd: 0.0423,
    modelUsed: 'claude-sonnet-4-6',
    effectiveExecutor: 'claude-code',
  };
  const traj = synthesizeTrajectory(baseArgs(result));
  expect(traj.total_input_tokens).toBe(700);
  expect(traj.total_output_tokens).toBe(300);
  expect(traj.total_cost_usd).toBe(0.0423);
  expect(traj.turns[1].tokens_in).toBe(700);
  expect(traj.turns[1].tokens_out).toBe(300);
  expect(traj.terminate_reason).toBe('success');
});

test('synthesizer falls back to 70/30 split + per-1M rate when only tokensUsed is reported', () => {
  // This is the historical contract for executors that don't surface
  // input/output separately. orchestrator.ts:477-479 uses the same split.
  const result: TaskResult = {
    task: TASK,
    success: true,
    output: 'ok',
    durationMs: 500,
    retries: 0,
    tokensUsed: 1000,
    modelUsed: 'claude-sonnet-4-6',
  };
  const traj = synthesizeTrajectory(baseArgs(result));
  expect(traj.total_input_tokens).toBe(700);
  expect(traj.total_output_tokens).toBe(300);
  // claude-sonnet-4-6 rate: $3 in / $15 out per 1M
  //   700 * $3/1M + 300 * $15/1M = 0.0021 + 0.0045 = 0.0066
  expect(traj.total_cost_usd).toBeCloseTo(0.0066, 6);
  expect(traj.total_cost_usd).toBeGreaterThan(0);
});

test('synthesizer success with zero tokens (e.g. cached) still yields a valid trajectory', () => {
  const result: TaskResult = {
    task: TASK,
    success: true,
    output: 'cached',
    durationMs: 5,
    retries: 0,
    modelUsed: 'claude-sonnet-4-6',
  };
  const traj = synthesizeTrajectory(baseArgs(result));
  expect(traj.terminate_reason).toBe('success');
  expect(traj.total_input_tokens).toBe(0);
  expect(traj.total_output_tokens).toBe(0);
  expect(traj.total_cost_usd).toBe(0);
});

test('synthesizer classifies timeout errors as budget_exhausted_wall', () => {
  const result: TaskResult = {
    task: TASK,
    success: false,
    error: 'Command timed out after 10s',
    durationMs: 10000,
    retries: 0,
  };
  const traj = synthesizeTrajectory(baseArgs(result));
  expect(traj.terminate_reason).toBe('budget_exhausted_wall');
});

test('synthesizer classifies token/context errors as budget_exhausted_tokens', () => {
  const result: TaskResult = {
    task: TASK,
    success: false,
    error: 'prompt exceeded the model context length',
    durationMs: 100,
    retries: 0,
  };
  const traj = synthesizeTrajectory(baseArgs(result));
  expect(traj.terminate_reason).toBe('budget_exhausted_tokens');
});

test('synthesizer respects only-inputTokens reported (partial bridge support)', () => {
  // Some bridges may surface inputTokens but not outputTokens. The synthesizer
  // should still take that as authoritative, with outputTokens defaulting to 0.
  const result: TaskResult = {
    task: TASK,
    success: true,
    output: 'partial',
    durationMs: 200,
    retries: 0,
    inputTokens: 500,
    modelUsed: 'claude-sonnet-4-6',
  };
  const traj = synthesizeTrajectory(baseArgs(result));
  expect(traj.total_input_tokens).toBe(500);
  expect(traj.total_output_tokens).toBe(0);
  // No costUsd, no outputTokens -> cost from rate table: 500 * $3/1M = $0.0015
  expect(traj.total_cost_usd).toBeCloseTo(0.0015, 6);
});

test('synthesizer encodes consensus_gate in runner_id', () => {
  const result: TaskResult = {
    task: TASK,
    success: true,
    output: 'ok',
    durationMs: 50,
    retries: 0,
    effectiveExecutor: 'claude-code',
  };
  const trajOn = synthesizeTrajectory({ ...baseArgs(result), consensus_gate: 'on' });
  const trajOff = synthesizeTrajectory({ ...baseArgs(result), consensus_gate: 'off' });
  expect(trajOn.runner_id).toBe('zouroboros-swarm:claude-code(on)');
  expect(trajOff.runner_id).toBe('zouroboros-swarm:claude-code(off)');
});
