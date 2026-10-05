import { randomUUID } from 'node:crypto';
import {
  CallbackReplayGuard,
  DEFAULT_ROUTING_POLICY,
  EXECUTION_CONTRACT_VERSION,
  createExecutionTelemetry,
  routeExecution,
  validateExecutionAttempt,
  validateExecutionEnvelope,
  validateExecutionResult,
  type ExecutionAttempt,
  type ExecutionEnvelope,
  type ProviderAdapter,
  type RoutingPolicy,
} from 'zouroboros-core';
import type { ComputeIntent, Task, TaskResult } from '../types.js';

export interface ComputeDispatcher {
  dispatch(task: Task): Promise<TaskResult>;
}

export interface ComputeDispatcherOptions {
  policy?: RoutingPolicy;
  adapters?: ReadonlyMap<string, ProviderAdapter>;
  now?: () => Date;
  id?: () => string;
  replayGuard?: CallbackReplayGuard;
}

function heldResult(task: Task, startedAt: number, message: string, decision?: TaskResult['computeDecision'], retries = 0): TaskResult {
  return {
    task,
    success: false,
    error: message,
    output: message,
    durationMs: Date.now() - startedAt,
    retries,
    ...(decision ? { computeDecision: decision } : {}),
  };
}

function routingInput(intent: ComputeIntent) {
  return {
    nodeKind: intent.nodeKind,
    workloadClass: intent.workloadClass,
    environment: intent.environment,
    provider: intent.provider,
    approvalId: intent.approvalId,
    classification: intent.classification,
    costEstimateUsd: intent.costEstimateUsd,
    callbackId: intent.callback?.callbackId,
    cleanupRequired: intent.cleanup?.required,
    idempotent: intent.idempotent,
    canonicalWrites: intent.canonicalWrites,
    externalMutations: intent.externalMutations,
  };
}

function materializeEnvelope(
  task: Task,
  intent: ComputeIntent,
  policy: RoutingPolicy,
  now: Date,
  id: () => string,
): ExecutionEnvelope {
  const executionId = id();
  const maxRuntimeMs = intent.maxRuntimeMs ?? (task.timeoutSeconds ?? 600) * 1000;
  const maxAttempts = intent.maxAttempts ?? 1;
  const maxCostUsd = intent.maxCostUsd ?? intent.costEstimateUsd ?? 0;
  return validateExecutionEnvelope({
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId,
    traceId: id(),
    nodeKind: intent.nodeKind,
    workloadClass: intent.workloadClass,
    provider: intent.provider,
    policyVersion: policy.policyVersion,
    approvalId: intent.approvalId,
    classification: intent.classification,
    canonicalWrites: intent.canonicalWrites ?? false,
    externalMutations: intent.externalMutations ?? false,
    inputManifest: intent.inputManifest,
    outputLimits: intent.outputLimits,
    callback: intent.callback,
    cleanup: intent.cleanup,
    lease: {
      schemaVersion: EXECUTION_CONTRACT_VERSION,
      leaseId: id(),
      executionId,
      issuedAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + maxRuntimeMs).toISOString(),
      maxRuntimeMs,
      maxAttempts,
      maxCostUsd,
    },
    idempotencyKey: intent.idempotencyKey,
    costEstimateUsd: intent.costEstimateUsd,
    createdAt: now.toISOString(),
  });
}

function materializeAttempt(envelope: ExecutionEnvelope, now: Date, id: () => string, attemptNumber: number): ExecutionAttempt {
  return validateExecutionAttempt(envelope, {
    schemaVersion: EXECUTION_CONTRACT_VERSION,
    executionId: envelope.executionId,
    leaseId: envelope.lease.leaseId,
    attemptId: id(),
    attemptNumber,
    provider: envelope.provider,
    idempotencyKey: envelope.idempotencyKey,
    startedAt: now.toISOString(),
    maxRuntimeMs: envelope.lease.maxRuntimeMs,
  });
}

export function createComputeDispatcher(options: ComputeDispatcherOptions = {}): ComputeDispatcher {
  const policy = options.policy ?? DEFAULT_ROUTING_POLICY;
  const adapters = options.adapters ?? new Map<string, ProviderAdapter>();
  const now = options.now ?? (() => new Date());
  const id = options.id ?? randomUUID;
  const replayGuard = options.replayGuard ?? new CallbackReplayGuard();

  return {
    async dispatch(task: Task): Promise<TaskResult> {
      const startedAt = Date.now();
      const intent = task.compute;
      if (!intent) return heldResult(task, startedAt, 'compute dispatcher requires an explicit compute intent');
      const route = routeExecution(routingInput(intent), policy);
      if (route.action === 'hold') {
        return heldResult(task, startedAt, `compute held: ${route.holdReason ?? 'invalid_contract'}: ${route.reasons.join('; ')}`, route);
      }
      if (route.action === 'shadow') {
        return heldResult(task, startedAt, `compute shadow only: ${route.provider}; no provider dispatch`, route);
      }
      const adapter = adapters.get(route.provider);
      if (!adapter) return heldResult(task, startedAt, `compute held: no adapter registered for ${route.provider}`, route);

      try {
        const envelope = materializeEnvelope(task, { ...intent, provider: route.provider }, policy, now(), id);
        let lastError: unknown;
        for (let attemptNumber = 1; attemptNumber <= envelope.lease.maxAttempts; attemptNumber++) {
          const attempt = materializeAttempt(envelope, now(), id, attemptNumber);
          try {
            const rawResult = await adapter.execute(envelope, attempt);
            const computeResult = validateExecutionResult(envelope, rawResult, { attempt, replayGuard });
            const computeTelemetry = createExecutionTelemetry(envelope, attempt, computeResult);
            const success = computeResult.terminalState === 'succeeded';
            return {
              task,
              success,
              output: success ? `compute verified: ${computeResult.outputManifest.length} artifact(s)` : undefined,
              error: success ? undefined : `compute terminal state: ${computeResult.terminalState}`,
              durationMs: Date.now() - startedAt,
              retries: attempt.attemptNumber - 1,
              artifacts: computeResult.outputManifest.map((artifact) => artifact.artifactId),
              computeDecision: route,
              computeResult,
              computeTelemetry,
            };
          } catch (error) {
            lastError = error;
          }
        }
        return heldResult(
          task,
          startedAt,
          `compute verification failed after ${envelope.lease.maxAttempts} attempt(s): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
          route,
          envelope.lease.maxAttempts - 1,
        );
      } catch (error) {
        return heldResult(task, startedAt, `compute verification failed: ${error instanceof Error ? error.message : String(error)}`, route);
      }
    },
  };
}
