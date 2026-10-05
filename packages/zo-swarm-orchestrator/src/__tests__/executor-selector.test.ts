import { describe, test, expect } from 'bun:test';
import { selectExecutor } from '../selector/executor-selector.js';
import type { Task, ExecutorRegistryEntry } from '../types.js';
import type { BudgetSnapshot, HealthSnapshot } from '../selector/executor-selector.js';
import { RoutingEngine } from '../routing/engine.js';
import { CircuitBreakerRegistry } from '../circuit/breaker.js';

const EXECUTORS: ExecutorRegistryEntry[] = [
  { id: 'claude-code', name: 'Claude Code', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 600 } },
  { id: 'gemini', name: 'Gemini CLI', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 300 } },
  { id: 'codex', name: 'Codex CLI', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 600 } },
  { id: 'hermes', name: 'Hermes Agent', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 300 } },
  { id: 'opencode', name: 'OpenCode CLI', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 600 } },
  { id: 'kimi', name: 'Kimi Code CLI', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 600 } },
  { id: 'pi', name: 'Pi Coding Agent', executor: 'local', description: '', expertise: [], bestFor: [], config: { defaultTimeout: 600 } },
];

const HEALTHY: HealthSnapshot = {
  'claude-code': { state: 'CLOSED', failures: 0 },
  'gemini': { state: 'CLOSED', failures: 0 },
  'codex': { state: 'CLOSED', failures: 0 },
  'hermes': { state: 'CLOSED', failures: 0 },
  'opencode': { state: 'CLOSED', failures: 0 },
  'kimi': { state: 'CLOSED', failures: 0 },
  'pi': { state: 'CLOSED', failures: 0 },
};

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'test-task',
    persona: 'test',
    task: 'Do something',
    priority: 'medium',
    ...overrides,
  };
}

describe('Executor Selector', () => {
  test('respects explicit executorId', () => {
    const result = selectExecutor(
      makeTask({ executor: 'codex' }),
      null, HEALTHY, EXECUTORS
    );
    expect(result.executorId).toBe('codex');
    expect(result.confidence).toBe(1.0);
  });

  test('routes reasoning tasks to claude-code', () => {
    const result = selectExecutor(
      makeTask({ task: 'Design the architecture and planning for the new system' }),
      null, HEALTHY, EXECUTORS
    );
    expect(result.executorId).toBe('claude-code');
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  test('routes UI tasks to gemini', () => {
    const result = selectExecutor(
      makeTask({ task: 'Build the frontend UI component with visual design' }),
      null, HEALTHY, EXECUTORS
    );
    expect(result.executorId).toBe('gemini');
  });

  test('routes backend tasks to codex', () => {
    const result = selectExecutor(
      makeTask({ task: 'Refactor the backend API database endpoint' }),
      null, HEALTHY, EXECUTORS
    );
    expect(result.executorId).toBe('codex');
  });

  test('routes research tasks to hermes', () => {
    const result = selectExecutor(
      makeTask({ task: 'Research web competitors and investigation analysis' }),
      null, HEALTHY, EXECUTORS
    );
    expect(result.executorId).toBe('hermes');
  });

  test('downgrades to cheapest when budget < 20%', () => {
    const budget: BudgetSnapshot = {
      totalSpentUSD: 9.0,
      totalBudgetUSD: 10.0,
      perExecutor: { 'claude-code': 9.0 },
    };
    const result = selectExecutor(
      makeTask({ task: 'Complex architecture planning' }),
      budget, HEALTHY, EXECUTORS
    );
    expect(['hermes', 'gemini']).toContain(result.executorId);
    expect(result.reasoning).toContain('downgrading');
  });

  test('falls back when primary circuit breaker is open', () => {
    const unhealthy: HealthSnapshot = {
      ...HEALTHY,
      'claude-code': { state: 'OPEN', failures: 5 },
    };
    const result = selectExecutor(
      makeTask({ task: 'Architecture planning and reasoning' }),
      null, unhealthy, EXECUTORS
    );
    expect(result.executorId).not.toBe('claude-code');
    expect(result.reasoning).toContain('circuit breaker OPEN');
  });

  test('uses role resolution when provided', () => {
    const result = selectExecutor(
      makeTask(),
      null, HEALTHY, EXECUTORS,
      { executorId: 'gemini', model: 'pro' }
    );
    expect(result.executorId).toBe('gemini');
    expect(result.model).toBe('pro');
    expect(result.confidence).toBe(0.9);
  });

  test('keeps a healthy role binding ahead of composite routing', () => {
    const engine = new RoutingEngine({
      strategy: 'balanced',
      useSixSignal: false,
      circuitBreakers: new CircuitBreakerRegistry(),
      executorCapabilities: EXECUTORS.map((executor) => ({
        id: executor.id,
        name: executor.name,
        expertise: executor.expertise,
        bestFor: executor.bestFor,
        isLocal: executor.executor === 'local',
      })),
    });
    const result = selectExecutor(
      makeTask({ task: 'Design the architecture and planning for the new system' }),
      null, HEALTHY, EXECUTORS,
      { executorId: 'gemini', model: 'mid' },
      engine,
    );
    expect(result.executorId).toBe('gemini');
    expect(result.reasoning).toContain('healthy role binding');
  });

  test('returns fallbacks array', () => {
    const result = selectExecutor(
      makeTask({ executor: 'claude-code' }),
      null, HEALTHY, EXECUTORS
    );
    expect(result.fallbacks.length).toBeGreaterThan(0);
    expect(result.fallbacks).not.toContain('claude-code');
  });

  test('auto mode triggers tag matching', () => {
    const result = selectExecutor(
      makeTask({ executor: 'auto', task: 'Deploy infrastructure and monitoring' }),
      null, HEALTHY, EXECUTORS
    );
    expect(result.executorId).toBeDefined();
    expect(result.confidence).toBeGreaterThan(0);
  });

  test('routes memory recall tasks to Hermes in legacy tag mode', () => {
    const result = selectExecutor(
      makeTask({ task: 'Recall institutional history from memory' }),
      null, HEALTHY, EXECUTORS,
    );
    expect(result.executorId).toBe('hermes');
  });

  test('provides resilient fallbacks for Kimi and Pi', () => {
    const kimi = selectExecutor(makeTask({ executor: 'kimi' }), null, HEALTHY, EXECUTORS);
    const pi = selectExecutor(makeTask({ executor: 'pi' }), null, HEALTHY, EXECUTORS);
    expect(kimi.fallbacks).toEqual(['pi', 'opencode', 'gemini', 'claude-code']);
    expect(pi.fallbacks).toEqual(['gemini', 'opencode', 'kimi', 'codex', 'claude-code']);
  });
});
