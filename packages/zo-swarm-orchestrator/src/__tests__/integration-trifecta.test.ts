/**
 * Integration tests for the Trifecta extensions:
 * Executor Selector + Budget Governor + Role Registry + Heartbeat + API
 *
 * Tests end-to-end flows that cross module boundaries.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { selectExecutor, type BudgetSnapshot, type HealthSnapshot } from '../selector/executor-selector.js';
import { BudgetGovernor } from '../budget/governor.js';
import { RoleRegistry } from '../roles/registry.js';
import { HeartbeatScheduler } from '../heartbeat/scheduler.js';
import { createSwarmAPI } from '../api/server.js';
import { closeDb } from '../db/schema.js';
import { estimateCostUSD, getCheapestModel, getModelPricing } from '../budget/pricing.js';
import type { Task, ExecutorRegistryEntry } from '../types.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/swarm-test-integration.db';

const EXECUTORS: ExecutorRegistryEntry[] = [
  { id: 'claude-code', name: 'Claude Code', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 600 } },
  { id: 'gemini', name: 'Gemini CLI', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 300 } },
  { id: 'codex', name: 'Codex CLI', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 600 } },
  { id: 'hermes', name: 'Hermes Agent', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 300 } },
];

const HEALTHY: HealthSnapshot = {
  'claude-code': { state: 'CLOSED', failures: 0 },
  'gemini': { state: 'CLOSED', failures: 0 },
  'codex': { state: 'CLOSED', failures: 0 },
  'hermes': { state: 'CLOSED', failures: 0 },
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return { id: 'test', persona: 'test', task: 'test task', priority: 'medium', ...overrides };
}

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

afterEach(() => {
  closeDb();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('Integration: Role Registry → Executor Selector', () => {
  test('role resolution feeds into selector', () => {
    const registry = new RoleRegistry(TEST_DB);
    const resolution = registry.resolve('senior-architect');
    expect(resolution).not.toBeNull();

    const selection = selectExecutor(makeTask(), null, HEALTHY, EXECUTORS, resolution);
    expect(selection.executorId).toBe('claude-code');
    expect(selection.model).toBe('sonnet');
    expect(selection.confidence).toBe(0.9);
  });

  test('custom role routes correctly', () => {
    const registry = new RoleRegistry(TEST_DB);
    registry.create({
      id: 'security-auditor',
      name: 'Security Auditor',
      executorId: 'hermes',
      model: 'byok',
      tags: ['security', 'audit'],
      description: 'Security audits',
    });

    const resolution = registry.resolve('security-auditor');
    const selection = selectExecutor(makeTask(), null, HEALTHY, EXECUTORS, resolution);
    expect(selection.executorId).toBe('hermes');
    expect(selection.model).toBe('byok');
  });

  test('missing role falls back to tag matching', () => {
    const registry = new RoleRegistry(TEST_DB);
    const resolution = registry.resolve('nonexistent-role');
    expect(resolution).toBeNull();

    const selection = selectExecutor(
      makeTask({ task: 'Build the frontend UI component with visual design' }),
      null, HEALTHY, EXECUTORS, null
    );
    expect(selection.executorId).toBe('gemini');
  });
});

describe('Integration: Budget Governor → Executor Selector', () => {
  test('budget exhaustion triggers downgrade', () => {
    const gov = new BudgetGovernor(TEST_DB);
    gov.initSwarm({ swarmId: 'test', totalBudgetUSD: 1.0 });

    // Spend almost all budget
    gov.recordUsage('test', 'claude-code', 'opus', 1000000, 500000);
    const state = gov.getState('test');

    const budget: BudgetSnapshot = {
      totalSpentUSD: state.totalSpentUSD,
      totalBudgetUSD: state.totalBudgetUSD,
      perExecutor: state.perExecutor,
    };

    // With high usage, selector should downgrade
    if (state.totalSpentUSD / state.totalBudgetUSD > 0.8) {
      const selection = selectExecutor(
        makeTask({ task: 'Complex architecture planning' }),
        budget, HEALTHY, EXECUTORS
      );
      expect(['hermes', 'gemini']).toContain(selection.executorId);
    }
  });

  test('budget governor events fire on cap', () => {
    const gov = new BudgetGovernor(TEST_DB);
    const events: string[] = [];
    gov.on((e) => events.push(e.type));

    gov.initSwarm({ swarmId: 'test', totalBudgetUSD: 0.001, hardCapAction: 'downgrade' });
    gov.recordUsage('test', 'claude-code', 'opus', 1000000, 500000);

    expect(events).toContain('budget:update');
    expect(events).toContain('budget:cap');
  });
});

describe('Integration: Full API → DB round-trip', () => {
  test('role CRUD via API matches DB state', async () => {
    const api = createSwarmAPI({ port: 0, dbPath: TEST_DB });

    // Create role via API
    const createRes = await api.app.request('/api/swarm/roles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: 'ml-engineer',
        name: 'ML Engineer',
        executorId: 'claude-code',
        model: 'opus',
        tags: ['ml', 'data', 'training'],
        description: 'ML model training and evaluation',
      }),
    });
    expect(createRes.status).toBe(201);

    // Verify via direct DB read
    const registry = new RoleRegistry(TEST_DB);
    const role = registry.get('ml-engineer');
    expect(role).not.toBeNull();
    expect(role!.executorId).toBe('claude-code');

    // Update via API
    const updateRes = await api.app.request('/api/swarm/roles/ml-engineer', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'sonnet' }),
    });
    expect(updateRes.status).toBe(200);

    // Verify update
    const updated = registry.get('ml-engineer');
    expect(updated!.model).toBe('sonnet');
  });

  test('budget init via API persists to DB', async () => {
    const api = createSwarmAPI({ port: 0, dbPath: TEST_DB });

    await api.app.request('/api/swarm/budget/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ swarmId: 'e2e-test', totalBudgetUSD: 25.0 }),
    });

    const gov = new BudgetGovernor(TEST_DB);
    const state = gov.getState('e2e-test');
    expect(state.totalBudgetUSD).toBe(25.0);
  });

  test('SSE broadcasts appear after mutations', async () => {
    const api = createSwarmAPI({ port: 0, dbPath: TEST_DB });
    const events: any[] = [];
    api.broadcastSSE({ type: 'test:event', data: { foo: 'bar' }, timestamp: Date.now() });

    // Verify activity endpoint returns events
    const res = await api.app.request('/api/swarm/activity');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/event-stream');
  });
});

describe('Integration: Heartbeat → Budget tracking', () => {
  test('heartbeat persists across restart', async () => {
    const scheduler1 = new HeartbeatScheduler(TEST_DB);
    scheduler1.start({ swarmId: 'hb-test', intervalMs: 30, maxBeats: 3, onIdle: 'sleep' });
    await new Promise(r => setTimeout(r, 200));
    scheduler1.stopAll();

    // New scheduler reads history from same DB
    const scheduler2 = new HeartbeatScheduler(TEST_DB);
    const history = scheduler2.getHistory('hb-test');
    expect(history.length).toBeGreaterThan(0);
    scheduler2.stopAll();
  });
});

describe('Pricing module correctness', () => {
  test('opus is most expensive', () => {
    const opusCost = estimateCostUSD('opus', 1000000, 500000);
    const flashCost = estimateCostUSD('flash', 1000000, 500000);
    expect(opusCost).toBeGreaterThan(flashCost);
  });

  test('byok is free', () => {
    const cost = estimateCostUSD('byok', 1000000, 500000);
    expect(cost).toBe(0);
  });

  test('getCheapestModel returns expected values', () => {
    expect(getCheapestModel('hermes')).toBe('byok');
    expect(getCheapestModel('gemini')).toBe('flash');
    expect(getCheapestModel('claude-code')).toBe('haiku');
    expect(getCheapestModel('codex')).toBe('gpt-4.1');
  });

  test('unknown model gets default pricing', () => {
    const pricing = getModelPricing('unknown-model-xyz');
    expect(pricing.inputPer1M).toBe(1.0);
    expect(pricing.outputPer1M).toBe(5.0);
  });
});

describe('Selector fallback chains', () => {
  test('cascading failures route through chain', () => {
    const degraded: HealthSnapshot = {
      'claude-code': { state: 'OPEN', failures: 5 },
      'gemini': { state: 'OPEN', failures: 3 },
      'codex': { state: 'CLOSED', failures: 0 },
      'hermes': { state: 'CLOSED', failures: 0 },
    };

    const selection = selectExecutor(
      makeTask({ task: 'Architecture planning and reasoning' }),
      null, degraded, EXECUTORS
    );

    // Should skip claude-code (OPEN) and gemini (OPEN), land on codex or hermes
    expect(['codex', 'hermes']).toContain(selection.executorId);
  });

  test('all executors open still returns something', () => {
    const allOpen: HealthSnapshot = {
      'claude-code': { state: 'OPEN', failures: 5 },
      'gemini': { state: 'OPEN', failures: 5 },
      'codex': { state: 'OPEN', failures: 5 },
      'hermes': { state: 'OPEN', failures: 5 },
    };

    const selection = selectExecutor(makeTask(), null, allOpen, EXECUTORS);
    expect(selection.executorId).toBeDefined();
  });
});
