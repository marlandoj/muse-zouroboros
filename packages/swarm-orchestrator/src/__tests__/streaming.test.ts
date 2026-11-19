import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { StreamCapture } from '../streaming/capture.js';

describe('StreamCapture', () => {
  let capture: StreamCapture;

  beforeEach(() => {
    capture = new StreamCapture({
      maxBufferBytes: 1024,
      flushIntervalMs: 60_000, // high so auto-flush doesn't interfere
      highWaterMark: 768,
      lowWaterMark: 256,
    });
  });

  afterEach(() => {
    capture.close();
  });

  test('writes and reads output', () => {
    capture.write('task-1', 'hello world');
    expect(capture.getOutput('task-1')).toBe('hello world');
  });

  test('tracks buffer size', () => {
    capture.write('task-1', 'abc');
    expect(capture.getBufferSize('task-1')).toBe(Buffer.byteLength('abc'));
  });

  test('emits chunk events', () => {
    const chunks: unknown[] = [];
    capture.on('chunk', (c) => chunks.push(c));

    capture.write('task-1', 'data');
    expect(chunks).toHaveLength(1);
  });

  test('rejects writes when buffer full', () => {
    const bigData = 'x'.repeat(1025);
    const result = capture.write('task-1', bigData);
    expect(result).toBe(false);
  });

  test('tracks dropped chunks', () => {
    const bigData = 'x'.repeat(1025);
    capture.write('task-1', bigData);
    expect(capture.getStats().droppedChunks).toBe(1);
  });

  test('signals backpressure at high water mark', () => {
    const events: Array<{ action: string }> = [];
    capture.on('backpressure', (e: { action: string }) => events.push(e));

    // Write enough to hit high water mark (768)
    capture.write('task-1', 'x'.repeat(800));
    // Pause event + auto-flush triggers resume event
    expect(events).toHaveLength(2);
    expect(events[0].action).toBe('pause');
    expect(events[1].action).toBe('resume');
    expect(capture.isBackpressured('task-1')).toBe(false);
  });

  test('flush empties buffer', async () => {
    capture.write('task-1', 'data');
    const flushed = await capture.flush('task-1');
    expect(flushed).toHaveLength(1);
    expect(capture.getBufferSize('task-1')).toBe(0);
  });

  test('flush calls onFlush callback', async () => {
    const received: unknown[] = [];
    capture.close();
    capture = new StreamCapture({
      flushIntervalMs: 60_000,
      onFlush: (chunk) => { received.push(chunk); },
    });

    capture.write('task-1', 'data');
    await capture.flush('task-1');
    expect(received).toHaveLength(1);
  });

  test('flushAll empties all task buffers', async () => {
    capture.write('task-1', 'a');
    capture.write('task-2', 'b');
    const result = await capture.flushAll();
    expect(result.size).toBe(2);
    expect(capture.getBufferSize('task-1')).toBe(0);
    expect(capture.getBufferSize('task-2')).toBe(0);
  });

  test('sequence numbers increment per task', () => {
    const chunks: Array<{ sequenceNumber: number }> = [];
    capture.on('chunk', (c: { sequenceNumber: number }) => chunks.push(c));

    capture.write('task-1', 'a');
    capture.write('task-1', 'b');
    capture.write('task-2', 'c');

    expect(chunks[0].sequenceNumber).toBe(1);
    expect(chunks[1].sequenceNumber).toBe(2);
    expect(chunks[2].sequenceNumber).toBe(1); // separate task
  });

  test('rejects writes after close', () => {
    capture.close();
    expect(capture.write('task-1', 'data')).toBe(false);
  });

  test('getStats returns accurate totals', () => {
    capture.write('task-1', 'abc');
    capture.write('task-1', 'def');

    const stats = capture.getStats();
    expect(stats.totalChunks).toBe(2);
    expect(stats.totalBytes).toBe(6);
  });

  test('handles stderr stream type', () => {
    const chunks: Array<{ streamType: string }> = [];
    capture.on('chunk', (c: { streamType: string }) => chunks.push(c));

    capture.write('task-1', 'error msg', 'stderr');
    expect(chunks[0].streamType).toBe('stderr');
  });
});
