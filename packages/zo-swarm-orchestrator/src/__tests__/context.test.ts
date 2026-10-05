import { describe, test, expect, beforeEach } from 'bun:test';
import { ContextSharingManager } from '../context/sharing.js';

describe('ContextSharingManager', () => {
  let manager: ContextSharingManager;

  beforeEach(() => {
    manager = new ContextSharingManager({
      maxContextSizeBytes: 1024,
      defaultTtlMs: 60_000,
      enableOutputForwarding: true,
      maxOutputForwardBytes: 100,
    });
  });

  test('publish and get', () => {
    manager.publish('key1', { value: 42 }, 'task-1');
    expect(manager.get('key1')).toEqual({ value: 42 });
  });

  test('returns undefined for missing key', () => {
    expect(manager.get('nonexistent')).toBeUndefined();
  });

  test('rejects oversized context', () => {
    const bigValue = 'x'.repeat(2048);
    const result = manager.publish('key1', bigValue, 'task-1');
    expect(result).toBe(false);
  });

  test('expires after TTL', () => {
    manager.publish('key1', 'data', 'task-1', { ttlMs: 1 });
    // Wait for expiry
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy wait 5ms
    expect(manager.get('key1')).toBeUndefined();
  });

  test('getContext returns full context object', () => {
    manager.publish('key1', 'data', 'task-1', { scope: 'wave', artifactType: 'text' });
    const ctx = manager.getContext('key1');
    expect(ctx).toBeDefined();
    expect(ctx!.scope).toBe('wave');
    expect(ctx!.artifactType).toBe('text');
    expect(ctx!.sourceTaskId).toBe('task-1');
  });

  test('recordTaskOutput stores and auto-publishes', () => {
    manager.recordTaskOutput('task-1', 'output data', true, ['file.ts']);

    const output = manager.getTaskOutput('task-1');
    expect(output).toBeDefined();
    expect(output!.output).toBe('output data');
    expect(output!.success).toBe(true);
    expect(output!.artifacts).toEqual(['file.ts']);

    // Auto-published as context
    expect(manager.get('task_output:task-1')).toBe('output data');
  });

  test('recordTaskOutput truncates large output', () => {
    const longOutput = 'x'.repeat(200);
    manager.recordTaskOutput('task-1', longOutput, true);

    const output = manager.getTaskOutput('task-1');
    expect(output!.output.length).toBeLessThan(200);
    expect(output!.output).toContain('[truncated]');
  });

  test('does not auto-publish failed task output', () => {
    manager.recordTaskOutput('task-1', 'error', false);
    expect(manager.get('task_output:task-1')).toBeUndefined();
  });

  test('subscribe and getSubscribedContext', () => {
    manager.publish('shared-data', { foo: 'bar' }, 'task-1');
    manager.subscribe('task-2', ['shared-data']);

    const ctx = manager.getSubscribedContext('task-2');
    expect(ctx.get('shared-data')).toEqual({ foo: 'bar' });
  });

  test('buildTaskContext includes dependency outputs', () => {
    manager.recordTaskOutput('task-1', 'result A', true, ['a.ts']);
    manager.recordTaskOutput('task-2', 'result B', true);

    const ctx = manager.buildTaskContext('task-3', ['task-1', 'task-2']);
    expect(ctx['dep:task-1:output']).toBe('result A');
    expect(ctx['dep:task-1:artifacts']).toEqual(['a.ts']);
    expect(ctx['dep:task-2:output']).toBe('result B');
  });

  test('buildTaskContext skips failed deps', () => {
    manager.recordTaskOutput('task-1', 'error', false);
    const ctx = manager.buildTaskContext('task-2', ['task-1']);
    expect(ctx['dep:task-1:output']).toBeUndefined();
  });

  test('buildTaskContext includes subscribed context', () => {
    manager.publish('config', { debug: true }, 'task-0');
    manager.subscribe('task-2', ['config']);

    const ctx = manager.buildTaskContext('task-2', []);
    expect(ctx['config']).toEqual({ debug: true });
  });

  test('getByScope filters correctly', () => {
    manager.publish('a', 1, 'task-1', { scope: 'wave' });
    manager.publish('b', 2, 'task-1', { scope: 'campaign' });
    manager.publish('c', 3, 'task-2', { scope: 'wave' });

    const waveCtx = manager.getByScope('wave');
    expect(waveCtx).toHaveLength(2);
  });

  test('getBySource filters correctly', () => {
    manager.publish('a', 1, 'task-1');
    manager.publish('b', 2, 'task-2');
    manager.publish('c', 3, 'task-1');

    const fromTask1 = manager.getBySource('task-1');
    expect(fromTask1).toHaveLength(2);
  });

  test('cleanup removes expired entries', () => {
    manager.publish('old', 'data', 'task-1', { ttlMs: 1 });
    manager.publish('fresh', 'data', 'task-1', { ttlMs: 60_000 });

    const start = Date.now();
    while (Date.now() - start < 5) {}

    const removed = manager.cleanup();
    expect(removed).toBe(1);
    expect(manager.get('fresh')).toBe('data');
  });

  test('clear empties everything', () => {
    manager.publish('a', 1, 'task-1');
    manager.recordTaskOutput('task-1', 'out', true);
    manager.subscribe('task-2', ['a']);

    manager.clear();
    const stats = manager.getStats();
    expect(stats.contextEntries).toBe(0);
    expect(stats.taskOutputs).toBe(0);
    expect(stats.subscriptions).toBe(0);
  });

  test('getStats returns correct counts', () => {
    manager.publish('a', 'hello', 'task-1');
    manager.recordTaskOutput('task-1', 'out', true);
    manager.subscribe('task-2', ['a']);

    const stats = manager.getStats();
    expect(stats.contextEntries).toBe(2); // 'a' + auto-published output
    expect(stats.taskOutputs).toBe(1);
    expect(stats.subscriptions).toBe(1);
    expect(stats.totalSizeBytes).toBeGreaterThan(0);
  });

  test('metadata is stored and retrievable', () => {
    manager.publish('key', 'val', 'task-1', { metadata: { author: 'test' } });
    const ctx = manager.getContext('key');
    expect(ctx!.metadata).toEqual({ author: 'test' });
  });
});
