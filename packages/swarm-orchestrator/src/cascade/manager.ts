/**
 * Cascade Manager
 *
 * Improved failure propagation and recovery for DAG execution.
 * Handles: selective cascade (skip vs abort dependents), partial recovery,
 * retry with backoff, and cascade scope limiting.
 */

export type CascadePolicy = 'abort_dependents' | 'skip_dependents' | 'retry_then_skip' | 'isolate';
export type FailureImpact = 'critical' | 'degraded' | 'negligible';

export interface CascadeConfig {
  defaultPolicy: CascadePolicy;
  maxRetries: number;
  retryBackoffMs: number;
  retryBackoffMultiplier: number;
  maxCascadeDepth: number;
  policyOverrides: Map<string, CascadePolicy>;
  onCascade?: (event: CascadeEvent) => void;
}

export interface CascadeEvent {
  sourceTaskId: string;
  affectedTaskIds: string[];
  policy: CascadePolicy;
  impact: FailureImpact;
  timestamp: number;
  reason: string;
  retryCount: number;
}

export interface TaskDependencyInfo {
  taskId: string;
  dependsOn: string[];
  dependedOnBy: string[];
  depth: number;
  criticalPath: boolean;
}

interface RetryState {
  taskId: string;
  attempts: number;
  lastAttempt: number;
  nextBackoffMs: number;
}

const DEFAULT_CONFIG: CascadeConfig = {
  defaultPolicy: 'retry_then_skip',
  maxRetries: 2,
  retryBackoffMs: 1000,
  retryBackoffMultiplier: 2,
  maxCascadeDepth: 10,
  policyOverrides: new Map(),
};

export class CascadeManager {
  private config: CascadeConfig;
  private dependencyGraph: Map<string, TaskDependencyInfo>;
  private retryStates: Map<string, RetryState>;
  private cascadeEvents: CascadeEvent[];
  private skippedTasks: Set<string>;
  private failedTasks: Set<string>;

  constructor(config: Partial<CascadeConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.dependencyGraph = new Map();
    this.retryStates = new Map();
    this.cascadeEvents = [];
    this.skippedTasks = new Set();
    this.failedTasks = new Set();
  }

  buildDependencyGraph(tasks: Array<{ id: string; dependsOn?: string[] }>): void {
    this.dependencyGraph.clear();

    // Build forward and reverse dependency maps
    for (const task of tasks) {
      this.dependencyGraph.set(task.id, {
        taskId: task.id,
        dependsOn: task.dependsOn || [],
        dependedOnBy: [],
        depth: 0,
        criticalPath: false,
      });
    }

    // Populate reverse dependencies
    for (const task of tasks) {
      for (const depId of task.dependsOn || []) {
        const dep = this.dependencyGraph.get(depId);
        if (dep) {
          dep.dependedOnBy.push(task.id);
        }
      }
    }

    // Calculate depths
    this.calculateDepths();

    // Mark critical path (longest chain)
    this.markCriticalPath();
  }

  private calculateDepths(): void {
    const visited = new Set<string>();

    const visit = (taskId: string): number => {
      if (visited.has(taskId)) return this.dependencyGraph.get(taskId)?.depth || 0;
      visited.add(taskId);

      const info = this.dependencyGraph.get(taskId);
      if (!info) return 0;

      if (info.dependsOn.length === 0) {
        info.depth = 0;
        return 0;
      }

      info.depth = Math.max(...info.dependsOn.map(d => visit(d) + 1));
      return info.depth;
    };

    for (const taskId of this.dependencyGraph.keys()) {
      visit(taskId);
    }
  }

  private markCriticalPath(): void {
    let maxDepth = 0;
    let deepestTask = '';

    for (const [taskId, info] of this.dependencyGraph) {
      if (info.depth > maxDepth) {
        maxDepth = info.depth;
        deepestTask = taskId;
      }
    }

    // Trace back from deepest
    const markBack = (taskId: string): void => {
      const info = this.dependencyGraph.get(taskId);
      if (!info) return;
      info.criticalPath = true;

      for (const depId of info.dependsOn) {
        const depInfo = this.dependencyGraph.get(depId);
        if (depInfo && depInfo.depth === info.depth - 1) {
          markBack(depId);
          break; // only one critical path
        }
      }
    };

    if (deepestTask) markBack(deepestTask);
  }

  handleFailure(taskId: string, error: string): CascadeEvent {
    this.failedTasks.add(taskId);
    const info = this.dependencyGraph.get(taskId);
    const policy = this.config.policyOverrides.get(taskId) || this.config.defaultPolicy;

    const affected = this.getAffectedTasks(taskId);
    const impact = this.assessImpact(taskId, affected);

    const retryState = this.retryStates.get(taskId) || {
      taskId, attempts: 0, lastAttempt: 0, nextBackoffMs: this.config.retryBackoffMs,
    };

    const event: CascadeEvent = {
      sourceTaskId: taskId,
      affectedTaskIds: affected,
      policy,
      impact,
      timestamp: Date.now(),
      reason: error,
      retryCount: retryState.attempts,
    };

    this.cascadeEvents.push(event);

    // Apply policy
    switch (policy) {
      case 'abort_dependents':
        for (const id of affected) this.skippedTasks.add(id);
        break;

      case 'skip_dependents':
        for (const id of affected) this.skippedTasks.add(id);
        break;

      case 'retry_then_skip':
        // Don't skip dependents yet — let shouldRetry decide
        break;

      case 'isolate':
        // Only skip direct dependents, not transitive
        if (info) {
          for (const id of info.dependedOnBy) this.skippedTasks.add(id);
        }
        break;
    }

    if (this.config.onCascade) {
      this.config.onCascade(event);
    }

    return event;
  }

  shouldRetry(taskId: string): { retry: boolean; backoffMs: number } {
    const policy = this.config.policyOverrides.get(taskId) || this.config.defaultPolicy;

    if (policy !== 'retry_then_skip') {
      return { retry: false, backoffMs: 0 };
    }

    let state = this.retryStates.get(taskId);
    if (!state) {
      state = {
        taskId,
        attempts: 0,
        lastAttempt: 0,
        nextBackoffMs: this.config.retryBackoffMs,
      };
      this.retryStates.set(taskId, state);
    }

    if (state.attempts >= this.config.maxRetries) {
      // Exhausted retries — now skip dependents
      const affected = this.getAffectedTasks(taskId);
      for (const id of affected) this.skippedTasks.add(id);
      return { retry: false, backoffMs: 0 };
    }

    state.attempts++;
    state.lastAttempt = Date.now();
    const backoff = state.nextBackoffMs;
    state.nextBackoffMs = Math.min(
      state.nextBackoffMs * this.config.retryBackoffMultiplier,
      30_000 // 30s cap
    );

    return { retry: true, backoffMs: backoff };
  }

  isSkipped(taskId: string): boolean {
    return this.skippedTasks.has(taskId);
  }

  isFailed(taskId: string): boolean {
    return this.failedTasks.has(taskId);
  }

  getAffectedTasks(taskId: string, depth: number = 0): string[] {
    if (depth >= this.config.maxCascadeDepth) return [];

    const info = this.dependencyGraph.get(taskId);
    if (!info) return [];

    const affected: string[] = [];
    for (const depId of info.dependedOnBy) {
      affected.push(depId);
      affected.push(...this.getAffectedTasks(depId, depth + 1));
    }

    return [...new Set(affected)];
  }

  private assessImpact(taskId: string, affected: string[]): FailureImpact {
    const info = this.dependencyGraph.get(taskId);
    const totalTasks = this.dependencyGraph.size;
    const affectedPercent = (affected.length / totalTasks) * 100;

    if (info?.criticalPath || affectedPercent > 50) return 'critical';
    if (affectedPercent > 10) return 'degraded';
    return 'negligible';
  }

  getDependencyInfo(taskId: string): TaskDependencyInfo | undefined {
    return this.dependencyGraph.get(taskId);
  }

  getEvents(): CascadeEvent[] {
    return [...this.cascadeEvents];
  }

  getSkippedTasks(): string[] {
    return [...this.skippedTasks];
  }

  reset(): void {
    this.retryStates.clear();
    this.cascadeEvents = [];
    this.skippedTasks.clear();
    this.failedTasks.clear();
  }
}
