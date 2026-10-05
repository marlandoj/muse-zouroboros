import { beforeEach, afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SwarmOrchestrator } from '../orchestrator.js';
import { closeDb, getDb } from '../db/schema.js';
import type { Task, TaskResult } from '../types.js';
import type {
  ExecutorTransport,
  HealthStatus,
  SessionUpdate,
  TransportOptions,
} from '../transport/types.js';

const TEST_DB = '/tmp/swarm-orchestrator-fallback.db';

let originalCatalogPath: string | undefined;
let catalogDirectory: string;

function transport(result: (task: Task, options: TransportOptions) => TaskResult): ExecutorTransport {
  return {
    async execute(task: Task, options: TransportOptions): Promise<TaskResult> {
      return result(task, options);
    },
    executeWithUpdates(task: Task, options: TransportOptions) {
      return {
        updates: (async function* (): AsyncIterable<SessionUpdate> {})(),
        result: this.execute(task, options),
      };
    },
    async healthCheck(): Promise<HealthStatus> {
      return { healthy: true };
    },
    async shutdown(): Promise<void> {},
  };
}

describe('SwarmOrchestrator fallback resolution', () => {
  beforeEach(() => {
    originalCatalogPath = process.env.SWARM_MODEL_CATALOG_PATH;
    catalogDirectory = mkdtempSync(join(tmpdir(), 'swarm-fallback-'));
    process.env.SWARM_MODEL_CATALOG_PATH = join(catalogDirectory, 'absent.json');
  });
  afterEach(() => {
    if (originalCatalogPath === undefined) delete process.env.SWARM_MODEL_CATALOG_PATH;
    else process.env.SWARM_MODEL_CATALOG_PATH = originalCatalogPath;
    rmSync(catalogDirectory, { recursive: true, force: true });
    closeDb();
    delete process.env.SWARM_HARNESS_SMOKE;
    for (const path of [TEST_DB, `${TEST_DB}-shm`, `${TEST_DB}-wal`]) {
      if (existsSync(path)) unlinkSync(path);
    }
  });

  test('attaches fallbacks to an explicit executor and recovers on failure', async () => {
    process.env.SWARM_HARNESS_SMOKE = '0';
    const orchestrator = new SwarmOrchestrator({
      dbPath: TEST_DB,
      enableMemory: false,
      maxRetries: 0,
      pipelineGates: {
        seedValidation: false,
        postFlightEval: false,
        gapAuditLoop: false,
        blockOnSeedFailure: false,
      },
    });

    const transports = (orchestrator as unknown as {
      transports: Map<string, ExecutorTransport>;
    }).transports;
    const attemptedModels: string[] = [];
    transports.set('claude-code', transport((task, options) => {
      attemptedModels.push(options.env?.SWARM_RESOLVED_MODEL ?? '');
      return {
        task,
        success: false,
        error: 'quota exhausted',
        durationMs: 1,
        retries: 0,
      };
    }));
    transports.set('gemini', transport((task, options) => {
      attemptedModels.push(options.env?.SWARM_RESOLVED_MODEL ?? '');
      return {
        task,
        success: true,
        output: 'CONVEYOR_OK',
        durationMs: 1,
        retries: 0,
      };
    }));

    const task: Task = {
      id: 'explicit-primary',
      persona: 'claude-code',
      task: 'Return CONVEYOR_OK.',
      priority: 'high',
      executor: 'claude-code',
    };
    const [result] = await orchestrator.run([task]);

    expect(task.fallbackExecutors?.[0]).toBe('gemini');
    expect(result.success).toBe(true);
    expect(result.output).toBe('CONVEYOR_OK');
    expect(result.effectiveExecutor).toBe('gemini');
    expect(getDb(TEST_DB).query('SELECT executor, attempts, successes FROM routing_history').all())
      .toEqual([{executor:'gemini',attempts:1,successes:1}]);
    expect(result.fallbacksAttempted).toBe(1);
    expect(attemptedModels).toEqual([
      'claude-haiku-4-5-20251001',
      'gemini-3.5-flash-lite',
    ]);
  });

  test('attributes budget usage to the executor-resolved model', async () => {
    process.env.SWARM_HARNESS_SMOKE = '0';
    const orchestrator = new SwarmOrchestrator({
      dbPath: TEST_DB,
      enableMemory: false,
      maxRetries: 0,
      pipelineGates: {
        seedValidation: false,
        postFlightEval: false,
        gapAuditLoop: false,
        blockOnSeedFailure: false,
      },
    });

    const transports = (orchestrator as unknown as {
      transports: Map<string, ExecutorTransport>;
    }).transports;
    transports.set('gemini', transport((task) => ({
      task,
      success: true,
      output: 'BUDGET_OK',
      durationMs: 1,
      retries: 0,
      tokensUsed: 1000,
    })));

    const governor = (orchestrator as unknown as {
      budgetGovernor: { recordUsage: (...args: unknown[]) => unknown };
    }).budgetGovernor;
    const recordedModels: string[] = [];
    const originalRecordUsage = governor.recordUsage.bind(governor);
    governor.recordUsage = (...args: unknown[]) => {
      recordedModels.push(args[2] as string);
      return originalRecordUsage(...args);
    };

    const task: Task = {
      id: 'budget-attribution',
      persona: 'gemini',
      task: 'Return BUDGET_OK.',
      priority: 'high',
      executor: 'gemini',
    };
    await orchestrator.run([task]);

    expect(recordedModels).toEqual(['gemini-3.5-flash-lite']);
  });
});
