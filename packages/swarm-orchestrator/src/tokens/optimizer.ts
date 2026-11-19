/**
 * Token Optimizer
 *
 * Hierarchical memory strategies per-task for optimal context usage.
 * Manages token budgets, selects injection strategies, and tracks consumption.
 */

export type MemoryStrategy = 'full' | 'facts_only' | 'summary' | 'minimal' | 'none';
export type InjectionTier = 'primary' | 'secondary' | 'background';

export interface TokenBudget {
  taskId: string;
  totalTokens: number;
  promptTokens: number;
  contextTokens: number;
  reservedTokens: number;
  usedTokens: number;
  memoryStrategy: MemoryStrategy;
}

export interface TokenOptimizerConfig {
  defaultBudgetTokens: number;
  contextReservePercent: number;
  promptReservePercent: number;
  strategyThresholds: Record<MemoryStrategy, number>;
  maxContextInjectionTokens: number;
  enableProgressiveCompression: boolean;
}

export interface ContextInjection {
  tier: InjectionTier;
  content: string;
  estimatedTokens: number;
  source: string;
}

export interface TokenUsageReport {
  taskId: string;
  budgetTokens: number;
  usedTokens: number;
  utilizationPercent: number;
  memoryStrategy: MemoryStrategy;
  injections: Array<{ source: string; tokens: number; tier: InjectionTier }>;
  compressed: boolean;
}

const DEFAULT_CONFIG: TokenOptimizerConfig = {
  defaultBudgetTokens: 128_000,
  contextReservePercent: 30,
  promptReservePercent: 50,
  strategyThresholds: {
    full: 0,           // 0-40% used → full context
    facts_only: 40,    // 40-60% → facts only
    summary: 60,       // 60-80% → summaries
    minimal: 80,       // 80-90% → minimal
    none: 90,          // 90%+ → no memory injection
  },
  maxContextInjectionTokens: 32_000,
  enableProgressiveCompression: true,
};

export class TokenOptimizer {
  private config: TokenOptimizerConfig;
  private budgets: Map<string, TokenBudget>;
  private injections: Map<string, ContextInjection[]>;
  private usageHistory: TokenUsageReport[];

  constructor(config: Partial<TokenOptimizerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.budgets = new Map();
    this.injections = new Map();
    this.usageHistory = [];
  }

  allocateBudget(taskId: string, totalTokens?: number): TokenBudget {
    const total = totalTokens || this.config.defaultBudgetTokens;
    const contextTokens = Math.floor(total * (this.config.contextReservePercent / 100));
    const promptTokens = Math.floor(total * (this.config.promptReservePercent / 100));
    const reservedTokens = total - contextTokens - promptTokens;

    const budget: TokenBudget = {
      taskId,
      totalTokens: total,
      promptTokens,
      contextTokens,
      reservedTokens,
      usedTokens: 0,
      memoryStrategy: 'full',
    };

    this.budgets.set(taskId, budget);
    return budget;
  }

  recordUsage(taskId: string, tokensUsed: number): void {
    const budget = this.budgets.get(taskId);
    if (!budget) return;

    budget.usedTokens += tokensUsed;

    // Update strategy based on utilization
    if (this.config.enableProgressiveCompression) {
      budget.memoryStrategy = this.selectStrategy(budget);
    }
  }

  selectStrategy(budget: TokenBudget): MemoryStrategy {
    const utilization = (budget.usedTokens / budget.totalTokens) * 100;

    if (utilization >= this.config.strategyThresholds.none) return 'none';
    if (utilization >= this.config.strategyThresholds.minimal) return 'minimal';
    if (utilization >= this.config.strategyThresholds.summary) return 'summary';
    if (utilization >= this.config.strategyThresholds.facts_only) return 'facts_only';
    return 'full';
  }

  planInjections(taskId: string, available: ContextInjection[]): ContextInjection[] {
    const budget = this.budgets.get(taskId);
    if (!budget) return [];

    const strategy = budget.memoryStrategy;
    const maxTokens = Math.min(budget.contextTokens, this.config.maxContextInjectionTokens);

    // Filter by strategy
    let filtered = available;
    switch (strategy) {
      case 'none':
        return [];
      case 'minimal':
        filtered = available.filter(i => i.tier === 'primary');
        break;
      case 'summary':
        filtered = available.filter(i => i.tier === 'primary' || i.tier === 'secondary');
        break;
      case 'facts_only':
        filtered = available.filter(i => i.tier !== 'background');
        break;
      case 'full':
        break;
    }

    // Sort by tier priority
    const tierOrder: Record<InjectionTier, number> = { primary: 0, secondary: 1, background: 2 };
    filtered.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);

    // Fit within budget
    const selected: ContextInjection[] = [];
    let usedTokens = 0;

    for (const injection of filtered) {
      if (usedTokens + injection.estimatedTokens <= maxTokens) {
        selected.push(injection);
        usedTokens += injection.estimatedTokens;
      }
    }

    this.injections.set(taskId, selected);
    return selected;
  }

  getBudget(taskId: string): TokenBudget | undefined {
    return this.budgets.get(taskId);
  }

  getUtilization(taskId: string): number {
    const budget = this.budgets.get(taskId);
    if (!budget) return 0;
    return (budget.usedTokens / budget.totalTokens) * 100;
  }

  generateReport(taskId: string): TokenUsageReport {
    const budget = this.budgets.get(taskId);
    const injected = this.injections.get(taskId) || [];

    const report: TokenUsageReport = {
      taskId,
      budgetTokens: budget?.totalTokens || 0,
      usedTokens: budget?.usedTokens || 0,
      utilizationPercent: budget ? (budget.usedTokens / budget.totalTokens) * 100 : 0,
      memoryStrategy: budget?.memoryStrategy || 'none',
      injections: injected.map(i => ({
        source: i.source,
        tokens: i.estimatedTokens,
        tier: i.tier,
      })),
      compressed: budget?.memoryStrategy !== 'full',
    };

    this.usageHistory.push(report);
    return report;
  }

  getHistory(): TokenUsageReport[] {
    return [...this.usageHistory];
  }

  estimateTokens(text: string): number {
    // ~4 chars per token for English text
    return Math.ceil(text.length / 4);
  }

  reset(): void {
    this.budgets.clear();
    this.injections.clear();
  }
}
