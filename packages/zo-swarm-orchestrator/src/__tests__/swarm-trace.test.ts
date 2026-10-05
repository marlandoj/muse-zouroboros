import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { SwarmMemory } from '../standalone/swarm-memory';

const SAVED_TRACE = process.env.ZO_TRACE_ID;
let mem: SwarmMemory;

beforeEach(() => {
  mem = new SwarmMemory(':memory:');
});

afterEach(() => {
  if (SAVED_TRACE === undefined) delete process.env.ZO_TRACE_ID;
  else process.env.ZO_TRACE_ID = SAVED_TRACE;
});

describe('SwarmMemory.createSession trace_id propagation (Q2 #1 Cycle B)', () => {
  test('writes trace_id into session metadata when ZO_TRACE_ID is set', () => {
    const traceId = '99999999-8888-7777-6666-555555555555';
    process.env.ZO_TRACE_ID = traceId;

    const session = mem.createSession('swarm-trace-1', 'session-1', { description: 'trace test' }, 3);

    expect(session.metadata.description).toBe('trace test');
    expect((session.metadata as Record<string, unknown>).trace_id).toBe(traceId);
  });

  test('does not add trace_id when ZO_TRACE_ID is unset', () => {
    delete process.env.ZO_TRACE_ID;

    const session = mem.createSession('swarm-trace-2', 'session-2', { description: 'no-trace' }, 1);

    expect(session.metadata.description).toBe('no-trace');
    expect((session.metadata as Record<string, unknown>).trace_id).toBeUndefined();
  });

  test('preserves caller metadata alongside trace_id', () => {
    const traceId = '12345678-1234-1234-1234-123456789abc';
    process.env.ZO_TRACE_ID = traceId;

    const session = mem.createSession(
      'swarm-trace-3',
      'session-3',
      { description: 'merge', initiator: 'agent-a', tags: ['x', 'y'] },
      2
    );

    expect(session.metadata.description).toBe('merge');
    expect(session.metadata.initiator).toBe('agent-a');
    expect(session.metadata.tags).toEqual(['x', 'y']);
    expect((session.metadata as Record<string, unknown>).trace_id).toBe(traceId);
  });
});
