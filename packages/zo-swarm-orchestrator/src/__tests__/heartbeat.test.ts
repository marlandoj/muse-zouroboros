import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { HeartbeatScheduler } from '../heartbeat/scheduler.js';
import { closeDb } from '../db/schema.js';
import { unlinkSync, existsSync } from 'fs';

const TEST_DB = '/tmp/swarm-test-heartbeat.db';

async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

let scheduler: HeartbeatScheduler;

beforeEach(() => {
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
  scheduler = new HeartbeatScheduler(TEST_DB);
});

afterEach(() => {
  scheduler.stopAll();
  closeDb();
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB);
});

describe('Heartbeat Scheduler', () => {
  test('starts and reports running', () => {
    scheduler.start({ swarmId: 'test-1', intervalMs: 60000, maxBeats: 5, onIdle: 'sleep' });
    expect(scheduler.isRunning('test-1')).toBe(true);
  });

  test('stops and reports not running', () => {
    scheduler.start({ swarmId: 'test-1', intervalMs: 60000, maxBeats: 5, onIdle: 'sleep' });
    scheduler.stop('test-1');
    expect(scheduler.isRunning('test-1')).toBe(false);
  });

  test('emits events on beat', async () => {
    const events: string[] = [];
    scheduler.on((e) => events.push(e.status));

    scheduler.start({ swarmId: 'test-1', intervalMs: 50, maxBeats: 3, onIdle: 'sleep' });
    await waitFor(() => events.length > 0);
    scheduler.stop('test-1');

    expect(events.length).toBeGreaterThan(0);
  });

  test('stops after maxBeats', async () => {
    const events: string[] = [];
    scheduler.on((e) => events.push(e.status));

    scheduler.start({ swarmId: 'test-1', intervalMs: 30, maxBeats: 2, onIdle: 'sleep' });
    await waitFor(() => !scheduler.isRunning('test-1'));

    expect(scheduler.isRunning('test-1')).toBe(false);
    expect(events).toContain('max_reached');
  });

  test('persists beats to database', async () => {
    scheduler.start({ swarmId: 'test-1', intervalMs: 30, maxBeats: 2, onIdle: 'sleep' });
    await waitFor(() => scheduler.getHistory('test-1').length > 0);

    const history = scheduler.getHistory('test-1');
    expect(history.length).toBeGreaterThan(0);
  });

  test('stopAll clears all timers', () => {
    scheduler.start({ swarmId: 'a', intervalMs: 60000, maxBeats: 5, onIdle: 'sleep' });
    scheduler.start({ swarmId: 'b', intervalMs: 60000, maxBeats: 5, onIdle: 'sleep' });
    expect(scheduler.isRunning('a')).toBe(true);
    expect(scheduler.isRunning('b')).toBe(true);
    scheduler.stopAll();
    expect(scheduler.isRunning('a')).toBe(false);
    expect(scheduler.isRunning('b')).toBe(false);
  });

  test('getBeatCount returns 0 for unknown swarm', () => {
    expect(scheduler.getBeatCount('unknown')).toBe(0);
  });

  test('restart replaces existing timer', () => {
    scheduler.start({ swarmId: 'test-1', intervalMs: 60000, maxBeats: 5, onIdle: 'sleep' });
    scheduler.start({ swarmId: 'test-1', intervalMs: 30000, maxBeats: 10, onIdle: 'stop' });
    expect(scheduler.isRunning('test-1')).toBe(true);
  });

  test('onBeat callback is invoked', async () => {
    let callCount = 0;
    scheduler.start({
      swarmId: 'test-cb',
      intervalMs: 30,
      maxBeats: 2,
      onIdle: 'sleep',
      onBeat: () => { callCount++; },
    });
    await waitFor(() => callCount > 0);
    expect(callCount).toBeGreaterThan(0);
  });
});
