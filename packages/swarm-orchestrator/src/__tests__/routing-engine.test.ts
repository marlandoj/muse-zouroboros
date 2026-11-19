import { describe, expect, test } from 'bun:test';
import { CircuitBreakerRegistry } from '../circuit/breaker.js';
import { RoutingEngine } from '../routing/engine.js';
import type { ExecutorCapability, Task } from '../types.js';

const task: Task = { id: 'routing-test', persona: 'auto', task: 'Analyze this implementation', priority: 'medium' };
const executor: ExecutorCapability = {
  id: 'codex', name: 'Codex', expertise: ['analysis'], bestFor: ['analysis'], isLocal: true,
};

function engine(circuitBreakers = new CircuitBreakerRegistry()): RoutingEngine {
  return new RoutingEngine({
    strategy: 'balanced', useSixSignal: false, circuitBreakers, executorCapabilities: [executor],
  });
}

describe('routing engine signals', () => {
  test('uses measured success history instead of a fixed score', () => {
    const circuitBreakers = new CircuitBreakerRegistry();
    const breaker = circuitBreakers.get('codex');
    breaker.recordFailure('unknown');
    breaker.recordFailure('unknown');
    const decision = engine(circuitBreakers).route(task, 'moderate', { budget: { totalBudgetUSD: 10, totalSpentUSD: 1, perExecutor: {} } });
    expect(decision.breakdown.history).toBe(0);
  });

  test('scores a recent successful harness above the never-used baseline', () => {
    const circuitBreakers = new CircuitBreakerRegistry();
    const breaker = circuitBreakers.get('codex');
    breaker.recordSuccess();
    const decision = engine(circuitBreakers).route(task, 'moderate', { budget: { totalBudgetUSD: 10, totalSpentUSD: 1, perExecutor: {} } });
    expect(decision.breakdown.history).toBe(1);
    expect(decision.breakdown.temporal).toBeGreaterThan(0.99);
  });
});
