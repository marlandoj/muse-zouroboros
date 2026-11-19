/**
 * Cross-Task Context Sharing
 *
 * Passes memory and context between dependent tasks in a DAG.
 * Supports: output forwarding, shared memory slots, artifact passing,
 * and scoped context with TTL.
 */

export type ContextScope = 'task' | 'wave' | 'campaign';
export type ArtifactType = 'file' | 'json' | 'text' | 'memory_ref';

export interface SharedContext {
  key: string;
  value: unknown;
  sourceTaskId: string;
  scope: ContextScope;
  createdAt: number;
  expiresAt: number | null;
  artifactType: ArtifactType;
  metadata?: Record<string, string>;
}

export interface ContextSharingConfig {
  maxContextSizeBytes: number;
  defaultTtlMs: number;
  enableOutputForwarding: boolean;
  maxOutputForwardBytes: number;
  scopeIsolation: boolean;
}

export interface TaskOutputSummary {
  taskId: string;
  output: string;
  success: boolean;
  artifacts: string[];
  timestamp: number;
}

const DEFAULT_CONFIG: ContextSharingConfig = {
  maxContextSizeBytes: 512 * 1024, // 512KB per context entry
  defaultTtlMs: 30 * 60 * 1000,   // 30 min
  enableOutputForwarding: true,
  maxOutputForwardBytes: 64 * 1024, // 64KB forwarded output
  scopeIsolation: true,
};

export class ContextSharingManager {
  private config: ContextSharingConfig;
  private store: Map<string, SharedContext>;
  private taskOutputs: Map<string, TaskOutputSummary>;
  private subscriptions: Map<string, Set<string>>; // taskId -> keys it subscribes to

  constructor(config: Partial<ContextSharingConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.store = new Map();
    this.taskOutputs = new Map();
    this.subscriptions = new Map();
  }

  publish(
    key: string,
    value: unknown,
    sourceTaskId: string,
    options: {
      scope?: ContextScope;
      ttlMs?: number;
      artifactType?: ArtifactType;
      metadata?: Record<string, string>;
    } = {}
  ): boolean {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > this.config.maxContextSizeBytes) {
      return false;
    }

    const context: SharedContext = {
      key,
      value,
      sourceTaskId,
      scope: options.scope || 'campaign',
      createdAt: Date.now(),
      expiresAt: options.ttlMs ? Date.now() + options.ttlMs : Date.now() + this.config.defaultTtlMs,
      artifactType: options.artifactType || 'json',
      metadata: options.metadata,
    };

    this.store.set(key, context);
    return true;
  }

  get(key: string): unknown | undefined {
    const ctx = this.store.get(key);
    if (!ctx) return undefined;

    if (ctx.expiresAt && Date.now() > ctx.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return ctx.value;
  }

  getContext(key: string): SharedContext | undefined {
    const ctx = this.store.get(key);
    if (!ctx) return undefined;

    if (ctx.expiresAt && Date.now() > ctx.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return ctx;
  }

  recordTaskOutput(taskId: string, output: string, success: boolean, artifacts: string[] = []): void {
    let truncatedOutput = output;
    if (this.config.enableOutputForwarding) {
      if (Buffer.byteLength(output) > this.config.maxOutputForwardBytes) {
        truncatedOutput = output.slice(0, this.config.maxOutputForwardBytes) + '\n[truncated]';
      }
    }

    this.taskOutputs.set(taskId, {
      taskId,
      output: truncatedOutput,
      success,
      artifacts,
      timestamp: Date.now(),
    });

    // Auto-publish as context
    if (this.config.enableOutputForwarding && success) {
      this.publish(`task_output:${taskId}`, truncatedOutput, taskId, {
        scope: 'campaign',
        artifactType: 'text',
      });
    }
  }

  getTaskOutput(taskId: string): TaskOutputSummary | undefined {
    return this.taskOutputs.get(taskId);
  }

  subscribe(taskId: string, contextKeys: string[]): void {
    this.subscriptions.set(taskId, new Set(contextKeys));
  }

  getSubscribedContext(taskId: string): Map<string, unknown> {
    const keys = this.subscriptions.get(taskId);
    if (!keys) return new Map();

    const result = new Map<string, unknown>();
    for (const key of keys) {
      const value = this.get(key);
      if (value !== undefined) {
        result.set(key, value);
      }
    }
    return result;
  }

  buildTaskContext(taskId: string, dependsOn: string[]): Record<string, unknown> {
    const context: Record<string, unknown> = {};

    // Include outputs from dependencies
    for (const depId of dependsOn) {
      const output = this.taskOutputs.get(depId);
      if (output && output.success) {
        context[`dep:${depId}:output`] = output.output;
        context[`dep:${depId}:artifacts`] = output.artifacts;
      }
    }

    // Include subscribed context
    const subscribed = this.getSubscribedContext(taskId);
    for (const [key, value] of subscribed) {
      context[key] = value;
    }

    return context;
  }

  getByScope(scope: ContextScope): SharedContext[] {
    const results: SharedContext[] = [];
    const now = Date.now();

    for (const ctx of this.store.values()) {
      if (ctx.scope === scope && (!ctx.expiresAt || now <= ctx.expiresAt)) {
        results.push(ctx);
      }
    }

    return results;
  }

  getBySource(sourceTaskId: string): SharedContext[] {
    const results: SharedContext[] = [];
    for (const ctx of this.store.values()) {
      if (ctx.sourceTaskId === sourceTaskId) {
        results.push(ctx);
      }
    }
    return results;
  }

  cleanup(): number {
    const now = Date.now();
    let removed = 0;

    for (const [key, ctx] of this.store) {
      if (ctx.expiresAt && now > ctx.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }

    return removed;
  }

  clear(): void {
    this.store.clear();
    this.taskOutputs.clear();
    this.subscriptions.clear();
  }

  getStats(): { contextEntries: number; taskOutputs: number; subscriptions: number; totalSizeBytes: number } {
    let totalSize = 0;
    for (const ctx of this.store.values()) {
      totalSize += Buffer.byteLength(JSON.stringify(ctx.value));
    }

    return {
      contextEntries: this.store.size,
      taskOutputs: this.taskOutputs.size,
      subscriptions: this.subscriptions.size,
      totalSizeBytes: totalSize,
    };
  }
}
