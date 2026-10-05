import { describe, test, expect, beforeEach } from 'bun:test';
import { TokenOptimizer } from '../tokens/optimizer.js';
import type { ContextInjection } from '../tokens/optimizer.js';

describe('TokenOptimizer', () => {
  let optimizer: TokenOptimizer;

  beforeEach(() => {
    optimizer = new TokenOptimizer({
      defaultBudgetTokens: 10_000,
      contextReservePercent: 30,
      promptReservePercent: 50,
      strategyThresholds: { full: 0, facts_only: 40, summary: 60, minimal: 80, none: 90 },
      maxContextInjectionTokens: 3_000,
      enableProgressiveCompression: true,
    });
  });

  test('allocateBudget creates correct budget', () => {
    const budget = optimizer.allocateBudget('task-1');
    expect(budget.totalTokens).toBe(10_000);
    expect(budget.contextTokens).toBe(3_000); // 30%
    expect(budget.promptTokens).toBe(5_000);  // 50%
    expect(budget.reservedTokens).toBe(2_000); // remainder
    expect(budget.usedTokens).toBe(0);
    expect(budget.memoryStrategy).toBe('full');
  });

  test('allocateBudget with custom total', () => {
    const budget = optimizer.allocateBudget('task-1', 50_000);
    expect(budget.totalTokens).toBe(50_000);
  });

  test('recordUsage updates used tokens', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 2_000);
    expect(optimizer.getBudget('task-1')!.usedTokens).toBe(2_000);
  });

  test('progressive compression: full at low usage', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 1_000); // 10%
    expect(optimizer.getBudget('task-1')!.memoryStrategy).toBe('full');
  });

  test('progressive compression: facts_only at 40%', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 4_500); // 45%
    expect(optimizer.getBudget('task-1')!.memoryStrategy).toBe('facts_only');
  });

  test('progressive compression: summary at 60%', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 6_500); // 65%
    expect(optimizer.getBudget('task-1')!.memoryStrategy).toBe('summary');
  });

  test('progressive compression: minimal at 80%', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 8_500); // 85%
    expect(optimizer.getBudget('task-1')!.memoryStrategy).toBe('minimal');
  });

  test('progressive compression: none at 90%+', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 9_500); // 95%
    expect(optimizer.getBudget('task-1')!.memoryStrategy).toBe('none');
  });

  test('getUtilization returns percentage', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 5_000);
    expect(optimizer.getUtilization('task-1')).toBe(50);
  });

  test('getUtilization for unknown task returns 0', () => {
    expect(optimizer.getUtilization('unknown')).toBe(0);
  });

  test('planInjections: full strategy includes all tiers', () => {
    optimizer.allocateBudget('task-1');

    const injections: ContextInjection[] = [
      { tier: 'primary', content: 'facts', estimatedTokens: 500, source: 'facts.db' },
      { tier: 'secondary', content: 'episodes', estimatedTokens: 500, source: 'episodes.db' },
      { tier: 'background', content: 'graph', estimatedTokens: 500, source: 'graph.db' },
    ];

    const selected = optimizer.planInjections('task-1', injections);
    expect(selected).toHaveLength(3);
  });

  test('planInjections: minimal strategy only primary', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 8_500); // 85% → minimal

    const injections: ContextInjection[] = [
      { tier: 'primary', content: 'facts', estimatedTokens: 500, source: 'facts.db' },
      { tier: 'secondary', content: 'episodes', estimatedTokens: 500, source: 'episodes.db' },
      { tier: 'background', content: 'graph', estimatedTokens: 500, source: 'graph.db' },
    ];

    const selected = optimizer.planInjections('task-1', injections);
    expect(selected).toHaveLength(1);
    expect(selected[0].tier).toBe('primary');
  });

  test('planInjections: none strategy returns empty', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 9_500); // 95% → none

    const injections: ContextInjection[] = [
      { tier: 'primary', content: 'facts', estimatedTokens: 500, source: 'facts.db' },
    ];

    const selected = optimizer.planInjections('task-1', injections);
    expect(selected).toHaveLength(0);
  });

  test('planInjections respects token budget', () => {
    optimizer.allocateBudget('task-1');

    const injections: ContextInjection[] = [
      { tier: 'primary', content: 'a', estimatedTokens: 2_000, source: 'a' },
      { tier: 'primary', content: 'b', estimatedTokens: 2_000, source: 'b' },
    ];

    const selected = optimizer.planInjections('task-1', injections);
    expect(selected).toHaveLength(1); // only room for one (3000 budget)
  });

  test('planInjections prioritizes by tier', () => {
    optimizer.allocateBudget('task-1');

    const injections: ContextInjection[] = [
      { tier: 'background', content: 'bg', estimatedTokens: 2_500, source: 'bg' },
      { tier: 'primary', content: 'pri', estimatedTokens: 2_500, source: 'pri' },
    ];

    const selected = optimizer.planInjections('task-1', injections);
    expect(selected).toHaveLength(1);
    expect(selected[0].source).toBe('pri'); // primary first
  });

  test('generateReport captures state', () => {
    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 5_000);

    const injections: ContextInjection[] = [
      { tier: 'primary', content: 'facts', estimatedTokens: 500, source: 'facts.db' },
    ];
    optimizer.planInjections('task-1', injections);

    const report = optimizer.generateReport('task-1');
    expect(report.taskId).toBe('task-1');
    expect(report.budgetTokens).toBe(10_000);
    expect(report.usedTokens).toBe(5_000);
    expect(report.utilizationPercent).toBe(50);
    expect(report.injections).toHaveLength(1);
  });

  test('getHistory accumulates reports', () => {
    optimizer.allocateBudget('task-1');
    optimizer.generateReport('task-1');
    optimizer.allocateBudget('task-2');
    optimizer.generateReport('task-2');

    expect(optimizer.getHistory()).toHaveLength(2);
  });

  test('estimateTokens returns rough estimate', () => {
    const tokens = optimizer.estimateTokens('hello world');
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(20);
  });

  test('reset clears all budgets', () => {
    optimizer.allocateBudget('task-1');
    optimizer.reset();
    expect(optimizer.getBudget('task-1')).toBeUndefined();
  });

  test('disabled progressive compression keeps full strategy', () => {
    optimizer = new TokenOptimizer({
      defaultBudgetTokens: 10_000,
      enableProgressiveCompression: false,
    });

    optimizer.allocateBudget('task-1');
    optimizer.recordUsage('task-1', 9_500); // 95%
    expect(optimizer.getBudget('task-1')!.memoryStrategy).toBe('full');
  });
});
