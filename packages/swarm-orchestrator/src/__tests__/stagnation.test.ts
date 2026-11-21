import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StagnationDetector } from '../stagnation/detector.js';

describe('StagnationDetector', () => {
  let detector: StagnationDetector;

  beforeEach(() => {
    detector = new StagnationDetector({
      noOutputThresholdMs: 100,
      repetitionWindowSize: 3,
      repetitionThreshold: 0.8,
      progressCheckIntervalMs: 60_000, // high to avoid auto-checks
      timeoutWarningPercent: 80,
      maxRecoveryAttempts: 3,
    });
  });

  afterEach(() => {
    detector.stopAll();
  });

  test('starts monitoring a task', () => {
    detector.startMonitoring('task-1', 10_000);
    const state = detector.getState('task-1');
    expect(state).toBeDefined();
    expect(state!.taskId).toBe('task-1');
  });

  test('detects no-output stagnation', async () => {
    detector.startMonitoring('task-1', 10_000);
    // Wait for silence threshold
    await new Promise(r => setTimeout(r, 150));
    const event = detector.check('task-1');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('no_output');
  });

  test('no stagnation with recent output', () => {
    detector.startMonitoring('task-1', 10_000);
    detector.recordOutput('task-1', 'some output');
    const event = detector.check('task-1');
    expect(event).toBeNull();
  });

  test('detects repetitive output', () => {
    detector = new StagnationDetector({
      noOutputThresholdMs: 60_000, // high to avoid no_output trigger
      repetitionWindowSize: 3,
      repetitionThreshold: 0.6, // 60% identical triggers
      progressCheckIntervalMs: 60_000,
      timeoutWarningPercent: 80,
      maxRecoveryAttempts: 3,
    });

    detector.startMonitoring('task-1', 10_000);
    detector.recordOutput('task-1', 'same line');
    detector.recordOutput('task-1', 'same line');
    detector.recordOutput('task-1', 'same line');

    const event = detector.check('task-1');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('repetitive_output');
  });

  test('no repetition with diverse output', () => {
    detector.startMonitoring('task-1', 10_000);
    detector.recordOutput('task-1', 'line A');
    detector.recordOutput('task-1', 'line B');
    detector.recordOutput('task-1', 'line C');

    const event = detector.check('task-1');
    expect(event).toBeNull();
  });

  test('detects progress plateau', () => {
    detector.startMonitoring('task-1', 10_000);
    detector.recordOutput('task-1', 'keep alive');

    detector.recordProgress('task-1', 50);
    detector.recordProgress('task-1', 50);
    detector.recordProgress('task-1', 50);
    detector.recordProgress('task-1', 50);

    const event = detector.check('task-1');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('progress_plateau');
  });

  test('no plateau at 0% or 100%', () => {
    detector.startMonitoring('task-1', 10_000);
    detector.recordOutput('task-1', 'keep alive');

    detector.recordProgress('task-1', 100);
    detector.recordProgress('task-1', 100);
    detector.recordProgress('task-1', 100);
    detector.recordProgress('task-1', 100);

    const event = detector.check('task-1');
    expect(event).toBeNull();
  });

  test('detects timeout approaching', () => {
    detector = new StagnationDetector({
      noOutputThresholdMs: 60_000,
      progressCheckIntervalMs: 60_000,
      timeoutWarningPercent: 80,
      maxRecoveryAttempts: 3,
      repetitionWindowSize: 3,
      repetitionThreshold: 0.8,
    });

    // Use a very short timeout so elapsed time exceeds 80%
    detector.startMonitoring('task-1', 10); // 10ms timeout
    detector.recordOutput('task-1', 'keep alive');

    // Force enough elapsed time
    const state = detector.getState('task-1')!;
    state.startTime = Date.now() - 100; // pretend started 100ms ago

    const event = detector.check('task-1');
    expect(event).not.toBeNull();
    expect(event!.type).toBe('timeout_approaching');
  });

  test('recovery action escalates with attempts', () => {
    detector.startMonitoring('task-1', 10_000);
    const state = detector.getState('task-1')!;

    // Force no-output condition
    state.lastOutputTime = Date.now() - 200;

    const event1 = detector.check('task-1');
    expect(event1!.recoveryAction).toBe('nudge');

    state.lastOutputTime = Date.now() - 200;
    const event2 = detector.check('task-1');
    expect(event2!.recoveryAction).toBe('retry');

    state.lastOutputTime = Date.now() - 200;
    const event3 = detector.check('task-1');
    expect(event3!.recoveryAction).toBe('escalate');
  });

  test('abort after max recovery attempts', () => {
    detector = new StagnationDetector({
      noOutputThresholdMs: 10,
      maxRecoveryAttempts: 1,
      progressCheckIntervalMs: 60_000,
      repetitionWindowSize: 3,
      repetitionThreshold: 0.8,
      timeoutWarningPercent: 80,
    });

    detector.startMonitoring('task-1', 10_000);
    const state = detector.getState('task-1')!;

    state.lastOutputTime = Date.now() - 50;
    detector.check('task-1');

    state.lastOutputTime = Date.now() - 50;
    const event = detector.check('task-1');
    expect(event!.recoveryAction).toBe('abort');
  });

  test('stopMonitoring returns events and cleans up', () => {
    detector.startMonitoring('task-1', 10_000);
    const state = detector.getState('task-1')!;
    state.lastOutputTime = Date.now() - 200;
    detector.check('task-1');

    const events = detector.stopMonitoring('task-1');
    expect(events).toHaveLength(1);
    expect(detector.getState('task-1')).toBeUndefined();
  });

  test('calls onStagnation callback', () => {
    const received: unknown[] = [];
    detector = new StagnationDetector({
      noOutputThresholdMs: 10,
      progressCheckIntervalMs: 60_000,
      repetitionWindowSize: 3,
      repetitionThreshold: 0.8,
      timeoutWarningPercent: 80,
      maxRecoveryAttempts: 3,
      onStagnation: (e) => received.push(e),
    });

    detector.startMonitoring('task-1', 10_000);
    const state = detector.getState('task-1')!;
    state.lastOutputTime = Date.now() - 50;
    detector.check('task-1');

    expect(received).toHaveLength(1);
    detector.stopAll();
  });

  test('returns null for unknown task', () => {
    expect(detector.check('nonexistent')).toBeNull();
  });
});
