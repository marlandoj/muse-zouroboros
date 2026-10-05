/**
 * Bridge executor for local executors
 * 
 * Invokes executor bridge scripts (shell scripts that wrap CLI tools).
 */

import { spawn } from 'child_process';
import { isAbsolute, join } from 'path';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { getWorkspaceRoot } from 'zouroboros-core';
import type { Task, TaskResult, ExecutorRegistryEntry, ErrorCategory } from '../types.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import { parseTaskResult, SchemaValidationError } from '../schemas/swarm-schemas.js';
import {
  prepareFilesystemContainedSpawn,
  type AdapterSpawnSpec,
} from '../transport/agent-containment.js';

export interface BridgeExecutionOptions {
  timeoutMs: number;
  workdir?: string;
  env?: Record<string, string>;
  context?: Record<string, unknown>;
}

export class BridgeExecutor {
  private registryEntry: ExecutorRegistryEntry;
  private circuitBreaker: CircuitBreaker;

  constructor(registryEntry: ExecutorRegistryEntry, circuitBreaker: CircuitBreaker) {
    this.registryEntry = registryEntry;
    this.circuitBreaker = circuitBreaker;
  }

  async execute(task: Task, options: BridgeExecutionOptions): Promise<TaskResult> {
    // Check circuit breaker
    if (!this.circuitBreaker.canAttempt()) {
      return {
        task,
        success: false,
        error: `Circuit breaker OPEN for executor ${this.registryEntry.id}`,
        durationMs: 0,
        retries: 0,
      };
    }

    const startTime = Date.now();
    const bridgePath = this.registryEntry.bridge;
    
    if (!bridgePath) {
      this.circuitBreaker.recordFailure('unknown');
      return {
        task,
        success: false,
        error: `No bridge defined for executor ${this.registryEntry.id}`,
        durationMs: 0,
        retries: 0,
      };
    }

    const fullBridgePath = isAbsolute(bridgePath)
      ? bridgePath
      : join(getWorkspaceRoot(), bridgePath);
    const workdir = options.workdir || getWorkspaceRoot();
    const childEnv = {
      ...process.env,
      ...options.env,
      SWARM_TASK_ID: task.id,
      SWARM_EXECUTOR_ID: this.registryEntry.id,
      SWARM_PERSONA: task.persona,
    } as Record<string, string>;
    let spawnSpec: AdapterSpawnSpec;
    try {
      spawnSpec = prepareFilesystemContainedSpawn(
        { command: 'bash', args: [fullBridgePath, task.task, workdir] },
        workdir,
        childEnv,
      );
    } catch (error) {
      this.circuitBreaker.recordFailure('permission_denied');
      return {
        task,
        success: false,
        error: `Executor containment failed closed: ${error instanceof Error ? error.message : String(error)}`,
        durationMs: Date.now() - startTime,
        retries: 0,
      };
    }
    const resultPath = spawnSpec.ipcHostRoot
      ? join(spawnSpec.ipcHostRoot, 'result.json')
      : join('/tmp', `swarm-bridge-${task.id}-${randomUUID()}.json`);
    childEnv.RESULT_PATH = spawnSpec.ipcGuestRoot
      ? join(spawnSpec.ipcGuestRoot, 'result.json')
      : resultPath;

    return new Promise((resolve) => {
      let child;
      try {
        child = spawn(spawnSpec.command, spawnSpec.args, {
          cwd: workdir,
          env: childEnv,
          stdio: ['ignore', 'pipe', 'pipe', ...(spawnSpec.passFds ?? [])],
          timeout: options.timeoutMs,
        });
        spawnSpec.closeAfterSpawn?.();
      } catch (error) {
        spawnSpec.closeAfterSpawn?.();
        spawnSpec.cleanupAfterExit?.();
        this.circuitBreaker.recordFailure('runtime_error');
        resolve({
          task,
          success: false,
          error: `Failed to spawn process: ${error instanceof Error ? error.message : String(error)}`,
          durationMs: Date.now() - startTime,
          retries: 0,
        });
        return;
      }

      let stdout = '';
      let stderr = '';

      child.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      child.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      child.on('close', (code) => {
        const durationMs = Date.now() - startTime;
        let structuredOutput: string | undefined;
        let structuredArtifacts: string[] | undefined;
        let structuredModel: string | undefined;
        let modelProvenance: TaskResult['modelProvenance'];

        try {
          if (existsSync(resultPath)) {
            const structured = parseTaskResult(readFileSync(resultPath, 'utf8'));
            if (typeof structured.output === 'string') {
              structuredOutput = structured.output;
            }
            structuredModel = structured.modelUsed?.trim() || undefined;
            modelProvenance = structured.modelProvenance;
            structuredArtifacts = [
              ...(Array.isArray(structured.artifacts) ? structured.artifacts : []),
            ];
          }
        } catch (err) {
          if (err instanceof SchemaValidationError) {
            console.error(`[bridge] Schema validation warning for ${task.id}: ${err.message}`);
            // Fallback: try legacy unstructured parse for backward compat
            try {
              const raw = JSON.parse(readFileSync(resultPath, 'utf8'));
              if (typeof raw.output === 'string') structuredOutput = raw.output;
              structuredModel = typeof raw.metrics?.model === "string" ? raw.metrics.model.trim() || undefined : undefined;
              structuredArtifacts = [
                ...(Array.isArray(raw.artifacts?.filesCreated) ? raw.artifacts.filesCreated : []),
                ...(Array.isArray(raw.artifacts?.filesModified) ? raw.artifacts.filesModified : []),
                ...(Array.isArray(raw.artifacts?.filesDeleted) ? raw.artifacts.filesDeleted : []),
              ];
            } catch {}
          }
        }
        try { unlinkSync(resultPath); } catch {}
        spawnSpec.cleanupAfterExit?.();
        
        if (code === 0) {
          this.circuitBreaker.recordSuccess();
          resolve({
            task,
            success: true,
            output: structuredOutput ?? stdout,
            durationMs,
            retries: 0,
            artifacts: structuredArtifacts,
            modelUsed: structuredModel,
            modelProvenance,
          });
        } else {
          const errorCategory = this.classifyError(stderr, code);
          this.circuitBreaker.recordFailure(errorCategory);
          resolve({
            task,
            success: false,
            error: stderr || stdout || `Process exited with code ${code}`,
            durationMs,
            retries: 0,
          });
        }
      });

      child.on('error', (err) => {
        spawnSpec.cleanupAfterExit?.();
        const durationMs = Date.now() - startTime;
        this.circuitBreaker.recordFailure('runtime_error');
        resolve({
          task,
          success: false,
          error: `Failed to spawn process: ${err.message}`,
          durationMs,
          retries: 0,
        });
      });
    });
  }

  private classifyError(stderr: string, code: number | null): ErrorCategory {
    const lowerStderr = stderr.toLowerCase();
    
    if (code === null || lowerStderr.includes('timeout') || lowerStderr.includes('timed out')) {
      return 'timeout';
    }
    if (lowerStderr.includes('rate limit') || lowerStderr.includes('429')) {
      return 'rate_limited';
    }
    if (lowerStderr.includes('permission') || lowerStderr.includes('denied') || lowerStderr.includes('403')) {
      return 'permission_denied';
    }
    if (lowerStderr.includes('context') || lowerStderr.includes('token')) {
      return 'context_overflow';
    }
    if (lowerStderr.includes('syntax') || lowerStderr.includes('parse')) {
      return 'syntax_error';
    }
    if (lowerStderr.includes('runtime') || lowerStderr.includes('error')) {
      return 'runtime_error';
    }
    
    return 'unknown';
  }
}
