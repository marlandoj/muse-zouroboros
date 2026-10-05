import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_ROUTING_POLICY,
  computeResultDigest,
  type ExecutionEnvelope,
  type ExecutionAttempt,
  type ProviderAdapter,
} from 'zouroboros-core';
import { createComputeDispatcher } from '../compute/dispatcher.js';
import { DAGExecutor, type ExecutionContext } from '../dag/executor.js';
import type { SwarmConfig, Task } from '../types.js';

const CONFIG: SwarmConfig = {
  localConcurrency: 2,
  timeoutSeconds: 30,
  maxRetries: 0,
  enableMemory: false,
  dagMode: 'streaming',
  notifyOnComplete: 'none',
  routingStrategy: 'balanced',
  useSixSignalRouting: false,
  stagnationEnabled: false,
};

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'compute-1',
    persona: 'verification',
    task: 'Verify deterministic fixture',
    priority: 'medium',
    compute: {
      nodeKind: 'verification',
      provider: 'modal',
      workloadClass: 'deterministic-fixture',
      environment: 'test',
      approvalId: 'approval-1',
      classification: 'public',
      costEstimateUsd: 0.1,
      canonicalWrites: false,
      externalMutations: false,
      idempotent: true,
      inputManifest: [],
      outputLimits: { maxArtifacts: 2, maxBytes: 1024 },
      callback: { callbackId: 'callback-1', nonce: 'nonce-1', expiresAt: '2026-08-12T00:00:00Z' },
      cleanup: { required: true, deadlineAt: '2026-08-12T00:10:00Z' },
      idempotencyKey: 'idem-1',
      maxRuntimeMs: 60_000,
      maxAttempts: 1,
      maxCostUsd: 1,
    },
    ...overrides,
  };
}

function policy(mode: 'shadow' | 'enforce') {
  return {
    ...DEFAULT_ROUTING_POLICY,
    policyVersion: 'test-v1',
    enabled: true,
    mode,
    environment: 'test',
    environmentEnabled: { test: true },
    providerEnabled: { local: true, modal: true, hetzner: false },
    workloadClassEnabled: { 'deterministic-fixture': true },
    maxCostUsdByProvider: { local: 0, modal: 1, hetzner: 0 },
  };
}

function modalAdapter(onExecute?: () => void): ProviderAdapter {
  return {
    provider: 'modal',
    async execute(envelope: ExecutionEnvelope, attempt: ExecutionAttempt) {
      onExecute?.();
      const outputManifest = [{
        schemaVersion: 1 as const,
        artifactId: 'result.json',
        mediaType: 'application/json',
        sizeBytes: 20,
        sha256: 'b'.repeat(64),
        immutable: true as const,
        contentAddressed: true as const,
      }];
      return {
        schemaVersion: 1,
        executionId: envelope.executionId,
        attemptId: attempt.attemptId,
        provider: 'modal',
        terminalState: 'succeeded',
        outputManifest,
        callback: {
          schemaVersion: 1,
          executionId: envelope.executionId,
          attemptId: attempt.attemptId,
          callbackId: envelope.callback.callbackId,
          nonce: envelope.callback.nonce,
          receivedAt: '2026-08-11T17:01:00Z',
          terminalState: 'succeeded',
          resultDigest: computeResultDigest(outputManifest),
        },
        cleanup: {
          schemaVersion: 1,
          executionId: envelope.executionId,
          attemptId: attempt.attemptId,
          clean: true,
          completedAt: '2026-08-11T17:02:00Z',
        },
        costActualUsd: 0.05,
      };
    },
    async cancel() {},
  };
}

describe('Swarm compute dispatcher', () => {
  test('fails closed by default without invoking an adapter', async () => {
    let calls = 0;
    const dispatcher = createComputeDispatcher({
      adapters: new Map([['modal', modalAdapter(() => calls++)]]),
    });
    const result = await dispatcher.dispatch(task());
    expect(result.success).toBe(false);
    expect(result.computeDecision?.holdReason).toBe('global_disabled');
    expect(calls).toBe(0);
  });

  test('records shadow intent without invoking an adapter', async () => {
    let calls = 0;
    const dispatcher = createComputeDispatcher({
      policy: policy('shadow'),
      adapters: new Map([['modal', modalAdapter(() => calls++)]]),
    });
    const result = await dispatcher.dispatch(task());
    expect(result.success).toBe(false);
    expect(result.computeDecision?.action).toBe('shadow');
    expect(result.error).toContain('no provider dispatch');
    expect(calls).toBe(0);
  });

  test('accepts only verified provider results in enforce mode', async () => {
    let calls = 0;
    let sequence = 0;
    const dispatcher = createComputeDispatcher({
      policy: policy('enforce'),
      adapters: new Map([['modal', modalAdapter(() => calls++)]]),
      now: () => new Date('2026-08-11T17:00:00Z'),
      id: () => `id-${++sequence}`,
    });
    const result = await dispatcher.dispatch(task());
    expect(result.success).toBe(true);
    expect(result.computeResult?.terminalState).toBe('succeeded');
    expect(result.computeTelemetry).toMatchObject({ costActualUsd: 0.05, cleanupComplete: true });
    expect(calls).toBe(1);
  });

  test('exhausts only the lease-bounded attempts with fresh attempt identities', async () => {
    const attemptIds: string[] = [];
    const failingAdapter: ProviderAdapter = {
      provider: 'modal',
      async execute(_envelope, attempt) {
        attemptIds.push(attempt.attemptId);
        throw new Error('provider unavailable');
      },
      async cancel() {},
    };
    let sequence = 0;
    const dispatcher = createComputeDispatcher({
      policy: policy('enforce'),
      adapters: new Map([['modal', failingAdapter]]),
      now: () => new Date('2026-08-11T17:00:00Z'),
      id: () => `id-${++sequence}`,
    });
    const result = await dispatcher.dispatch(task({ compute: { ...task().compute!, maxAttempts: 3 } }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('after 3 attempt(s)');
    expect(result.retries).toBe(2);
    expect(attemptIds).toHaveLength(3);
    expect(new Set(attemptIds).size).toBe(3);
  });

  test('DAG compute nodes bypass model executors and block dependents while shadowed', async () => {
    let executorCalls = 0;
    const compute = task();
    const dependent = task({
      id: 'dependent-agent',
      compute: undefined,
      dependsOn: ['compute-1'],
      persona: 'coder',
      task: 'Consume verified artifact',
    });
    const context: ExecutionContext = {
      config: CONFIG,
      getExecutor: () => ({
        execute: async (agentTask: Task) => {
          executorCalls++;
          return { task: agentTask, success: true, output: 'done', durationMs: 1, retries: 0 };
        },
        executeWithUpdates: () => ({ updates: (async function* () {})(), result: Promise.reject(new Error('unused')) }),
        healthCheck: async () => ({ healthy: true }),
        shutdown: async () => {},
      }),
      computeDispatcher: createComputeDispatcher({ policy: policy('shadow') }),
    };
    const results = await new DAGExecutor([compute, dependent], context).execute('streaming');
    expect(results.find((entry) => entry.task.id === 'compute-1')?.computeDecision?.action).toBe('shadow');
    expect(results.some((entry) => entry.task.id === 'dependent-agent')).toBe(false);
    expect(executorCalls).toBe(0);
  });
});
