/**
 * Integration tests: DAGExecutor ↔ CascadeManager ↔ ContextSharingManager
 *
 * Tests that the DAG executor correctly wires cascade failure propagation
 * and cross-task context sharing.
 */

import { describe, it, expect, beforeEach, spyOn } from 'bun:test';
import { DAGExecutor, LoopDetectedError, type ExecutionContext } from '../dag/executor.js';
import { CascadeManager } from '../cascade/manager.js';
import { ContextSharingManager } from '../context/sharing.js';
import type { Task, TaskResult, SwarmConfig } from '../types.js';

const BASE_CONFIG: SwarmConfig = {
  localConcurrency: 4,
  timeoutSeconds: 30,
  maxRetries: 2,
  enableMemory: false,
  dagMode: 'streaming',
  notifyOnComplete: 'none',
  routingStrategy: 'fast',
  useSixSignalRouting: false,
  stagnationEnabled: false,
};

function makeTask(id: string, dependsOn: string[] = []): Task {
  return { id, persona: 'test', task: `Do ${id}`, priority: 'medium', dependsOn };
}

type ExecutorFn = (task: Task, opts: any) => Promise<TaskResult>;

function buildContext(
  executorFn: ExecutorFn,
  cascade?: CascadeManager,
  context?: ContextSharingManager
): ExecutionContext {
  const executor = { execute: executorFn };
  return {
    config: BASE_CONFIG,
    getExecutor: () => executor as any,
    cascadeManager: cascade,
    contextManager: context,
  };
}

describe('DAGExecutor ↔ CascadeManager', () => {
  describe('abort_dependents policy', () => {
    it('skips downstream tasks when upstream fails', async () => {
      const callLog: string[] = [];
      const cascade = new CascadeManager({ defaultPolicy: 'abort_dependents', maxRetries: 0 });

      const tasks = [
        makeTask('root'),
        makeTask('child', ['root']),
        makeTask('grandchild', ['child']),
      ];

      const executorFn: ExecutorFn = async (task) => {
        callLog.push(task.id);
        if (task.id === 'root') {
          return { task, success: false, error: 'Root failed', durationMs: 10, retries: 0 };
        }
        return { task, success: true, output: 'ok', durationMs: 10, retries: 0 };
      };

      const ctx = buildContext(executorFn, cascade);
      const dag = new DAGExecutor(tasks, ctx);
      const results = await dag.execute('streaming');

      // Only root was actually executed
      expect(callLog).toEqual(['root']);

      // Child and grandchild were cascade-skipped
      const childResult = results.find(r => r.task.id === 'child');
      const grandchildResult = results.find(r => r.task.id === 'grandchild');
      expect(childResult?.success).toBe(false);
      expect(childResult?.error).toContain('cascade');
      expect(grandchildResult?.success).toBe(false);
      expect(grandchildResult?.error).toContain('cascade');
    });
  });

  describe('retry_then_skip policy', () => {
    it('retries failed task then skips dependents on exhaustion', async () => {
      let rootAttempts = 0;
      const cascade = new CascadeManager({
        defaultPolicy: 'retry_then_skip',
        maxRetries: 2,
        retryBackoffMs: 1,
        retryBackoffMultiplier: 1,
      });

      const tasks = [
        makeTask('flaky'),
        makeTask('dependent', ['flaky']),
      ];

      const executorFn: ExecutorFn = async (task) => {
        if (task.id === 'flaky') {
          rootAttempts++;
          return { task, success: false, error: `Attempt ${rootAttempts}`, durationMs: 5, retries: 0 };
        }
        return { task, success: true, output: 'ok', durationMs: 5, retries: 0 };
      };

      const ctx = buildContext(executorFn, cascade);
      const dag = new DAGExecutor(tasks, ctx);
      const results = await dag.execute('streaming');

      // 1 initial + 2 retries = 3 total attempts
      expect(rootAttempts).toBe(3);

      // Dependent was skipped after retries exhausted
      const depResult = results.find(r => r.task.id === 'dependent');
      expect(depResult?.success).toBe(false);
      expect(depResult?.error).toContain('cascade');
    });
  });

  describe('wave mode', () => {
    it('skips cascaded tasks in subsequent waves', async () => {
      const callLog: string[] = [];
      const cascade = new CascadeManager({ defaultPolicy: 'abort_dependents', maxRetries: 0 });

      const tasks = [
        makeTask('wave1-a'),
        makeTask('wave1-b'),
        makeTask('wave2-c', ['wave1-a']),
        makeTask('wave2-d', ['wave1-b']),
      ];

      const executorFn: ExecutorFn = async (task) => {
        callLog.push(task.id);
        if (task.id === 'wave1-a') {
          return { task, success: false, error: 'Failed', durationMs: 5, retries: 0 };
        }
        return { task, success: true, output: 'ok', durationMs: 5, retries: 0 };
      };

      const ctx = buildContext(executorFn, cascade);
      const dag = new DAGExecutor(tasks, ctx);
      const results = await dag.execute('waves');

      // wave1-a and wave1-b executed in wave 1; wave2-d in wave 2
      expect(callLog).toContain('wave1-a');
      expect(callLog).toContain('wave1-b');
      expect(callLog).toContain('wave2-d');
      // wave2-c was cascade-skipped (depends on failed wave1-a)
      expect(callLog).not.toContain('wave2-c');

      const cResult = results.find(r => r.task.id === 'wave2-c');
      expect(cResult?.success).toBe(false);
      expect(cResult?.error).toContain('cascade');
    });
  });
});

describe('DAGExecutor ↔ ContextSharingManager', () => {
  describe('output forwarding', () => {
    it('passes producer output to consumer via context', async () => {
      let consumerContext: Record<string, unknown> | undefined;
      const ctxManager = new ContextSharingManager();

      const tasks = [
        makeTask('producer'),
        makeTask('consumer', ['producer']),
      ];

      const executorFn: ExecutorFn = async (task, opts) => {
        if (task.id === 'consumer') {
          consumerContext = opts.context;
        }
        return {
          task,
          success: true,
          output: task.id === 'producer' ? 'produced-data-123' : 'consumed',
          durationMs: 5,
          retries: 0,
        };
      };

      const ctx = buildContext(executorFn, undefined, ctxManager);
      const dag = new DAGExecutor(tasks, ctx);
      await dag.execute('streaming');

      // Consumer received producer's output keyed by dep ID
      expect(consumerContext).toBeDefined();
      expect(consumerContext!['dep:producer:output']).toBe('produced-data-123');
    });
  });

  describe('multi-dependency context', () => {
    it('builds context from all upstream dependencies', async () => {
      let finalContext: Record<string, unknown> | undefined;
      const ctxManager = new ContextSharingManager();

      const tasks = [
        makeTask('dep1'),
        makeTask('dep2'),
        makeTask('aggregator', ['dep1', 'dep2']),
      ];

      const executorFn: ExecutorFn = async (task, opts) => {
        if (task.id === 'aggregator') {
          finalContext = opts.context;
        }
        return {
          task,
          success: true,
          output: `output-from-${task.id}`,
          durationMs: 5,
          retries: 0,
        };
      };

      const ctx = buildContext(executorFn, undefined, ctxManager);
      const dag = new DAGExecutor(tasks, ctx);
      await dag.execute('streaming');

      expect(finalContext).toBeDefined();
      expect(finalContext!['dep:dep1:output']).toBe('output-from-dep1');
      expect(finalContext!['dep:dep2:output']).toBe('output-from-dep2');
    });
  });

  describe('cascade + context combined', () => {
    it('successful branch gets context while failed branch cascades', async () => {
      const callLog: string[] = [];
      let successConsumerCtx: Record<string, unknown> | undefined;
      const cascade = new CascadeManager({ defaultPolicy: 'abort_dependents', maxRetries: 0 });
      const ctxManager = new ContextSharingManager();

      const tasks = [
        makeTask('good-root'),
        makeTask('bad-root'),
        makeTask('good-child', ['good-root']),
        makeTask('bad-child', ['bad-root']),
      ];

      const executorFn: ExecutorFn = async (task, opts) => {
        callLog.push(task.id);
        if (task.id === 'good-child') {
          successConsumerCtx = opts.context;
        }
        if (task.id === 'bad-root') {
          return { task, success: false, error: 'Failed', durationMs: 5, retries: 0 };
        }
        return { task, success: true, output: `data-${task.id}`, durationMs: 5, retries: 0 };
      };

      const ctx = buildContext(executorFn, cascade, ctxManager);
      const dag = new DAGExecutor(tasks, ctx);
      const results = await dag.execute('streaming');

      // good-child executed with context from good-root
      expect(callLog).toContain('good-child');
      expect(successConsumerCtx?.['dep:good-root:output']).toBe('data-good-root');

      // bad-child was cascade-skipped
      expect(callLog).not.toContain('bad-child');
      const badChild = results.find(r => r.task.id === 'bad-child');
      expect(badChild?.success).toBe(false);
      expect(badChild?.error).toContain('cascade');
    });
  });
});

// ─── ECC-009: Loop Guard Tests ────────────────────────────────────────────────

describe('ECC-009: DAGExecutor Loop Guard', () => {
  const successExecutor = {
    execute: async (task: Task): Promise<TaskResult> => ({
      task, success: true, output: 'ok', durationMs: 1, retries: 0,
    }),
    executeWithUpdates: () => ({ updates: (async function* () {})(), result: Promise.resolve({ task: {} as Task, success: true, durationMs: 0, retries: 0 }) }),
    healthCheck: async () => ({ healthy: true }),
    shutdown: async () => {},
  };

  it('passes a linear chain without triggering loop guard', async () => {
    const tasks = [makeTask('a'), makeTask('b', ['a']), makeTask('c', ['b'])];
    const ctx: ExecutionContext = { config: BASE_CONFIG, getExecutor: () => successExecutor as any };
    const executor = new DAGExecutor(tasks, ctx);
    const results = await executor.execute('streaming');
    expect(results.every(r => r.success)).toBe(true);
  });

  it('throws LoopDetectedError at construction for static dependsOn cycle', () => {
    // A -> B -> A forms a cycle
    const tasks = [makeTask('a', ['b']), makeTask('b', ['a'])];
    const ctx: ExecutionContext = { config: BASE_CONFIG, getExecutor: () => successExecutor as any };
    expect(() => new DAGExecutor(tasks, ctx)).toThrow(LoopDetectedError);
  });

  it('rejects tasks when loop depth exceeds maxLoopDepth', async () => {
    const tasks = [makeTask('deep-task')];
    const ctx: ExecutionContext = {
      config: { ...BASE_CONFIG, loopGuard: { maxLoopDepth: 2 } },
      getExecutor: () => successExecutor as any,
      loopDepth: 5,
    };
    const executor = new DAGExecutor(tasks, ctx);
    const results = await executor.execute('streaming');
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain('depth_exceeded');
  });

  it('rejects tasks when loopTimeoutMs is exceeded', async () => {
    const tasks = [makeTask('timeout-task')];
    const ctx: ExecutionContext = {
      config: { ...BASE_CONFIG, loopGuard: { loopTimeoutMs: 0 } },
      getExecutor: () => successExecutor as any,
    };
    // loopTimeoutMs=0 means already timed out on first check
    const executor = new DAGExecutor(tasks, ctx);
    const results = await executor.execute('streaming');
    expect(results[0]?.success).toBe(false);
    expect(results[0]?.error).toContain('timeout');
  });

  it('propagates x-swarm-origin header on task dispatch', async () => {
    const capturedHeaders: Record<string, string>[] = [];
    const headerCapturingExecutor = {
      execute: async (task: Task, opts: any): Promise<TaskResult> => {
        capturedHeaders.push(opts.headers ?? {});
        return { task, success: true, output: 'ok', durationMs: 1, retries: 0 };
      },
      executeWithUpdates: () => ({ updates: (async function* () {})(), result: Promise.resolve({ task: {} as Task, success: true, durationMs: 0, retries: 0 }) }),
      healthCheck: async () => ({ healthy: true }),
      shutdown: async () => {},
    };
    const tasks = [makeTask('origin-task')];
    const ctx: ExecutionContext = {
      config: BASE_CONFIG,
      getExecutor: () => headerCapturingExecutor as any,
      swarmOrigin: 'test-campaign-001',
    };
    const executor = new DAGExecutor(tasks, ctx);
    await executor.execute('streaming');
    expect(capturedHeaders[0]?.['x-swarm-origin']).toBe('test-campaign-001');
    expect(capturedHeaders[0]?.['x-swarm-depth']).toBe('0');
  });
});

describe('DAG executor model propagation', () => {
  for (const mode of ['streaming', 'waves'] as const) {
    it(`passes the executor-specific model through ${mode} dispatch`, async () => {
      const capturedModels: Array<string | undefined> = [];
      const task = { ...makeTask(`model-${mode}`), executor: 'kimi', model: 'moonshotai/kimi-k3' };
      const ctx: ExecutionContext = {
        config: BASE_CONFIG,
        getExecutor: () => ({
          execute: async (executedTask: Task, opts: any): Promise<TaskResult> => {
            capturedModels.push(opts.env?.SWARM_RESOLVED_MODEL);
            return { task: executedTask, success: true, output: 'ok', durationMs: 1, retries: 0 };
          },
        }) as any,
        resolveModel: (_task, executorId) => executorId === 'kimi' ? 'moonshotai/kimi-k3' : undefined,
      };

      const executor = new DAGExecutor([task], ctx);
      await executor.execute(mode);

      expect(capturedModels).toEqual(['moonshotai/kimi-k3']);
    });
  }
});


describe('DAG chain deadline scope', () => {
  for (const [label, depth, explicit, expected] of [
    ['ordinary top-level dependency wait', 0, false, true],
    ['nested recursive chain', 1, false, false],
    ['explicit operator deadline', 0, true, false],
  ] as const) {
    it(label, async () => {
      let now = 0;
      const clock = spyOn(Date, 'now').mockImplementation(() => now);
      try {
        const ctx = buildContext(async task => {
          now += 31000;
          return { task, success: true, output: 'ok', durationMs: 31000, retries: 0 };
        });
        ctx.loopDepth = depth;
        ctx.config = {...BASE_CONFIG, ...(explicit ? {loopGuard:{loopTimeoutMs:30000}} : {})};
        const results = await new DAGExecutor([makeTask('root'), makeTask('join', ['root'])], ctx).execute('streaming');
        expect(results.find(r => r.task.id === 'join')?.success).toBe(expected);
      } finally { clock.mockRestore(); }
    });
  }
});
