/**
 * Circuit Breaker V2 implementation
 * 
 * Provides resilient executor management with CLOSED/OPEN/HALF_OPEN states,
 * category-aware failure tracking, and exponential backoff.
 */

import type { CircuitBreakerState, ErrorCategory } from '../types.js';

const CB_MAX_COOLDOWN_MS = 300_000; // 5 min cap
const CB_BACKOFF_MULTIPLIER = 2.0;

export const ERROR_CATEGORIES: ErrorCategory[] = [
  'timeout',
  'rate_limited',
  'permission_denied',
  'context_overflow',
  'mutation_failed',
  'syntax_error',
  'runtime_error',
  'unknown',
];

const CB_FAILURE_THRESHOLDS: Record<ErrorCategory, number> = {
  timeout: 2,
  rate_limited: 1,
  permission_denied: 1,
  context_overflow: 2,
  mutation_failed: 3,
  syntax_error: 3,
  runtime_error: 3,
  unknown: 3,
};

const CB_BASE_COOLDOWN_MS: Record<ErrorCategory, number> = {
  rate_limited: 60_000,
  permission_denied: 300_000,
  timeout: 30_000,
  context_overflow: 30_000,
  mutation_failed: 15_000,
  syntax_error: 15_000,
  runtime_error: 15_000,
  unknown: 30_000,
};

export class CircuitBreaker {
  private state: CircuitBreakerState;
  private baseCooldownMs: number;

  constructor(baseCooldownMs: number = 30_000) {
    this.baseCooldownMs = baseCooldownMs;
    this.state = {
      state: 'CLOSED',
      failures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastFailure: 0,
      lastSuccess: 0,
      cooldownMs: baseCooldownMs,
      probeInFlight: false,
      failureCategories: new Map(),
    };
  }

  canAttempt(): boolean {
    if (this.state.state === 'CLOSED') return true;
    
    if (this.state.state === 'OPEN') {
      if (Date.now() - this.state.lastFailure > this.state.cooldownMs) {
        this.state.state = 'HALF_OPEN';
        this.state.probeInFlight = false;
        return !this.state.probeInFlight;
      }
      return false;
    }
    
    if (this.state.state === 'HALF_OPEN') {
      return !this.state.probeInFlight;
    }
    
    return false;
  }

  recordSuccess(): void {
    this.state.failures = 0;
    this.state.totalSuccesses = (this.state.totalSuccesses ?? 0) + 1;
    this.state.lastSuccess = Date.now();
    
    if (this.state.state === 'HALF_OPEN') {
      this.state.state = 'CLOSED';
      this.state.cooldownMs = this.baseCooldownMs;
    }
    
    this.state.probeInFlight = false;
  }

  recordFailure(category: ErrorCategory = 'unknown'): void {
    this.state.failures++;
    this.state.totalFailures++;
    this.state.lastFailure = Date.now();
    
    const currentCount = this.state.failureCategories.get(category) || 0;
    this.state.failureCategories.set(category, currentCount + 1);
    
    const threshold = CB_FAILURE_THRESHOLDS[category] || 3;
    const baseCooldown = CB_BASE_COOLDOWN_MS[category] || this.baseCooldownMs;
    
    if (this.state.failures >= threshold) {
      this.state.state = 'OPEN';
      this.state.cooldownMs = Math.min(
        CB_MAX_COOLDOWN_MS,
        baseCooldown * Math.pow(CB_BACKOFF_MULTIPLIER, this.state.failures - threshold)
      );
    }
    
    this.state.probeInFlight = false;
  }

  getState(): CircuitBreakerState {
    return { ...this.state };
  }

  reset(): void {
    this.state = {
      state: 'CLOSED',
      failures: 0,
      totalFailures: 0,
      totalSuccesses: 0,
      lastFailure: 0,
      lastSuccess: 0,
      cooldownMs: this.baseCooldownMs,
      probeInFlight: false,
      failureCategories: new Map(),
    };
  }
}

export class CircuitBreakerRegistry {
  private breakers: Map<string, CircuitBreaker> = new Map();

  get(executorId: string): CircuitBreaker {
    if (!this.breakers.has(executorId)) {
      this.breakers.set(executorId, new CircuitBreaker());
    }
    return this.breakers.get(executorId)!;
  }

  resetAll(): void {
    for (const breaker of this.breakers.values()) {
      breaker.reset();
    }
  }

  getStatus(): Record<string, CircuitBreakerState> {
    const status: Record<string, CircuitBreakerState> = {};
    for (const [id, breaker] of this.breakers) {
      status[id] = breaker.getState();
    }
    return status;
  }
}
