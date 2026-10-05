import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { BudgetGovernor } from '../budget/governor.js';
import { vendorOf, getModelPricing } from '../budget/pricing.js';
import { closeDb, getDb } from '../db/schema.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/swarm-test-budget.db';

let gov: BudgetGovernor;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  gov = new BudgetGovernor(TEST_DB);
});

afterEach(() => {
  closeDb();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('Budget Governor', () => {
  test('initializes swarm budget', () => {
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 10.0 });
    const state = gov.getState('s1');
    expect(state.totalBudgetUSD).toBe(10.0);
    expect(state.totalSpentUSD).toBe(0);
    expect(state.remaining).toBe(10.0);
    expect(state.hardCapAction).toBe('downgrade');
  });

  test('records usage and updates state', () => {
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 10.0 });
    gov.recordUsage('s1', 'claude-code', 'opus', 1000, 500);
    const state = gov.getState('s1');
    expect(state.totalSpentUSD).toBeGreaterThan(0);
    expect(state.perExecutor['claude-code']).toBeGreaterThan(0);
    expect(state.remaining).toBeLessThan(10.0);
  });

  test('accumulates usage across calls', () => {
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 100.0 });
    gov.recordUsage('s1', 'claude-code', 'opus', 1000000, 500000);
    const state1 = gov.getState('s1');
    gov.recordUsage('s1', 'claude-code', 'opus', 1000000, 500000);
    const state2 = gov.getState('s1');
    expect(state2.totalSpentUSD).toBeGreaterThan(state1.totalSpentUSD);
  });

  test('tracks per-executor costs separately', () => {
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 100.0 });
    gov.recordUsage('s1', 'claude-code', 'opus', 100000, 50000);
    gov.recordUsage('s1', 'gemini', 'flash', 100000, 50000);
    const state = gov.getState('s1');
    expect(Object.keys(state.perExecutor)).toContain('claude-code');
    expect(Object.keys(state.perExecutor)).toContain('gemini');
    expect(state.perExecutor['claude-code']).toBeGreaterThan(state.perExecutor['gemini']);
  });

  test('fires alert at threshold', () => {
    const events: string[] = [];
    gov.on((e) => events.push(e.type));
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 1.0, alertThresholdPct: 50 });
    gov.recordUsage('s1', 'claude-code', 'opus', 500000, 100000);
    expect(events).toContain('budget:update');
  });

  test('detects cap reached', () => {
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 0.001 });
    gov.recordUsage('s1', 'claude-code', 'opus', 1000000, 500000);
    const state = gov.getState('s1');
    expect(state.capReached).toBe(true);
  });

  test('checks per-executor limits', () => {
    gov.initSwarm({
      swarmId: 's1',
      totalBudgetUSD: 100.0,
      perExecutorLimits: { 'claude-code': 0.001 },
    });
    expect(gov.checkExecutorLimit('s1', 'claude-code')).toBe(true);
    gov.recordUsage('s1', 'claude-code', 'opus', 1000000, 500000);
    expect(gov.checkExecutorLimit('s1', 'claude-code')).toBe(false);
  });

  test('getDowngradeTarget returns cheap option', () => {
    const target = gov.getDowngradeTarget('claude-code');
    expect(target.executorId).toBe('gemini');
    expect(target.model).toBe('haiku');

    const hermesTarget = gov.getDowngradeTarget('hermes');
    expect(hermesTarget.executorId).toBe('hermes');
    expect(hermesTarget.model).toBe('byok');
  });

  test('handles missing swarm gracefully', () => {
    const state = gov.getState('nonexistent');
    expect(state.totalSpentUSD).toBe(0);
    expect(state.totalBudgetUSD).toBe(0);
  });
});

interface LedgerRow {
  source: string;
  run_id: string;
  label: string;
  model: string;
  vendor: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  rate_source: string;
  estimated: number;
}

describe('Cost ledger (per-call)', () => {
  test('writes one ledger row per recordUsage call', () => {
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 10.0 });
    gov.recordUsage('s1', 'claude-code', 'sonnet', 700, 300, { label: 'task-1', estimated: false });
    gov.recordUsage('s1', 'claude-code', 'sonnet', 1400, 600);

    const rows = getDb(TEST_DB)
      .query('SELECT * FROM cost_ledger ORDER BY id')
      .all() as LedgerRow[];

    expect(rows.length).toBe(2);
    expect(rows[0].source).toBe('swarm');
    expect(rows[0].run_id).toBe('s1');
    expect(rows[0].label).toBe('task-1');
    expect(rows[0].vendor).toBe('anthropic');
    expect(rows[0].rate_source).toBe('swarm-pricing');
    expect(rows[0].estimated).toBe(0);
    expect(rows[0].cost_usd).toBeCloseTo((700 * 2.0 + 300 * 10.0) / 1e6, 10);

    // defaults: label falls back to executorId, estimated defaults to 1
    expect(rows[1].label).toBe('claude-code');
    expect(rows[1].estimated).toBe(1);
    expect(rows[1].input_tokens).toBe(1400);
    expect(rows[1].output_tokens).toBe(600);
  });

  test('ledger rows do not accumulate like swarm_budget', () => {
    gov.initSwarm({ swarmId: 's1', totalBudgetUSD: 100.0 });
    gov.recordUsage('s1', 'claude-code', 'opus', 1000, 500);
    gov.recordUsage('s1', 'claude-code', 'opus', 1000, 500);

    const budget = getDb(TEST_DB)
      .query("SELECT COUNT(*) cnt FROM swarm_budget WHERE swarm_id = 's1'")
      .get() as { cnt: number };
    const ledger = getDb(TEST_DB)
      .query("SELECT COUNT(*) cnt FROM cost_ledger")
      .get() as { cnt: number };

    expect(budget.cnt).toBe(1);
    expect(ledger.cnt).toBe(2);
  });

  test('vendorOf maps swarm model aliases', () => {
    expect(vendorOf('opus')).toBe('anthropic');
    expect(vendorOf('claude-sonnet-4-6')).toBe('anthropic');
    expect(vendorOf('flash')).toBe('google');
    expect(vendorOf('gemini-2.5-pro')).toBe('google');
    expect(vendorOf('gpt-5.x')).toBe('openai');
    expect(vendorOf('o3')).toBe('openai');
    expect(vendorOf('byok')).toBe('byok');
    expect(vendorOf('mystery-model')).toBe('unknown');
  });
});


test('Gemini promotional pricing changes at the published UTC boundary', () => {
  expect(getModelPricing('gemini-3.8-flash', new Date('2026-12-31T23:59:59.999Z')))
    .toEqual({ inputPer1M: 0.75, outputPer1M: 3.75 });
  expect(getModelPricing('gemini-3.8-flash', new Date('2027-01-01T00:00:00Z')))
    .toEqual({ inputPer1M: 1.50, outputPer1M: 7.50 });
  expect(getModelPricing('gemini-3.5-flash-lite', new Date('2027-01-01T00:00:00Z')))
    .toEqual({ inputPer1M: 0.30, outputPer1M: 2.50 });
  expect(getModelPricing('claude-haiku-4-5')).toEqual({ inputPer1M: 1, outputPer1M: 5 });
});
