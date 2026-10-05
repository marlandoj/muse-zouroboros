/**
 * Stagnation Detection
 *
 * Monitors task execution for stalls and triggers automatic recovery actions.
 * Detects: no-output stalls, repetitive output loops, and progress plateaus.
 */

export type StagnationType = 'no_output' | 'repetitive_output' | 'progress_plateau' | 'timeout_approaching';
export type RecoveryAction = 'retry' | 'escalate' | 'skip' | 'abort' | 'nudge';

export interface StagnationConfig {
  noOutputThresholdMs: number;
  repetitionWindowSize: number;
  repetitionThreshold: number;
  progressCheckIntervalMs: number;
  timeoutWarningPercent: number;
  maxRecoveryAttempts: number;
  onStagnation?: (event: StagnationEvent) => void | Promise<void>;
}

export interface StagnationEvent {
  taskId: string;
  type: StagnationType;
  detectedAt: number;
  durationMs: number;
  recoveryAction: RecoveryAction;
  recoveryAttempt: number;
  details: string;
}

export interface TaskMonitorState {
  taskId: string;
  startTime: number;
  lastOutputTime: number;
  outputHistory: string[];
  progressSnapshots: number[];
  recoveryAttempts: number;
  stagnationEvents: StagnationEvent[];
  timeoutMs: number;
}

const DEFAULT_CONFIG: StagnationConfig = {
  noOutputThresholdMs: 60_000,        // 1 min without output
  repetitionWindowSize: 5,            // check last 5 outputs
  repetitionThreshold: 0.8,           // 80% similarity = repetitive
  progressCheckIntervalMs: 30_000,    // check every 30s
  timeoutWarningPercent: 80,          // warn at 80% of timeout
  maxRecoveryAttempts: 3,
};

export class StagnationDetector {
  private config: StagnationConfig;
  private monitors: Map<string, TaskMonitorState>;
  private checkTimers: Map<string, ReturnType<typeof setInterval>>;

  constructor(config: Partial<StagnationConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.monitors = new Map();
    this.checkTimers = new Map();
  }

  startMonitoring(taskId: string, timeoutMs: number): void {
    const state: TaskMonitorState = {
      taskId,
      startTime: Date.now(),
      lastOutputTime: Date.now(),
      outputHistory: [],
      progressSnapshots: [0],
      recoveryAttempts: 0,
      stagnationEvents: [],
      timeoutMs,
    };

    this.monitors.set(taskId, state);

    const timer = setInterval(() => this.check(taskId), this.config.progressCheckIntervalMs);
    this.checkTimers.set(taskId, timer);
  }

  recordOutput(taskId: string, output: string): void {
    const state = this.monitors.get(taskId);
    if (!state) return;

    state.lastOutputTime = Date.now();
    state.outputHistory.push(output.slice(0, 200)); // keep last 200 chars per output

    // Keep window bounded
    if (state.outputHistory.length > this.config.repetitionWindowSize * 2) {
      state.outputHistory = state.outputHistory.slice(-this.config.repetitionWindowSize * 2);
    }
  }

  recordProgress(taskId: string, progressPercent: number): void {
    const state = this.monitors.get(taskId);
    if (!state) return;

    state.progressSnapshots.push(progressPercent);

    // Keep bounded
    if (state.progressSnapshots.length > 20) {
      state.progressSnapshots = state.progressSnapshots.slice(-20);
    }
  }

  check(taskId: string): StagnationEvent | null {
    const state = this.monitors.get(taskId);
    if (!state) return null;

    const now = Date.now();

    // Check 1: No output stall
    const silenceMs = now - state.lastOutputTime;
    if (silenceMs > this.config.noOutputThresholdMs) {
      return this.raiseStagnation(state, 'no_output', silenceMs,
        `No output for ${Math.round(silenceMs / 1000)}s`);
    }

    // Check 2: Repetitive output
    if (state.outputHistory.length >= this.config.repetitionWindowSize) {
      const window = state.outputHistory.slice(-this.config.repetitionWindowSize);
      const uniqueRatio = new Set(window).size / window.length;
      if (uniqueRatio <= (1 - this.config.repetitionThreshold)) {
        return this.raiseStagnation(state, 'repetitive_output', silenceMs,
          `Repetitive output detected: ${Math.round((1 - uniqueRatio) * 100)}% identical in last ${window.length} outputs`);
      }
    }

    // Check 3: Progress plateau
    if (state.progressSnapshots.length >= 4) {
      const recent = state.progressSnapshots.slice(-4);
      const spread = Math.max(...recent) - Math.min(...recent);
      if (spread < 1 && recent[0] > 0 && recent[0] < 100) {
        return this.raiseStagnation(state, 'progress_plateau', silenceMs,
          `Progress stuck at ${recent[0]}% for ${recent.length} checks`);
      }
    }

    // Check 4: Timeout approaching
    const elapsed = now - state.startTime;
    const percentUsed = (elapsed / state.timeoutMs) * 100;
    if (percentUsed >= this.config.timeoutWarningPercent) {
      const alreadyWarned = state.stagnationEvents.some(e => e.type === 'timeout_approaching');
      if (!alreadyWarned) {
        return this.raiseStagnation(state, 'timeout_approaching', elapsed,
          `${Math.round(percentUsed)}% of timeout used (${Math.round(elapsed / 1000)}s / ${Math.round(state.timeoutMs / 1000)}s)`);
      }
    }

    return null;
  }

  private raiseStagnation(
    state: TaskMonitorState,
    type: StagnationType,
    durationMs: number,
    details: string
  ): StagnationEvent {
    state.recoveryAttempts++;

    const action = this.selectRecoveryAction(type, state.recoveryAttempts);
    const event: StagnationEvent = {
      taskId: state.taskId,
      type,
      detectedAt: Date.now(),
      durationMs,
      recoveryAction: action,
      recoveryAttempt: state.recoveryAttempts,
      details,
    };

    state.stagnationEvents.push(event);

    if (this.config.onStagnation) {
      this.config.onStagnation(event);
    }

    return event;
  }

  private selectRecoveryAction(type: StagnationType, attempt: number): RecoveryAction {
    if (attempt > this.config.maxRecoveryAttempts) return 'abort';

    switch (type) {
      case 'no_output':
        return attempt <= 1 ? 'nudge' : attempt <= 2 ? 'retry' : 'escalate';
      case 'repetitive_output':
        return attempt <= 1 ? 'nudge' : 'escalate';
      case 'progress_plateau':
        return attempt <= 2 ? 'retry' : 'skip';
      case 'timeout_approaching':
        return 'nudge';
    }
  }

  getState(taskId: string): TaskMonitorState | undefined {
    return this.monitors.get(taskId);
  }

  getEvents(taskId: string): StagnationEvent[] {
    return this.monitors.get(taskId)?.stagnationEvents || [];
  }

  stopMonitoring(taskId: string): StagnationEvent[] {
    const events = this.getEvents(taskId);
    this.monitors.delete(taskId);

    const timer = this.checkTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.checkTimers.delete(taskId);
    }

    return events;
  }

  stopAll(): void {
    for (const taskId of this.monitors.keys()) {
      this.stopMonitoring(taskId);
    }
  }
}
