/**
 * Streaming Capture V2
 *
 * Real-time output streaming with backpressure support.
 * Captures task output incrementally with configurable buffer limits,
 * flush intervals, and backpressure signals.
 */

import { EventEmitter } from 'events';

export interface StreamCaptureConfig {
  maxBufferBytes: number;
  flushIntervalMs: number;
  highWaterMark: number;
  lowWaterMark: number;
  onFlush?: (chunk: CapturedChunk) => void | Promise<void>;
}

export interface CapturedChunk {
  taskId: string;
  sequenceNumber: number;
  data: string;
  timestamp: number;
  streamType: 'stdout' | 'stderr';
  byteLength: number;
}

export interface StreamStats {
  totalBytes: number;
  totalChunks: number;
  droppedChunks: number;
  backpressureEvents: number;
  flushCount: number;
  startTime: number;
  lastFlushTime: number;
}

const DEFAULT_CONFIG: StreamCaptureConfig = {
  maxBufferBytes: 1024 * 1024, // 1MB
  flushIntervalMs: 500,
  highWaterMark: 768 * 1024, // 75% of max
  lowWaterMark: 256 * 1024,  // 25% of max
};

export class StreamCapture extends EventEmitter {
  private config: StreamCaptureConfig;
  private buffers: Map<string, CapturedChunk[]>;
  private bufferSizes: Map<string, number>;
  private sequences: Map<string, number>;
  private stats: StreamStats;
  private flushTimer: ReturnType<typeof setInterval> | null;
  private backpressured: Set<string>;
  private closed: boolean;

  constructor(config: Partial<StreamCaptureConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.buffers = new Map();
    this.bufferSizes = new Map();
    this.sequences = new Map();
    this.backpressured = new Set();
    this.closed = false;
    this.stats = {
      totalBytes: 0,
      totalChunks: 0,
      droppedChunks: 0,
      backpressureEvents: 0,
      flushCount: 0,
      startTime: Date.now(),
      lastFlushTime: 0,
    };

    this.flushTimer = setInterval(() => this.flushAll(), this.config.flushIntervalMs);
  }

  write(taskId: string, data: string, streamType: 'stdout' | 'stderr' = 'stdout'): boolean {
    if (this.closed) return false;

    const byteLength = Buffer.byteLength(data);
    const currentSize = this.bufferSizes.get(taskId) || 0;

    // Backpressure check
    if (currentSize + byteLength > this.config.maxBufferBytes) {
      this.stats.droppedChunks++;
      this.emit('drop', { taskId, byteLength, reason: 'buffer_full' });
      return false;
    }

    // Track sequence
    const seq = (this.sequences.get(taskId) || 0) + 1;
    this.sequences.set(taskId, seq);

    const chunk: CapturedChunk = {
      taskId,
      sequenceNumber: seq,
      data,
      timestamp: Date.now(),
      streamType,
      byteLength,
    };

    if (!this.buffers.has(taskId)) {
      this.buffers.set(taskId, []);
      this.bufferSizes.set(taskId, 0);
    }

    this.buffers.get(taskId)!.push(chunk);
    this.bufferSizes.set(taskId, currentSize + byteLength);
    this.stats.totalBytes += byteLength;
    this.stats.totalChunks++;

    this.emit('chunk', chunk);

    // High water mark — signal backpressure
    const newSize = currentSize + byteLength;
    if (newSize >= this.config.highWaterMark && !this.backpressured.has(taskId)) {
      this.backpressured.add(taskId);
      this.stats.backpressureEvents++;
      this.emit('backpressure', { taskId, bufferSize: newSize, action: 'pause' });
      // Auto-flush to relieve pressure
      this.flush(taskId);
    }

    return true;
  }

  async flush(taskId: string): Promise<CapturedChunk[]> {
    const chunks = this.buffers.get(taskId) || [];
    if (chunks.length === 0) return [];

    const flushed = [...chunks];
    this.buffers.set(taskId, []);
    this.bufferSizes.set(taskId, 0);
    this.stats.flushCount++;
    this.stats.lastFlushTime = Date.now();

    // Invoke flush callback
    if (this.config.onFlush) {
      for (const chunk of flushed) {
        await this.config.onFlush(chunk);
      }
    }

    // Low water mark — release backpressure
    if (this.backpressured.has(taskId)) {
      this.backpressured.delete(taskId);
      this.emit('backpressure', { taskId, bufferSize: 0, action: 'resume' });
    }

    this.emit('flush', { taskId, chunkCount: flushed.length });
    return flushed;
  }

  async flushAll(): Promise<Map<string, CapturedChunk[]>> {
    const result = new Map<string, CapturedChunk[]>();
    for (const taskId of this.buffers.keys()) {
      const chunks = await this.flush(taskId);
      if (chunks.length > 0) {
        result.set(taskId, chunks);
      }
    }
    return result;
  }

  getOutput(taskId: string): string {
    const chunks = this.buffers.get(taskId) || [];
    return chunks.map(c => c.data).join('');
  }

  isBackpressured(taskId: string): boolean {
    return this.backpressured.has(taskId);
  }

  getStats(): StreamStats {
    return { ...this.stats };
  }

  getBufferSize(taskId: string): number {
    return this.bufferSizes.get(taskId) || 0;
  }

  close(): void {
    this.closed = true;
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flushAll();
    this.removeAllListeners();
  }
}
