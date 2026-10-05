/**
 * Budget Governor — per-executor and per-swarm cost tracking with hard caps.
 *
 * Tracks token usage, normalizes to USD, emits alerts, and enforces caps.
 * Hard cap action: "downgrade" switches remaining tasks to cheapest executor.
 */

import { getDb } from '../db/schema.js';
import { estimateCostUSD, getCheapestModel, vendorOf } from './pricing.js';
import type { Database } from 'bun:sqlite';

export type HardCapAction = 'pause' | 'abort' | 'downgrade';

export interface BudgetConfig {
  swarmId: string;
  totalBudgetUSD: number;
  perExecutorLimits?: Record<string, number>;
  alertThresholdPct?: number;
  hardCapAction?: HardCapAction;
}

export interface BudgetState {
  swarmId: string;
  totalSpentUSD: number;
  totalBudgetUSD: number;
  remaining: number;
  perExecutor: Record<string, number>;
  alertFired: boolean;
  capReached: boolean;
  hardCapAction: HardCapAction;
}

export interface BudgetEvent {
  type: 'budget:update' | 'budget:alert' | 'budget:cap' | 'budget:downgrade';
  swarmId: string;
  data: Record<string, unknown>;
  timestamp: number;
}

export interface UsageMeta {
  runId?: string;
  label?: string;
  /** false only when tokens are vendor-reported; swarm token splits default to estimated */
  estimated?: boolean;
}

type BudgetListener = (event: BudgetEvent) => void;

export class BudgetGovernor {
  private db: Database;
  private listeners: BudgetListener[] = [];

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
  }

  on(listener: BudgetListener): void {
    this.listeners.push(listener);
  }

  private emit(event: BudgetEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  initSwarm(config: BudgetConfig): void {
    this.db.run(
      `INSERT OR REPLACE INTO budget_config (swarm_id, total_budget_usd, alert_threshold_pct, hard_cap_action)
       VALUES (?, ?, ?, ?)`,
      [config.swarmId, config.totalBudgetUSD, config.alertThresholdPct ?? 80, config.hardCapAction ?? 'downgrade']
    );

    if (config.perExecutorLimits) {
      const stmt = this.db.prepare(
        'INSERT OR REPLACE INTO budget_per_executor (swarm_id, executor_id, limit_usd) VALUES (?, ?, ?)'
      );
      for (const [execId, limit] of Object.entries(config.perExecutorLimits)) {
        stmt.run(config.swarmId, execId, limit);
      }
    }
  }

  recordUsage(
    swarmId: string,
    executorId: string,
    model: string,
    inputTokens: number,
    outputTokens: number,
    meta?: UsageMeta,
  ): BudgetState {
    const cost = estimateCostUSD(model, inputTokens, outputTokens);
    const totalTokens = inputTokens + outputTokens;

    this.db.run(
      `INSERT INTO swarm_budget (swarm_id, executor_id, tokens_used, cost_usd, updated_at)
       VALUES (?, ?, ?, ?, unixepoch())
       ON CONFLICT(swarm_id, executor_id) DO UPDATE SET
         tokens_used = tokens_used + excluded.tokens_used,
         cost_usd = cost_usd + excluded.cost_usd,
         updated_at = unixepoch()`,
      [swarmId, executorId, totalTokens, cost]
    );

    // Per-call ledger row for the cost dashboard. Fail-safe: a ledger write
    // failure must never block budget enforcement.
    try {
      this.db.run(
        `INSERT INTO cost_ledger
         (ts, source, run_id, label, model, vendor, input_tokens, output_tokens, cost_usd, rate_source, estimated)
         VALUES (?, 'swarm', ?, ?, ?, ?, ?, ?, ?, 'swarm-pricing', ?)`,
        [
          Date.now(),
          meta?.runId ?? swarmId,
          meta?.label ?? executorId,
          model,
          vendorOf(model),
          Math.round(inputTokens),
          Math.round(outputTokens),
          cost,
          meta?.estimated === false ? 0 : 1,
        ]
      );
    } catch {}

    const state = this.getState(swarmId);

    this.emit({
      type: 'budget:update',
      swarmId,
      data: { executorId, cost, totalSpent: state.totalSpentUSD },
      timestamp: Date.now(),
    });

    // Check alert threshold
    const config = this.getConfig(swarmId);
    if (config) {
      const pct = (state.totalSpentUSD / config.total_budget_usd) * 100;
      if (pct >= config.alert_threshold_pct && !state.alertFired) {
        this.emit({
          type: 'budget:alert',
          swarmId,
          data: { percentUsed: pct, spent: state.totalSpentUSD, budget: config.total_budget_usd },
          timestamp: Date.now(),
        });
      }
      if (state.totalSpentUSD >= config.total_budget_usd) {
        this.emit({
          type: 'budget:cap',
          swarmId,
          data: { action: config.hard_cap_action, spent: state.totalSpentUSD },
          timestamp: Date.now(),
        });
      }
    }

    return state;
  }

  getState(swarmId: string): BudgetState {
    const config = this.getConfig(swarmId);
    const totalBudget = config?.total_budget_usd ?? 0;
    const hardCapAction = (config?.hard_cap_action ?? 'downgrade') as HardCapAction;
    const alertThreshold = config?.alert_threshold_pct ?? 80;

    const rows = this.db.query(
      'SELECT executor_id, cost_usd FROM swarm_budget WHERE swarm_id = ?'
    ).all(swarmId) as Array<{ executor_id: string; cost_usd: number }>;

    const perExecutor: Record<string, number> = {};
    let totalSpent = 0;
    for (const row of rows) {
      perExecutor[row.executor_id] = row.cost_usd;
      totalSpent += row.cost_usd;
    }

    const pct = totalBudget > 0 ? (totalSpent / totalBudget) * 100 : 0;

    return {
      swarmId,
      totalSpentUSD: totalSpent,
      totalBudgetUSD: totalBudget,
      remaining: Math.max(0, totalBudget - totalSpent),
      perExecutor,
      alertFired: pct >= alertThreshold,
      capReached: totalBudget > 0 && totalSpent >= totalBudget,
      hardCapAction,
    };
  }

  checkExecutorLimit(swarmId: string, executorId: string): boolean {
    const limit = this.db.query(
      'SELECT limit_usd FROM budget_per_executor WHERE swarm_id = ? AND executor_id = ?'
    ).get(swarmId, executorId) as { limit_usd: number } | null;

    if (!limit) return true;

    const usage = this.db.query(
      'SELECT cost_usd FROM swarm_budget WHERE swarm_id = ? AND executor_id = ?'
    ).get(swarmId, executorId) as { cost_usd: number } | null;

    return (usage?.cost_usd ?? 0) < limit.limit_usd;
  }

  getDowngradeTarget(executorId: string): { executorId: string; model: string } {
    const cheapestModel = getCheapestModel(executorId);
    const cheapestExecutor = executorId === 'hermes' ? 'hermes' : 'gemini';
    return { executorId: cheapestExecutor, model: cheapestModel };
  }

  private getConfig(swarmId: string) {
    return this.db.query(
      'SELECT * FROM budget_config WHERE swarm_id = ?'
    ).get(swarmId) as { total_budget_usd: number; alert_threshold_pct: number; hard_cap_action: string } | null;
  }
}
