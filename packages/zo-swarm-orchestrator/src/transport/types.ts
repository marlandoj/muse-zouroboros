/**
 * ExecutorTransport — transport abstraction layer for swarm executors.
 *
 * Both BridgeTransport (shell bridge) and ACPTransport (Agent Client Protocol)
 * implement this interface. The orchestrator and DAG executor are transport-agnostic.
 */

import type { Task, TaskResult } from '../types.js';

export interface SessionUpdate {
  type: 'text' | 'tool_call' | 'tool_result' | 'error' | 'progress';
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface TransportOptions {
  timeoutMs: number;
  /** Optional no-update timeout. ACP sessions are cancelled when they emit no
   * session update for this interval, allowing callers to fail over from a
   * wedged agent without shortening the total task budget. */
  idleTimeoutMs?: number;
  workdir?: string;
  env?: Record<string, string>;
  context?: Record<string, unknown>;
  /** ECC-009 Layer 1: propagated loop guard headers (x-swarm-origin, x-swarm-depth) */
  headers?: Record<string, string>;
  /**
   * Live-observation tap: invoked for every SessionUpdate as it arrives
   * (ACP transport only; bridge is end-only and never calls it).
   * Observers must be treated as untrusted — transports wrap invocation in
   * try/catch so a throwing observer can never fail a session.
   */
  onUpdate?: (update: SessionUpdate) => void;
}

export interface HealthStatus {
  healthy: boolean;
  message?: string;
}

/**
 * ExecutorTransport — the single interface all executor backends implement.
 *
 * Phase 1: execute() returns Promise<TaskResult> (bridge-compatible).
 * Phase 2: executeWithUpdates() adds streaming for ACP transports.
 */
export interface ExecutorTransport {
  /** Execute a task and return the final result. */
  execute(task: Task, options: TransportOptions): Promise<TaskResult>;

  /**
   * Execute a task with streaming updates.
   * BridgeTransport returns an empty async iterable for updates.
   * ACPTransport yields real-time tool_call / text events.
   */
  executeWithUpdates(task: Task, options: TransportOptions): {
    updates: AsyncIterable<SessionUpdate>;
    result: Promise<TaskResult>;
  };

  /** Verify adapter/bridge is reachable and healthy. */
  healthCheck(): Promise<HealthStatus>;

  /** Gracefully release resources (connections, processes). */
  shutdown(): Promise<void>;
}

export type TransportType = 'bridge' | 'acp';
