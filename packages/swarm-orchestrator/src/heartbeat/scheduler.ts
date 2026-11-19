/**
 * Heartbeat Scheduler — persistent agent wake cycles for swarm patterns.
 *
 * Simple setInterval + SQLite persistence. Each beat checks for
 * pending/failed tasks, re-dispatches, and emits SSE events.
 */

import { getDb } from '../db/schema.js';
import type { Database } from 'bun:sqlite';

export interface HeartbeatConfig {
  swarmId: string;
  intervalMs: number;
  maxBeats: number;
  onIdle: 'sleep' | 'stop';
  onBeat?: (beat: HeartbeatEvent) => void | Promise<void>;
}

export interface HeartbeatEvent {
  swarmId: string;
  beatNumber: number;
  status: 'ok' | 'idle' | 'max_reached' | 'stopped';
  tasksDispatched: number;
  tasksFailed: number;
  timestamp: number;
}

type HeartbeatListener = (event: HeartbeatEvent) => void;

export class HeartbeatScheduler {
  private db: Database;
  private timers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private beatCounts: Map<string, number> = new Map();
  private listeners: HeartbeatListener[] = [];

  constructor(dbPath?: string) {
    this.db = getDb(dbPath);
  }

  on(listener: HeartbeatListener): void {
    this.listeners.push(listener);
  }

  private emit(event: HeartbeatEvent): void {
    for (const listener of this.listeners) {
      try { listener(event); } catch {}
    }
  }

  start(config: HeartbeatConfig): void {
    if (this.timers.has(config.swarmId)) {
      this.stop(config.swarmId);
    }

    this.beatCounts.set(config.swarmId, 0);

    const timer = setInterval(async () => {
      const beatNum = (this.beatCounts.get(config.swarmId) ?? 0) + 1;
      this.beatCounts.set(config.swarmId, beatNum);

      if (config.maxBeats > 0 && beatNum > config.maxBeats) {
        const event: HeartbeatEvent = {
          swarmId: config.swarmId,
          beatNumber: beatNum,
          status: 'max_reached',
          tasksDispatched: 0,
          tasksFailed: 0,
          timestamp: Date.now(),
        };
        this.persist(event);
        this.emit(event);
        this.stop(config.swarmId);
        return;
      }

      const event: HeartbeatEvent = {
        swarmId: config.swarmId,
        beatNumber: beatNum,
        status: 'ok',
        tasksDispatched: 0,
        tasksFailed: 0,
        timestamp: Date.now(),
      };

      if (config.onBeat) {
        try {
          await config.onBeat(event);
        } catch (err) {
          event.status = 'idle';
        }
      }

      this.persist(event);
      this.emit(event);

      if (event.status === 'idle' && config.onIdle === 'stop') {
        this.stop(config.swarmId);
      }
    }, config.intervalMs);

    this.timers.set(config.swarmId, timer);
  }

  stop(swarmId: string): void {
    const timer = this.timers.get(swarmId);
    if (timer) {
      clearInterval(timer);
      this.timers.delete(swarmId);
    }

    const beatNum = this.beatCounts.get(swarmId) ?? 0;
    const event: HeartbeatEvent = {
      swarmId,
      beatNumber: beatNum,
      status: 'stopped',
      tasksDispatched: 0,
      tasksFailed: 0,
      timestamp: Date.now(),
    };
    this.persist(event);
    this.emit(event);
  }

  isRunning(swarmId: string): boolean {
    return this.timers.has(swarmId);
  }

  getBeatCount(swarmId: string): number {
    return this.beatCounts.get(swarmId) ?? 0;
  }

  getHistory(swarmId: string, limit: number = 50): HeartbeatEvent[] {
    const rows = this.db.query(
      `SELECT swarm_id, beat_number, status, tasks_dispatched, tasks_failed, created_at
       FROM swarm_heartbeats WHERE swarm_id = ? ORDER BY id DESC LIMIT ?`
    ).all(swarmId, limit) as Array<{
      swarm_id: string; beat_number: number; status: string;
      tasks_dispatched: number; tasks_failed: number; created_at: number;
    }>;

    return rows.map(r => ({
      swarmId: r.swarm_id,
      beatNumber: r.beat_number,
      status: r.status as HeartbeatEvent['status'],
      tasksDispatched: r.tasks_dispatched,
      tasksFailed: r.tasks_failed,
      timestamp: r.created_at * 1000,
    }));
  }

  stopAll(): void {
    for (const swarmId of this.timers.keys()) {
      this.stop(swarmId);
    }
  }

  private persist(event: HeartbeatEvent): void {
    this.db.run(
      `INSERT INTO swarm_heartbeats (swarm_id, beat_number, status, tasks_dispatched, tasks_failed)
       VALUES (?, ?, ?, ?, ?)`,
      [event.swarmId, event.beatNumber, event.status, event.tasksDispatched, event.tasksFailed]
    );
  }
}
