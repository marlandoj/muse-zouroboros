import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { writeFileSync, unlinkSync, existsSync } from 'fs';
import { resolveTraceId } from '../standalone/trace-bridge';

const SENTINEL = '/tmp/zo-trace-id';
const SAVED_ENV = process.env.ZO_TRACE_ID;
const SAVED_SENTINEL = existsSync(SENTINEL)
  ? require('fs').readFileSync(SENTINEL, 'utf-8')
  : null;

beforeEach(() => {
  delete process.env.ZO_TRACE_ID;
  try { unlinkSync(SENTINEL); } catch { /* ok */ }
});

afterEach(() => {
  if (SAVED_ENV === undefined) delete process.env.ZO_TRACE_ID;
  else process.env.ZO_TRACE_ID = SAVED_ENV;
  if (SAVED_SENTINEL !== null) writeFileSync(SENTINEL, SAVED_SENTINEL);
  else { try { unlinkSync(SENTINEL); } catch { /* ok */ } }
});

describe('resolveTraceId — mcp-server sentinel bridge (Q2 #1 Cycle B gap fix)', () => {
  test('returns env value when ZO_TRACE_ID is set, ignoring sentinel', () => {
    process.env.ZO_TRACE_ID = 'env-wins-1234';
    writeFileSync(SENTINEL, 'sentinel-loses-9999');
    expect(resolveTraceId()).toBe('env-wins-1234');
  });

  test('falls back to sentinel when env is unset (the production gap)', () => {
    writeFileSync(SENTINEL, 'sentinel-trace-abcd1234');
    expect(resolveTraceId()).toBe('sentinel-trace-abcd1234');
  });

  test('returns undefined when neither env nor sentinel is present', () => {
    expect(resolveTraceId()).toBeUndefined();
  });

  test('trims whitespace/newlines from sentinel content', () => {
    writeFileSync(SENTINEL, '  trimmed-trace-id\n');
    expect(resolveTraceId()).toBe('trimmed-trace-id');
  });

  test('returns undefined when sentinel exists but is empty/blank', () => {
    writeFileSync(SENTINEL, '   \n');
    expect(resolveTraceId()).toBeUndefined();
  });
});
