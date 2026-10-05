/**
 * Composite routing engine with 8-signal scoring
 *
 * Routes tasks to executors based on capability, health, complexity fit,
 * history, procedure knowledge, temporal context, budget pressure, and role affinity.
 */

import type { Task, ExecutorCapability, RouteDecision, RoutingStrategy, ComplexityTier } from '../types.js';
import { CircuitBreakerRegistry } from '../circuit/breaker.js';
import type { BudgetSnapshot } from '../types.js';

const STRATEGY_WEIGHTS_6SIGNAL = {
  fast: { capability: 0.12, health: 0.20, complexityFit: 0.40, history: 0.12, procedure: 0.08, temporal: 0.08 },
  reliable: { capability: 0.15, health: 0.35, complexityFit: 0.12, history: 0.18, procedure: 0.12, temporal: 0.08 },
  balanced: { capability: 0.25, health: 0.28, complexityFit: 0.16, history: 0.15, procedure: 0.10, temporal: 0.06 },
  explore: { capability: 0.35, health: 0.16, complexityFit: 0.18, history: 0.16, procedure: 0.10, temporal: 0.05 },
};

const STRATEGY_WEIGHTS_8SIGNAL = {
  fast: { capability: 0.10, health: 0.18, complexityFit: 0.35, history: 0.10, procedure: 0.07, temporal: 0.06, budget: 0.08, role: 0.06 },
  reliable: { capability: 0.13, health: 0.30, complexityFit: 0.10, history: 0.15, procedure: 0.10, temporal: 0.07, budget: 0.08, role: 0.07 },
  balanced: { capability: 0.20, health: 0.22, complexityFit: 0.14, history: 0.12, procedure: 0.08, temporal: 0.05, budget: 0.10, role: 0.09 },
  explore: { capability: 0.30, health: 0.13, complexityFit: 0.15, history: 0.13, procedure: 0.08, temporal: 0.04, budget: 0.08, role: 0.09 },
};

const COST_RANKING = ['hermes', 'opencode', 'gemini', 'codex', 'claude-code'];

const COMPLEXITY_AFFINITY: Record<string, Record<string, number>> = {
  codex: { trivial: 0.90, simple: 0.85, moderate: 0.55, complex: 0.30 },
  gemini: { trivial: 0.75, simple: 0.80, moderate: 0.90, complex: 0.85 },
  hermes: { trivial: 0.70, simple: 0.75, moderate: 0.85, complex: 0.80 },
  opencode: { trivial: 0.85, simple: 0.90, moderate: 0.90, complex: 0.85 },
  kimi: { trivial: 0.70, simple: 0.80, moderate: 0.90, complex: 0.95 },
  pi: { trivial: 0.95, simple: 0.90, moderate: 0.75, complex: 0.55 },
  'claude-code': { trivial: 0.65, simple: 0.75, moderate: 0.90, complex: 1.00 },
};

export interface RoutingContext {
  strategy: RoutingStrategy;
  useSixSignal: boolean;
  circuitBreakers: CircuitBreakerRegistry;
  executorCapabilities: ExecutorCapability[];
  signals?: {
    history(executor: string, task: Task): number;
    procedure(executor: string, task: Task): number;
  };
}

export interface RouteOptions {
  budget?: BudgetSnapshot | null;
  roleExecutorId?: string | null;
}

export class RoutingEngine {
  private context: RoutingContext;

  constructor(context: RoutingContext) {
    this.context = context;
  }

  route(task: Task, complexityTier: ComplexityTier, options?: RouteOptions): RouteDecision {
    const candidates = this.context.executorCapabilities;
    const use8Signal = options?.budget || options?.roleExecutorId;

    let bestDecision: RouteDecision | null = null;
    let bestScore = -1;

    for (const executor of candidates) {
      const score = use8Signal
        ? this.compute8SignalScore(executor, task, complexityTier, options!)
        : this.computeCompositeScore(executor, task, complexityTier);

      if (score.compositeScore > bestScore) {
        bestScore = score.compositeScore;
        bestDecision = {
          executorId: executor.id,
          executorName: executor.name,
          compositeScore: score.compositeScore,
          breakdown: score.breakdown,
          method: 'composite',
        };
      }
    }

    return bestDecision || this.getFallbackDecision();
  }

  private compute8SignalScore(
    executor: ExecutorCapability,
    task: Task,
    complexityTier: ComplexityTier,
    options: RouteOptions,
  ): { compositeScore: number; breakdown: RouteDecision['breakdown'] } {
    const weights = STRATEGY_WEIGHTS_8SIGNAL[this.context.strategy];
    const cb = this.context.circuitBreakers.get(executor.id);

    const capabilityScore = this.computeCapabilityScore(executor, task);
    const cbState = cb.getState();
    const healthScore = cbState.state === 'CLOSED' ? 1.0 :
                       cbState.state === 'HALF_OPEN' ? 0.5 : 0.0;
    const complexityFit = COMPLEXITY_AFFINITY[executor.id]?.[complexityTier] ?? 0.5;
    const historyScore = this.context.signals?.history(executor.id, task) ?? this.computeHistoryScore(cbState);
    const procedureScore = this.context.signals?.procedure(executor.id, task) ?? 0.5;
    const temporalScore = this.computeTemporalScore(cbState.lastSuccess);

    const budgetScore = this.computeBudgetScore(executor.id, options.budget);
    const roleScore = this.computeRoleScore(executor.id, options.roleExecutorId);

    const compositeScore =
      capabilityScore * weights.capability +
      healthScore * weights.health +
      complexityFit * weights.complexityFit +
      historyScore * weights.history +
      procedureScore * weights.procedure +
      temporalScore * weights.temporal +
      budgetScore * weights.budget +
      roleScore * weights.role;

    return {
      compositeScore,
      breakdown: {
        capability: capabilityScore,
        health: healthScore,
        complexityFit,
        history: historyScore,
        procedure: procedureScore,
        temporal: temporalScore,
        budget: budgetScore,
        role: roleScore,
      },
    };
  }

  private computeBudgetScore(executorId: string, budget?: BudgetSnapshot | null): number {
    if (!budget || budget.totalBudgetUSD <= 0) return 0.5;

    const remaining = budget.totalBudgetUSD - budget.totalSpentUSD;
    const remainingPct = remaining / budget.totalBudgetUSD;

    const costRank = COST_RANKING.indexOf(executorId);
    if (costRank === -1) return 0.5;

    const costFactor = (costRank + 1) / COST_RANKING.length;

    if (remainingPct < 0.1) return costFactor;
    if (remainingPct < 0.2) return 0.3 + costFactor * 0.5;
    if (remainingPct < 0.5) return 0.5 + costFactor * 0.2;
    return 0.7;
  }

  private computeRoleScore(executorId: string, roleExecutorId?: string | null): number {
    if (!roleExecutorId) return 0.5;
    if (executorId === roleExecutorId) return 1.0;
    return 0.3;
  }

  private computeCompositeScore(
    executor: ExecutorCapability,
    task: Task,
    complexityTier: ComplexityTier
  ): { compositeScore: number; breakdown: RouteDecision['breakdown'] } {
    const weights = STRATEGY_WEIGHTS_6SIGNAL[this.context.strategy];
    const cb = this.context.circuitBreakers.get(executor.id);

    const capabilityScore = this.computeCapabilityScore(executor, task);
    const cbState = cb.getState();
    const healthScore = cbState.state === 'CLOSED' ? 1.0 :
                       cbState.state === 'HALF_OPEN' ? 0.5 : 0.0;
    const complexityFit = COMPLEXITY_AFFINITY[executor.id]?.[complexityTier] ?? 0.5;
    const historyScore = this.context.signals?.history(executor.id, task) ?? this.computeHistoryScore(cbState);
    const procedureScore = this.context.signals?.procedure(executor.id, task) ?? 0.5;
    const temporalScore = this.computeTemporalScore(cbState.lastSuccess);

    const compositeScore =
      capabilityScore * weights.capability +
      healthScore * weights.health +
      complexityFit * weights.complexityFit +
      historyScore * weights.history +
      procedureScore * weights.procedure +
      temporalScore * weights.temporal;

    return {
      compositeScore,
      breakdown: {
        capability: capabilityScore,
        health: healthScore,
        complexityFit,
        history: historyScore,
        procedure: procedureScore,
        temporal: temporalScore,
      },
    };
  }

  private computeCapabilityScore(executor: ExecutorCapability, task: Task): number {
    const taskLower = task.task.toLowerCase();
    let matchCount = 0;

    for (const expertise of executor.expertise) {
      if (taskLower.includes(expertise.toLowerCase())) {
        matchCount++;
      }
    }

    return Math.min(1, matchCount / 3);
  }

  private computeHistoryScore(state: ReturnType<ReturnType<CircuitBreakerRegistry['get']>['getState']>): number {
    const successes = state.totalSuccesses ?? 0;
    const attempts = successes + state.totalFailures;
    return attempts === 0 ? 0.5 : successes / attempts;
  }

  private computeTemporalScore(lastSuccess: number, now = Date.now()): number {
    if (lastSuccess <= 0) return 0.5;
    const ageMs = Math.max(0, now - lastSuccess);
    return 0.5 + 0.5 * Math.exp(-ageMs / (6 * 60 * 60 * 1000));
  }

  private getFallbackDecision(): RouteDecision {
    return {
      executorId: 'claude-code',
      executorName: 'Claude Code',
      compositeScore: 0.5,
      breakdown: {
        capability: 0.5,
        health: 0.5,
        complexityFit: 0.5,
        history: 0.5,
        procedure: 0.5,
        temporal: 0.5,
      },
      method: 'fallback',
    };
  }
}
