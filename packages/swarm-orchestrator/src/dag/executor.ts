/**
 * DAG execution engine
 *
 * Executes tasks in dependency order using streaming or wave-based modes.
 * Integrates CascadeManager for failure handling and ContextSharingManager
 * for passing context between dependent tasks.
 *
 * ECC-009: 5-layer Observer Loop Guard
 *   Layer 1 — Origin header propagation (swarmOrigin on task options)
 *   Layer 2 — Loop depth limit (maxLoopDepth, default 10)
 *   Layer 3 — Cyclic call detection (DFS at construction + runtime callStack)
 *   Layer 4 — Recursive chain timeout (loopTimeoutMs, default 30s)
 *   Layer 5 — Circuit breaker opens on LoopDetectedError
 */

import type { Task, TaskResult, SwarmConfig, LoopGuardConfig } from '../types.js';
import type { ExecutorTransport } from '../transport/types.js';
import type { ComputeDispatcher } from '../compute/dispatcher.js';
import type { CascadeManager } from '../cascade/manager.js';
import type { ContextSharingManager } from '../context/sharing.js';
import { join } from 'path';
import { storeSwarmTaskEval, storeToolReflection, classifyFailure } from 'zouroboros-selfheal';
import { getWorkspaceRoot } from 'zouroboros-core';

export type ExecutionMode = 'streaming' | 'waves';

export interface ExecutionContext {
  config: SwarmConfig;
  getExecutor: (executorId: string) => ExecutorTransport | undefined;
  resolveModel?: (task: Task, executorId: string) => string | undefined;
  computeDispatcher?: ComputeDispatcher;
  cascadeManager?: CascadeManager;
  contextManager?: ContextSharingManager;
  /** ECC-009 Layer 1: propagated origin identifier for nested swarm invocations */
  swarmOrigin?: string;
  /** ECC-009 Layer 2: current nesting depth (incremented by orchestrator on recursion) */
  loopDepth?: number;
}

export interface ExecutionProgress {
  totalTasks: number;
  completedTasks: number;
  failedTasks: number;
  inProgressTasks: number;
  percentComplete: number;
}

/** ECC-009: Thrown when a routing loop is detected. Opens the circuit breaker. */
export class LoopDetectedError extends Error {
  constructor(
    public readonly taskId: string,
    public readonly reason: 'cycle' | 'depth_exceeded' | 'timeout',
    public readonly details: string,
  ) {
    super(`Loop detected on task "${taskId}" [${reason}]: ${details}`);
    this.name = 'LoopDetectedError';
  }
}

const DEFAULT_LOOP_GUARD: LoopGuardConfig = {
  maxLoopDepth: 10,
  loopTimeoutMs: 30_000,
  openCircuitOnLoop: true,
};

export class DAGExecutor {
  private tasks: Map<string, Task>;
  private results: Map<string, TaskResult>;
  private inProgress: Set<string>;
  private context: ExecutionContext;
  /** ECC-009 Layer 3: runtime call stack for cycle detection */
  private callStack: Set<string>;
  /** ECC-009 Layer 4: timestamp when this execution started */
  private executionStartMs: number;
  private loopGuard: LoopGuardConfig;

  constructor(tasks: Task[], context: ExecutionContext) {
    this.tasks = new Map(tasks.map(t => [t.id, t]));
    this.results = new Map();
    this.inProgress = new Set();
    this.callStack = new Set();
    this.executionStartMs = Date.now();
    this.context = context;
    this.loopGuard = { ...DEFAULT_LOOP_GUARD, ...context.config.loopGuard };

    // ECC-009 Layer 3: static cycle detection via DFS before execution starts
    this.detectStaticCycles(tasks);

    // Build cascade dependency graph if manager is provided
    if (context.cascadeManager) {
      context.cascadeManager.buildDependencyGraph(tasks);
    }
  }

  /**
   * ECC-009 Layer 3 (static): Detect dependency cycles using DFS.
   * Throws LoopDetectedError immediately if a cycle is found in dependsOn.
   */
  private detectStaticCycles(tasks: Task[]): void {
    const visited = new Set<string>();
    const inStack = new Set<string>();

    const dfs = (taskId: string): void => {
      if (inStack.has(taskId)) {
        throw new LoopDetectedError(taskId, 'cycle', `Static cycle detected in dependsOn graph at task "${taskId}"`);
      }
      if (visited.has(taskId)) return;
      visited.add(taskId);
      inStack.add(taskId);
      const task = this.tasks.get(taskId);
      for (const dep of task?.dependsOn ?? []) {
        dfs(dep);
      }
      inStack.delete(taskId);
    };

    for (const taskId of this.tasks.keys()) {
      dfs(taskId);
    }
  }

  /**
   * ECC-009: Check all loop guard layers before dispatching a task.
   * Throws LoopDetectedError if any layer triggers.
   */
  private checkLoopGuard(taskId: string): void {
    // Layer 2: depth limit
    const currentDepth = this.context.loopDepth ?? 0;
    if (currentDepth >= this.loopGuard.maxLoopDepth) {
      throw new LoopDetectedError(
        taskId, 'depth_exceeded',
        `Execution depth ${currentDepth} reached maxLoopDepth ${this.loopGuard.maxLoopDepth} (origin: ${this.context.swarmOrigin ?? 'root'})`,
      );
    }

    // Layer 3: runtime cycle detection
    if (this.callStack.has(taskId)) {
      throw new LoopDetectedError(
        taskId, 'cycle',
        `Task "${taskId}" is already in the active call stack: [${[...this.callStack].join(' → ')} → ${taskId}]`,
      );
    }

    // Layer 4: recursive chain timeout
    const elapsed = Date.now() - this.executionStartMs;
    // The implicit 30s guard is for recursive/nested execution, not normal
    // dependency waits in a top-level DAG. Explicit operator deadlines still
    // apply at every depth; per-task deadlines and cycle checks remain active.
    const deadlineApplies = currentDepth > 0 || this.context.config.loopGuard?.loopTimeoutMs !== undefined;
    if (deadlineApplies && elapsed >= this.loopGuard.loopTimeoutMs) {
      throw new LoopDetectedError(
        taskId, 'timeout',
        `Recursive chain exceeded loopTimeoutMs (${elapsed}ms >= ${this.loopGuard.loopTimeoutMs}ms)`,
      );
    }
  }

  /**
   * ECC-009 Layer 5: Open the circuit breaker and log the loop incident.
   */
  private handleLoopDetected(taskId: string, err: LoopDetectedError): TaskResult {
    const task = this.tasks.get(taskId)!;
    console.error(`[ECC-009] LOOP INCIDENT — ${err.message}`);
    console.error(`[ECC-009] Origin: ${this.context.swarmOrigin ?? 'root'} | Depth: ${this.context.loopDepth ?? 0} | Call stack: [${[...this.callStack].join(' → ')}]`);

    if (this.loopGuard.openCircuitOnLoop && this.context.cascadeManager) {
      this.context.cascadeManager.handleFailure(taskId, err.message);
    }

    return {
      task,
      success: false,
      error: err.message,
      durationMs: Date.now() - this.executionStartMs,
      retries: 0,
    };
  }

  async execute(mode: ExecutionMode): Promise<TaskResult[]> {
    if (mode === 'streaming') {
      return this.executeStreaming();
    } else {
      return this.executeWaves();
    }
  }

  private async executeStreaming(): Promise<TaskResult[]> {
    const pending = new Set(this.tasks.keys());
    const promiseToTask = new Map<Promise<void>, string>();
    const maxConcurrency = this.context.config.localConcurrency;

    const tryExecuteTask = async (taskId: string): Promise<void> => {
      const task = this.tasks.get(taskId);
      if (!task) return;

      // Skip tasks that cascade manager has marked
      if (this.context.cascadeManager?.isSkipped(taskId)) {
        this.results.set(taskId, {
          task,
          success: false,
          error: 'Skipped due to upstream failure (cascade)',
          durationMs: 0,
          retries: 0,
        });
        pending.delete(taskId);
        return;
      }

      // Check dependencies
      const depsSatisfied = (task.dependsOn || []).every(depId =>
        this.results.has(depId) && this.results.get(depId)!.success
      );

      if (!depsSatisfied) return;
      if (this.results.has(taskId)) { pending.delete(taskId); return; }
      if (this.inProgress.has(taskId)) return;

      this.inProgress.add(taskId);
      pending.delete(taskId);

      // ECC-009: loop guard check before dispatch
      try {
        this.checkLoopGuard(taskId);
      } catch (err) {
        if (err instanceof LoopDetectedError) {
          this.inProgress.delete(taskId);
          this.results.set(taskId, this.handleLoopDetected(taskId, err));
          return;
        }
        throw err;
      }

      this.callStack.add(taskId);
      try {
        if (task.compute) {
          const result = this.context.computeDispatcher
            ? await this.context.computeDispatcher.dispatch(task)
            : {
                task,
                success: false,
                error: 'Compute task held: no compute dispatcher configured',
                durationMs: 0,
                retries: 0,
              };
          this.results.set(taskId, result);
          if (result.success) {
            this.context.contextManager?.recordTaskOutput(taskId, result.output || '', true, result.artifacts || []);
          } else {
            this.context.cascadeManager?.handleFailure(taskId, result.error || 'Compute task held');
          }
          return;
        }

        const primaryExecutorId = task.executor || 'claude-code';
        const executorChain = [primaryExecutorId, ...(task.fallbackExecutors || [])];
        let fallbacksAttempted = 0;
        let lastResult: TaskResult | null = null;

        // Build task context from dependencies if context manager is available
        let taskContext: Record<string, unknown> | undefined;
        if (this.context.contextManager) {
          taskContext = this.context.contextManager.buildTaskContext(taskId, task.dependsOn || []);
          if (taskContext && (task.dependsOn || []).length > 0) {
            // Fire-and-forget scorecard handoff log (bun:sqlite, non-fatal)
            try {
              const { Database } = await import('bun:sqlite');
              const sc = new Database(join(getWorkspaceRoot(), '.zo/memory/scorecard.db'));
              sc.run('PRAGMA journal_mode=WAL');
              sc.run(`CREATE TABLE IF NOT EXISTS swarm_handoffs (
                id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL,
                swarm_id TEXT, from_agent TEXT, to_agent TEXT,
                context_keys TEXT, context_size INTEGER NOT NULL DEFAULT 0, session_id TEXT
              )`);
              sc.run(
                'INSERT INTO swarm_handoffs (ts,swarm_id,from_agent,to_agent,context_keys,context_size) VALUES (?,?,?,?,?,?)',
                [Date.now(), this.context.swarmOrigin ?? 'root', (task.dependsOn || []).join(','), taskId, Object.keys(taskContext!).join(','), JSON.stringify(taskContext!).length]
              );
              sc.close();
            } catch { /* non-fatal */ }
          }
        }

        // ECC-009 Layer 1: propagate origin header on task dispatch
        const swarmOrigin = this.context.swarmOrigin ?? 'root';
        const timeoutMs = (task.timeoutSeconds || this.context.config.timeoutSeconds) * 1000;

        // Try primary executor, then fallbacks on failure
        for (let i = 0; i < executorChain.length; i++) {
          const currentExecutorId = executorChain[i];
          const executor = this.context.getExecutor(currentExecutorId);

          if (!executor) {
            if (i < executorChain.length - 1) {
              console.log(`  [FALLBACK] Executor "${currentExecutorId}" not found, trying next fallback...`);
              fallbacksAttempted++;
              continue;
            }
            this.results.set(taskId, {
              task, success: false,
              error: `No executor available (tried: ${executorChain.slice(0, i + 1).join(' → ')})`,
              durationMs: 0, retries: 0, fallbacksAttempted,
            });
            return;
          }

          if (i > 0) {
            console.log(`  [FALLBACK] Task "${taskId}": retrying with executor "${currentExecutorId}" (attempt ${i + 1}/${executorChain.length})`);
          }

          const resolvedModel = this.context.resolveModel?.(task, currentExecutorId) ?? task.model;
          const result = await executor.execute(task, {
            timeoutMs,
            ...(resolvedModel ? { env: { SWARM_RESOLVED_MODEL: resolvedModel } } : {}),
            ...(taskContext ? { context: taskContext } : {}),
            headers: { 'x-swarm-origin': swarmOrigin, 'x-swarm-depth': String(this.context.loopDepth ?? 0) },
          });

          result.effectiveExecutor = currentExecutorId;
          result.fallbacksAttempted = fallbacksAttempted;
          lastResult = result;

          if (result.success) {
            this.results.set(taskId, result);
            this.context.contextManager?.recordTaskOutput(
              taskId, result.output || '', true, result.artifacts || []
            );
            storeSwarmTaskEval({ toolName: taskId, outcome: 'success', durationMs: result.durationMs, persona: task.persona });
            return; // Success — exit the fallback chain
          }

          // Failed — exhaust cascade retries on same executor before moving to fallback
          if (this.context.cascadeManager) {
            this.context.cascadeManager.handleFailure(taskId, result.error || 'Unknown error');
            let retryCount = 0;
            while (true) {
              const { retry, backoffMs } = this.context.cascadeManager.shouldRetry(taskId);
              if (!retry) break;
              retryCount++;
              await new Promise(r => setTimeout(r, backoffMs));
              const retryResult = await executor.execute(task, {
                timeoutMs,
                ...(taskContext ? { context: taskContext } : {}),
                headers: { 'x-swarm-origin': swarmOrigin, 'x-swarm-depth': String(this.context.loopDepth ?? 0) },
              });
              retryResult.effectiveExecutor = currentExecutorId;
              retryResult.retries = retryCount;
              retryResult.fallbacksAttempted = fallbacksAttempted;

              if (retryResult.success) {
                this.results.set(taskId, retryResult);
                this.context.contextManager?.recordTaskOutput(
                  taskId, retryResult.output || '', true, retryResult.artifacts || []
                );
                storeSwarmTaskEval({ toolName: taskId, outcome: 'success', durationMs: retryResult.durationMs, persona: task.persona });
                return;
              }
              lastResult = retryResult;
              this.context.cascadeManager.handleFailure(taskId, retryResult.error || 'Unknown error');
            }
          }

          // Move to next fallback executor
          if (i < executorChain.length - 1) {
            fallbacksAttempted++;
            console.log(`  [FALLBACK] Executor "${currentExecutorId}" failed: ${result.error?.slice(0, 120)}`);
          }
        }

        // All executors exhausted
        if (lastResult) {
          lastResult.fallbacksAttempted = fallbacksAttempted;
          lastResult.error = `All executors failed (chain: ${executorChain.join(' → ')}). Last error: ${lastResult.error}`;
          this.results.set(taskId, lastResult);
          const errorMsg = lastResult.error || 'Unknown error';
          storeSwarmTaskEval({ toolName: taskId, outcome: 'failure', durationMs: lastResult.durationMs, errorType: classifyFailure(errorMsg), errorMessage: errorMsg, persona: task.persona });
          storeToolReflection(taskId, classifyFailure(errorMsg), `Task failed after ${fallbacksAttempted} fallback(s): ${errorMsg.slice(0, 200)}`, errorMsg.slice(0, 300));
        }

        if (this.context.config.notifyOnComplete !== 'none' && lastResult) {
          console.error(`Task ${taskId} failed after ${fallbacksAttempted} fallback(s): ${lastResult.error}`);
        }
      } finally {
        this.callStack.delete(taskId);
        this.inProgress.delete(taskId);
      }
    };

    // Main execution loop
    while (pending.size > 0 || promiseToTask.size > 0) {
      const availableSlots = maxConcurrency - promiseToTask.size;
      const readyTasks = Array.from(pending).filter(taskId => {
        const task = this.tasks.get(taskId);
        if (!task) return false;
        if (this.context.cascadeManager?.isSkipped(taskId)) return true;
        return (task.dependsOn || []).every(depId =>
          this.results.has(depId) && this.results.get(depId)!.success
        );
      }).slice(0, availableSlots);

      for (const taskId of readyTasks) {
        const promise = tryExecuteTask(taskId);
        promiseToTask.set(promise, taskId);
        promise.finally(() => promiseToTask.delete(promise));
      }

      if (promiseToTask.size > 0) {
        await Promise.race(promiseToTask.keys());
      } else if (pending.size > 0) {
        break;
      }
    }

    return Array.from(this.results.values());
  }

  private async executeWaves(): Promise<TaskResult[]> {
    const remaining = new Set(this.tasks.keys());
    let wave = 0;

    while (remaining.size > 0) {
      wave++;

      const readyTasks = Array.from(remaining).filter(taskId => {
        if (this.context.cascadeManager?.isSkipped(taskId)) return true;
        const task = this.tasks.get(taskId);
        if (!task) return false;
        return (task.dependsOn || []).every(depId =>
          this.results.has(depId) && this.results.get(depId)!.success
        );
      });

      if (readyTasks.length === 0) break;

      console.log(`Wave ${wave}: Executing ${readyTasks.length} tasks`);

      const chunks = this.chunkArray(readyTasks, this.context.config.localConcurrency);

      for (const chunk of chunks) {
        const promises = chunk.map(async (taskId) => {
          const task = this.tasks.get(taskId)!;
          remaining.delete(taskId);

          // Skip cascaded tasks
          if (this.context.cascadeManager?.isSkipped(taskId)) {
            this.results.set(taskId, {
              task, success: false,
              error: 'Skipped due to upstream failure (cascade)',
              durationMs: 0, retries: 0,
            });
            return;
          }

          // ECC-009: loop guard check before dispatch (waves mode)
          try {
            this.checkLoopGuard(taskId);
          } catch (err) {
            if (err instanceof LoopDetectedError) {
              this.results.set(taskId, this.handleLoopDetected(taskId, err));
              return;
            }
            throw err;
          }

          const primaryExecutorId = task.executor || 'claude-code';
          const executorChain = [primaryExecutorId, ...(task.fallbackExecutors || [])];
          let fallbacksAttempted = 0;

          // Build context from dependencies
          let taskContext: Record<string, unknown> | undefined;
          if (this.context.contextManager) {
            taskContext = this.context.contextManager.buildTaskContext(taskId, task.dependsOn || []);
          }

          const swarmOrigin = this.context.swarmOrigin ?? 'root';
          const timeoutMs = (task.timeoutSeconds || this.context.config.timeoutSeconds) * 1000;

          this.callStack.add(taskId);
          let finalResult: TaskResult | null = null;

          if (task.compute) {
            finalResult = this.context.computeDispatcher
              ? await this.context.computeDispatcher.dispatch(task)
              : {
                  task,
                  success: false,
                  error: 'Compute task held: no compute dispatcher configured',
                  durationMs: 0,
                  retries: 0,
                };
            this.callStack.delete(taskId);
            this.results.set(taskId, finalResult);
            if (!finalResult.success) {
              this.context.cascadeManager?.handleFailure(taskId, finalResult.error || 'Compute task held');
            }
            return;
          }

          for (let i = 0; i < executorChain.length; i++) {
            const currentExecutorId = executorChain[i];
            const executor = this.context.getExecutor(currentExecutorId);

            if (!executor) {
              if (i < executorChain.length - 1) {
                fallbacksAttempted++;
                continue;
              }
              finalResult = {
                task, success: false,
                error: `No executor available (tried: ${executorChain.slice(0, i + 1).join(' → ')})`,
                durationMs: 0, retries: 0, fallbacksAttempted,
              };
              break;
            }

            if (i > 0) {
              console.log(`  [FALLBACK/WAVE] Task "${taskId}": trying executor "${currentExecutorId}" (attempt ${i + 1})`);
            }

            const resolvedModel = this.context.resolveModel?.(task, currentExecutorId) ?? task.model;
            const result = await executor.execute(task, {
              timeoutMs,
              ...(resolvedModel ? { env: { SWARM_RESOLVED_MODEL: resolvedModel } } : {}),
              ...(taskContext ? { context: taskContext } : {}),
              headers: { 'x-swarm-origin': swarmOrigin, 'x-swarm-depth': String(this.context.loopDepth ?? 0) },
            });
            result.effectiveExecutor = currentExecutorId;
            result.fallbacksAttempted = fallbacksAttempted;

            if (result.success) {
              finalResult = result;
              this.context.contextManager?.recordTaskOutput(
                taskId, result.output || '', true
              );
              break;
            }

            // Try cascade retry on same executor before fallback
            if (this.context.cascadeManager) {
              this.context.cascadeManager.handleFailure(taskId, result.error || 'Unknown error');
            }

            if (i < executorChain.length - 1) {
              fallbacksAttempted++;
              console.log(`  [FALLBACK/WAVE] Executor "${currentExecutorId}" failed, trying next...`);
            } else {
              result.error = `All executors failed (chain: ${executorChain.join(' → ')}). Last: ${result.error}`;
              finalResult = result;
            }
          }

          this.callStack.delete(taskId);
          if (finalResult) {
            this.results.set(taskId, finalResult);
          }
        });

        await Promise.all(promises);
      }
    }

    // Mark remaining tasks as failed
    for (const taskId of remaining) {
      const task = this.tasks.get(taskId)!;
      this.results.set(taskId, {
        task, success: false,
        error: 'Dependencies not satisfied or circular dependency detected',
        durationMs: 0, retries: 0,
      });
    }

    return Array.from(this.results.values());
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size));
    }
    return chunks;
  }

  getProgress(): ExecutionProgress {
    const total = this.tasks.size;
    const completed = Array.from(this.results.values()).filter(r => r.success).length;
    const failed = Array.from(this.results.values()).filter(r => !r.success).length;

    return {
      totalTasks: total,
      completedTasks: completed,
      failedTasks: failed,
      inProgressTasks: this.inProgress.size,
      percentComplete: Math.round(((completed + failed) / total) * 100),
    };
  }
}
