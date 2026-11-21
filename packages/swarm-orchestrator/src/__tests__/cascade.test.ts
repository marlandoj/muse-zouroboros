import { describe, test, expect, beforeEach } from 'bun:test';
import { CascadeManager } from '../cascade/manager.js';

describe('CascadeManager', () => {
  let manager: CascadeManager;

  const sampleTasks = [
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
    { id: 'c', dependsOn: ['a'] },
    { id: 'd', dependsOn: ['b', 'c'] },
    { id: 'e', dependsOn: ['d'] },
  ];

  beforeEach(() => {
    manager = new CascadeManager({ defaultPolicy: 'retry_then_skip', maxRetries: 2 });
    manager.buildDependencyGraph(sampleTasks);
  });

  test('builds dependency graph correctly', () => {
    const a = manager.getDependencyInfo('a');
    expect(a).toBeDefined();
    expect(a!.dependsOn).toEqual([]);
    expect(a!.dependedOnBy).toContain('b');
    expect(a!.dependedOnBy).toContain('c');
  });

  test('calculates depths correctly', () => {
    expect(manager.getDependencyInfo('a')!.depth).toBe(0);
    expect(manager.getDependencyInfo('b')!.depth).toBe(1);
    expect(manager.getDependencyInfo('d')!.depth).toBe(2);
    expect(manager.getDependencyInfo('e')!.depth).toBe(3);
  });

  test('marks critical path', () => {
    expect(manager.getDependencyInfo('e')!.criticalPath).toBe(true);
    expect(manager.getDependencyInfo('d')!.criticalPath).toBe(true);
  });

  test('getAffectedTasks returns transitive dependents', () => {
    const affected = manager.getAffectedTasks('a');
    expect(affected).toContain('b');
    expect(affected).toContain('c');
    expect(affected).toContain('d');
    expect(affected).toContain('e');
  });

  test('getAffectedTasks for leaf returns empty', () => {
    expect(manager.getAffectedTasks('e')).toEqual([]);
  });

  test('handleFailure creates cascade event', () => {
    const event = manager.handleFailure('a', 'timeout');
    expect(event.sourceTaskId).toBe('a');
    expect(event.affectedTaskIds.length).toBe(4);
    expect(event.impact).toBe('critical');
  });

  test('abort_dependents policy skips all dependents', () => {
    manager = new CascadeManager({
      defaultPolicy: 'abort_dependents',
      maxRetries: 0,
      policyOverrides: new Map(),
    });
    manager.buildDependencyGraph(sampleTasks);

    manager.handleFailure('a', 'error');
    expect(manager.isSkipped('b')).toBe(true);
    expect(manager.isSkipped('c')).toBe(true);
    expect(manager.isSkipped('d')).toBe(true);
    expect(manager.isSkipped('e')).toBe(true);
  });

  test('isolate policy only skips direct dependents', () => {
    manager = new CascadeManager({
      defaultPolicy: 'isolate',
      maxRetries: 0,
      policyOverrides: new Map(),
    });
    manager.buildDependencyGraph(sampleTasks);

    manager.handleFailure('a', 'error');
    expect(manager.isSkipped('b')).toBe(true);
    expect(manager.isSkipped('c')).toBe(true);
    expect(manager.isSkipped('d')).toBe(false); // not direct
    expect(manager.isSkipped('e')).toBe(false);
  });

  test('retry_then_skip allows retries', () => {
    manager.handleFailure('b', 'error');

    const r1 = manager.shouldRetry('b');
    expect(r1.retry).toBe(true);
    expect(r1.backoffMs).toBeGreaterThan(0);

    const r2 = manager.shouldRetry('b');
    expect(r2.retry).toBe(true);

    const r3 = manager.shouldRetry('b');
    expect(r3.retry).toBe(false); // exhausted
  });

  test('retry backoff increases', () => {
    manager.handleFailure('b', 'error');
    const r1 = manager.shouldRetry('b');
    const r2 = manager.shouldRetry('b');
    expect(r2.backoffMs).toBeGreaterThan(r1.backoffMs);
  });

  test('exhausted retries skip dependents', () => {
    manager.handleFailure('b', 'error');
    manager.shouldRetry('b');
    manager.shouldRetry('b');
    manager.shouldRetry('b'); // exhausted

    expect(manager.isSkipped('d')).toBe(true);
    expect(manager.isSkipped('e')).toBe(true);
  });

  test('policyOverrides per task', () => {
    manager = new CascadeManager({
      defaultPolicy: 'retry_then_skip',
      maxRetries: 2,
      policyOverrides: new Map([['a', 'abort_dependents']]),
    });
    manager.buildDependencyGraph(sampleTasks);

    manager.handleFailure('a', 'error');
    expect(manager.isSkipped('b')).toBe(true);
  });

  test('assessImpact: negligible for leaf failure with no dependents', () => {
    // e is on critical path so use a fresh graph with an isolated leaf
    const mgr = new CascadeManager({ defaultPolicy: 'retry_then_skip', maxRetries: 2 });
    mgr.buildDependencyGraph([
      { id: 'a' },
      { id: 'b', dependsOn: ['a'] },
      { id: 'leaf', dependsOn: ['a'] },
    ]);
    const event = mgr.handleFailure('leaf', 'error');
    expect(event.impact).toBe('negligible');
  });

  test('isFailed tracks failed tasks', () => {
    expect(manager.isFailed('a')).toBe(false);
    manager.handleFailure('a', 'err');
    expect(manager.isFailed('a')).toBe(true);
  });

  test('getEvents returns all cascade events', () => {
    manager.handleFailure('a', 'err1');
    manager.handleFailure('b', 'err2');
    expect(manager.getEvents()).toHaveLength(2);
  });

  test('reset clears state', () => {
    manager.handleFailure('a', 'err');
    manager.reset();
    expect(manager.isFailed('a')).toBe(false);
    expect(manager.getEvents()).toHaveLength(0);
    expect(manager.getSkippedTasks()).toHaveLength(0);
  });

  test('onCascade callback fires', () => {
    const events: unknown[] = [];
    manager = new CascadeManager({
      defaultPolicy: 'abort_dependents',
      maxRetries: 0,
      onCascade: (e) => events.push(e),
      policyOverrides: new Map(),
    });
    manager.buildDependencyGraph(sampleTasks);
    manager.handleFailure('a', 'err');
    expect(events).toHaveLength(1);
  });

  test('maxCascadeDepth limits transitive reach', () => {
    manager = new CascadeManager({
      defaultPolicy: 'abort_dependents',
      maxRetries: 0,
      maxCascadeDepth: 1,
      policyOverrides: new Map(),
    });
    manager.buildDependencyGraph(sampleTasks);

    const affected = manager.getAffectedTasks('a');
    // depth=1: only direct dependents b, c (not d, e)
    expect(affected).toContain('b');
    expect(affected).toContain('c');
    expect(affected).not.toContain('d');
    expect(affected).not.toContain('e');
  });
});
