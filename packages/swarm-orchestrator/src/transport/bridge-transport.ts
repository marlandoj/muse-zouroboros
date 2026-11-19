/**
 * BridgeTransport — wraps BridgeExecutor to implement ExecutorTransport.
 *
 * This is a pure refactor adapter: all bridge execution logic stays in
 * BridgeExecutor. BridgeTransport just satisfies the ExecutorTransport
 * interface so the orchestrator is transport-agnostic.
 */

import type { Task, TaskResult, ExecutorRegistryEntry } from '../types.js';
import { BridgeExecutor } from '../executor/bridge.js';
import { CircuitBreaker } from '../circuit/breaker.js';
import type {
  ExecutorTransport,
  TransportOptions,
  SessionUpdate,
  HealthStatus,
} from './types.js';
import { existsSync } from 'fs';
import { isAbsolute, join } from 'path';
import { getWorkspaceRoot } from 'zouroboros-core';

async function* emptyAsyncIterable(): AsyncIterable<SessionUpdate> {}

export class BridgeTransport implements ExecutorTransport {
  private bridge: BridgeExecutor;
  private entry: ExecutorRegistryEntry;

  constructor(entry: ExecutorRegistryEntry, circuitBreaker: CircuitBreaker) {
    this.entry = entry;
    this.bridge = new BridgeExecutor(entry, circuitBreaker);
  }

  async execute(task: Task, options: TransportOptions): Promise<TaskResult> {
    return this.bridge.execute(task, options);
  }

  executeWithUpdates(task: Task, options: TransportOptions): {
    updates: AsyncIterable<SessionUpdate>;
    result: Promise<TaskResult>;
  } {
    return {
      updates: emptyAsyncIterable(),
      result: this.bridge.execute(task, options),
    };
  }

  async healthCheck(): Promise<HealthStatus> {
    const hc = this.entry.healthCheck;
    if (!hc?.command) {
      return { healthy: true, message: 'No health check configured' };
    }

    // Validate bridge script exists as a quick sanity check
    if (this.entry.bridge) {
      const bridgePath = isAbsolute(this.entry.bridge)
        ? this.entry.bridge
        : join(getWorkspaceRoot(), this.entry.bridge);
      if (!existsSync(bridgePath)) {
        return {
          healthy: false,
          message: `Bridge script not found: ${bridgePath}`,
        };
      }
    }

    return { healthy: true, message: `Bridge executor ${this.entry.id} ready` };
  }

  async shutdown(): Promise<void> {
    // Bridge processes are fire-and-forget — nothing to tear down.
  }
}
