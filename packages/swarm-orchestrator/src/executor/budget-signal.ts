/**
 * Budget Signal — maintains an executor-visible budget file in the campaign workspace.
 *
 * Requirements:
 * - Records attempt budget, elapsed, remaining, tier ceiling.
 * - Updated at least at 50%, 70% and 90% of budget.
 * - Allows an executor that monitors it to checkpoint its deliverables before ceiling.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BudgetSignal {
  attemptBudgetSeconds: number;
  elapsedSeconds: number;
  remainingSeconds: number;
  tierCeilingSeconds: number;
  percentElapsed: number;
  milestone?: 'init' | '50%' | '70%' | '90%' | 'ceiling' | 'tick';
  updatedAt: string;
}

export interface BudgetSignalOptions {
  workspaceDir: string;
  attemptBudgetSeconds: number;
  tierCeilingSeconds?: number;
  intervalMs?: number;
  clock?: () => number;
  onUpdate?: (signal: BudgetSignal) => void;
}

export const BUDGET_FILE_NAME = 'BUDGET.json';
export const SWARM_BUDGET_FILE_NAME = 'budget.json';

/**
 * Write budget signal atomically to workspace root and .swarm/ subdirectory.
 */
export function writeBudgetSignal(workspaceDir: string, signal: BudgetSignal): void {
  if (!existsSync(workspaceDir)) return;

  const content = JSON.stringify(signal, null, 2);

  // 1. Root workspace BUDGET.json (easily found by executor via ls/read)
  try {
    writeFileSync(join(workspaceDir, BUDGET_FILE_NAME), content, 'utf-8');
  } catch {
    // Non-fatal if permission issues
  }

  // 2. .swarm/budget.json
  try {
    const swarmDir = join(workspaceDir, '.swarm');
    if (!existsSync(swarmDir)) {
      mkdirSync(swarmDir, { recursive: true });
    }
    writeFileSync(join(swarmDir, SWARM_BUDGET_FILE_NAME), content, 'utf-8');
  } catch {
    // Non-fatal
  }
}

/**
 * Read the current budget signal from the workspace if present.
 */
export function readBudgetSignal(workspaceDir: string): BudgetSignal | null {
  const rootPath = join(workspaceDir, BUDGET_FILE_NAME);
  if (existsSync(rootPath)) {
    try {
      return JSON.parse(readFileSync(rootPath, 'utf-8')) as BudgetSignal;
    } catch {
      // Fall through to .swarm/
    }
  }

  const swarmPath = join(workspaceDir, '.swarm', SWARM_BUDGET_FILE_NAME);
  if (existsSync(swarmPath)) {
    try {
      return JSON.parse(readFileSync(swarmPath, 'utf-8')) as BudgetSignal;
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Active monitor that maintains and updates the budget signal file.
 * Guarantees updates at start ('init'), at 50%, 70%, 90% milestones, and periodic intervals.
 */
export class BudgetSignalMonitor {
  private workspaceDir: string;
  private attemptBudgetSeconds: number;
  private tierCeilingSeconds: number;
  private intervalMs: number;
  private clock: () => number;
  private onUpdate?: (signal: BudgetSignal) => void;

  private startTime: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private milestonesFired = new Set<number>();
  private lastSignal: BudgetSignal | null = null;

  constructor(options: BudgetSignalOptions) {
    this.workspaceDir = options.workspaceDir;
    this.attemptBudgetSeconds = options.attemptBudgetSeconds > 0 ? options.attemptBudgetSeconds : 2700;
    this.tierCeilingSeconds = options.tierCeilingSeconds ?? this.attemptBudgetSeconds;
    this.intervalMs = options.intervalMs ?? 5000;
    this.clock = options.clock ?? (() => Date.now());
    this.onUpdate = options.onUpdate;
    this.startTime = this.clock();
  }

  /**
   * Start the budget monitor and write the initial budget file.
   */
  start(): BudgetSignal {
    this.startTime = this.clock();
    this.milestonesFired.clear();

    const signal: BudgetSignal = {
      attemptBudgetSeconds: this.attemptBudgetSeconds,
      elapsedSeconds: 0,
      remainingSeconds: this.attemptBudgetSeconds,
      tierCeilingSeconds: this.tierCeilingSeconds,
      percentElapsed: 0,
      milestone: 'init',
      updatedAt: new Date(this.startTime).toISOString(),
    };

    writeBudgetSignal(this.workspaceDir, signal);
    this.lastSignal = signal;
    this.onUpdate?.(signal);

    if (this.intervalMs > 0) {
      this.timer = setInterval(() => {
        this.tick();
      }, this.intervalMs);
    }

    return signal;
  }

  /**
   * Perform a tick evaluation and write an update if milestone reached or periodic tick.
   */
  tick(currentNow?: number): BudgetSignal {
    const now = currentNow ?? this.clock();
    const elapsedSeconds = Math.max(0, (now - this.startTime) / 1000);
    const remainingSeconds = Math.max(0, this.attemptBudgetSeconds - elapsedSeconds);
    const rawPercent = (elapsedSeconds / this.attemptBudgetSeconds) * 100;
    const percentElapsed = Math.min(100, Math.round(rawPercent));

    let milestone: BudgetSignal['milestone'] = 'tick';

    // Check milestones 50, 70, 90
    for (const m of [50, 70, 90] as const) {
      if (rawPercent >= m && !this.milestonesFired.has(m)) {
        this.milestonesFired.add(m);
        milestone = `${m}%`;
      }
    }

    if (rawPercent >= 100 && !this.milestonesFired.has(100)) {
      this.milestonesFired.add(100);
      milestone = 'ceiling';
    }

    const signal: BudgetSignal = {
      attemptBudgetSeconds: this.attemptBudgetSeconds,
      elapsedSeconds: Math.round(elapsedSeconds * 10) / 10,
      remainingSeconds: Math.round(remainingSeconds * 10) / 10,
      tierCeilingSeconds: this.tierCeilingSeconds,
      percentElapsed,
      milestone,
      updatedAt: new Date(now).toISOString(),
    };

    writeBudgetSignal(this.workspaceDir, signal);
    this.lastSignal = signal;
    this.onUpdate?.(signal);

    return signal;
  }

  /**
   * Stop the monitor and clear any interval timers.
   */
  stop(currentNow?: number): BudgetSignal | null {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.lastSignal) {
      return this.tick(currentNow);
    }
    return null;
  }

  getLastSignal(): BudgetSignal | null {
    return this.lastSignal;
  }

  getMilestonesFired(): number[] {
    return Array.from(this.milestonesFired).sort((a, b) => a - b);
  }
}
