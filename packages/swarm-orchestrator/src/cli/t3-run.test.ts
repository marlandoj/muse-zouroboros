/**
 * t3-run unit test — exercises the CLI surface end-to-end against a fixture
 * envelope, no real LLM calls.
 *
 * The orchestrator will attempt to dispatch via its configured transports;
 * since this test runs in a clean shell, transport dispatch fails fast and
 * surfaces as a TaskResult.success=false with an error. The synthesizer then
 * emits a schema-valid trajectory with terminate_reason='hard_error' or
 * 'budget_exhausted_*'. That's the expected harness behavior — we're proving
 * the harness produces a valid trajectory under failure, not validating the
 * underlying executor.
 */

import { test, expect } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const CLI = path.join(__dirname, 'index.ts');

function makeFixture(overrides: Partial<Record<string, unknown>> = {}): string {
  const dir = mkdtempSync(path.join(tmpdir(), 't3-run-test-'));
  const envelopePath = path.join(dir, 'envelope.yaml');
  const envelope = `
id: t3-test-${randomUUID().slice(0, 8)}
source:
  name: synthetic-direct
  upstream_id: test-001
  upstream_url: null
domain: lookup
difficulty: easy
metr_human_time_minutes: 1
metr_source: estimated
problem:
  statement: Echo the string "hello".
  initial_state:
    workspace_path: ${dir}
    tools_available:
      - bash
budgets:
  max_turns: 4
  max_input_tokens: 4000
  max_output_tokens: 500
  wall_clock_s: 10
acceptance:
  type: rubric-judge
  config:
    rubric: shallow test
  partial_credit:
    enabled: false
    substeps: []
label:
  ground_truth: null
  evidence:
    threshold_tau: 0.1
gate_features:
  signals: {}
contamination:
  uuid: ${randomUUID()}
  source_kind: synthetic-direct
  notes: test fixture
created_at: '${new Date().toISOString()}'
`;
  writeFileSync(envelopePath, envelope, 'utf-8');
  return envelopePath;
}

function runHarness(args: string[]): { stdout: string; stderr: string; status: number | null } {
  // Point ZOUROBOROS_WORKSPACE_ROOT at /tmp to force an empty executor registry
  // — preflight returns errors → orchestrator emits a synthesized failed
  // TaskResult fast (no real LLM dispatch). The harness must still produce a
  // schema-valid trajectory.
  const res = spawnSync('bun', [CLI, 't3-run', ...args], {
    encoding: 'utf-8',
    timeout: 60_000,
    env: {
      ...process.env,
      ZOUROBOROS_T3_MAX_USD: '5',
      ZOUROBOROS_WORKSPACE_ROOT: '/tmp/zb-empty-registry',
      // Point the consensus-gate at a missing path so the gate-on path takes
      // the fast 'skipped' branch — keeps the test hermetic (no real LLM
      // calls) and deterministic regardless of runner layout.
      ZOUROBOROS_CONSENSUS_GATE_PATH: '/tmp/zb-no-such-consensus-gate.ts',
    },
  });
  return { stdout: res.stdout ?? '', stderr: res.stderr ?? '', status: res.status };
}

test('t3-run rejects missing --task', () => {
  const { stderr, status } = runHarness(['--seed', '1', '--consensus-gate', 'off', '--model', 'claude-sonnet-4-6']);
  expect(status).toBe(1);
  expect(stderr).toContain('--task');
});

test('t3-run rejects invalid --consensus-gate value', () => {
  const envelope = makeFixture();
  const { stderr, status } = runHarness([
    '--task', envelope,
    '--seed', '1',
    '--consensus-gate', 'maybe',
    '--model', 'claude-sonnet-4-6',
  ]);
  expect(status).toBe(1);
  expect(stderr).toContain('--consensus-gate');
  rmSync(path.dirname(envelope), { recursive: true, force: true });
});

test('t3-run emits a schema-valid trajectory and exits 0 even when transport fails', () => {
  const envelope = makeFixture();
  const { stdout, status } = runHarness([
    '--task', envelope,
    '--seed', '42',
    '--consensus-gate', 'off',
    '--model', 'claude-sonnet-4-6',
  ]);
  expect(status).toBe(0);
  expect(stdout.length).toBeGreaterThan(0);
  const traj = JSON.parse(stdout);
  expect(traj.task_id).toMatch(/^t3-test-/);
  expect(traj.seed).toBe(42);
  expect(traj.runner_id).toContain('(off)');
  expect(traj.model).toBe('claude-sonnet-4-6');
  expect(Array.isArray(traj.turns)).toBe(true);
  expect(traj.turns.length).toBeGreaterThanOrEqual(2);
  expect(traj.turns[0].role).toBe('user');
  expect(traj.turns[1].role).toBe('assistant');
  expect(typeof traj.total_cost_usd).toBe('number');
  expect(typeof traj.terminate_reason).toBe('string');
  rmSync(path.dirname(envelope), { recursive: true, force: true });
}, 30_000);

test('t3-run honors --max-usd spend cap and aborts before orchestrator', () => {
  const envelope = makeFixture();
  const { stderr, status, stdout } = runHarness([
    '--task', envelope,
    '--seed', '1',
    '--consensus-gate', 'off',
    '--model', 'claude-opus-4-7',  // expensive
    '--max-usd', '0.01',           // unrealistic low
  ]);
  expect(status).toBe(1);
  expect(stdout).toBe('');
  expect(stderr).toContain('ABORT');
  expect(stderr).toContain('--max-usd');
  rmSync(path.dirname(envelope), { recursive: true, force: true });
});

test('t3-run with --consensus-gate on annotates judge_notes', () => {
  const envelope = makeFixture();
  const { stdout, status } = runHarness([
    '--task', envelope,
    '--seed', '7',
    '--consensus-gate', 'on',
    '--model', 'claude-sonnet-4-6',
  ]);
  expect(status).toBe(0);
  const traj = JSON.parse(stdout);
  expect(traj.runner_id).toContain('(on)');
  expect(typeof traj.judge_notes).toBe('string');
  expect(traj.judge_notes).toMatch(/consensus-gate=/);
  rmSync(path.dirname(envelope), { recursive: true, force: true });
}, 30_000);
