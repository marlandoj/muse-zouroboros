/**
 * D3 — ACP Usage field regression tests.
 *
 * Goal: assert that `parseAcpUsage()` (the extracted helper) correctly surfaces
 * `inputTokens` and `outputTokens` as present, numeric values when the ACP SDK
 * populates the Usage field, and returns `undefined` in all degenerate cases.
 *
 * These tests run entirely against fixture data — no live ACP session required.
 *
 * ACP SDK version pinned: @agentclientprotocol/sdk@0.18.0
 * Usage field status: UNSTABLE / @experimental (may be removed without notice).
 *
 * Cache-token semantics (SDK types.gen.d.ts, v0.18.0, line 5088):
 *
 *   export type Usage = {
 *     cachedReadTokens?:  number | null;   // cache-read tokens (SEPARATE field)
 *     cachedWriteTokens?: number | null;   // cache-write tokens (SEPARATE field)
 *     inputTokens:        number;          // billable input, cache excluded
 *     outputTokens:       number;          // generated output tokens
 *     thoughtTokens?:     number | null;   // reasoning/thinking tokens
 *     totalTokens:        number;
 *   };
 *
 * Key implication: `inputTokens` does NOT include cache_creation tokens.
 * Cache tokens are surfaced via `cachedReadTokens` / `cachedWriteTokens`.
 * As a result, the sum `inputTokens + outputTokens` will undercount total billed
 * spend when cache-write (creation) tokens are significant — on long contexts they
 * can be 10-20× larger than the prompt input tokens alone. This is the primary
 * motivation for D4's SWARM_FORCE_TRANSPORT=bridge path, which reads the CLI's
 * `total_cost_usd` directly and correctly accounts for cache tokens.
 */

import { describe, test, expect } from 'bun:test';
import { parseAcpUsage } from '../transport/acp-transport.js';

describe('parseAcpUsage — D3 regression', () => {
  // ── happy path ────────────────────────────────────────────────────────────

  test('returns inputTokens and outputTokens as present numeric values', () => {
    const promptResult = {
      stopReason: 'end_turn',
      usage: { inputTokens: 1200, outputTokens: 340, totalTokens: 1540 },
    };
    const result = parseAcpUsage(promptResult);
    expect(typeof result.inputTokens).toBe('number');
    expect(typeof result.outputTokens).toBe('number');
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(340);
  });

  test('tokensUsed equals inputTokens + outputTokens', () => {
    const promptResult = {
      usage: { inputTokens: 800, outputTokens: 200, totalTokens: 1000 },
    };
    const { inputTokens, outputTokens, tokensUsed } = parseAcpUsage(promptResult);
    expect(tokensUsed).toBe((inputTokens ?? 0) + (outputTokens ?? 0));
    expect(tokensUsed).toBe(1000);
  });

  test('cache tokens present in usage do not inflate inputTokens', () => {
    // Verify the helper only reads inputTokens/outputTokens — cache fields
    // are ignored by parseAcpUsage (they're separate billing line-items).
    const promptResult = {
      usage: {
        inputTokens: 500,
        outputTokens: 150,
        totalTokens: 650,
        cachedReadTokens: 8000,   // large cache read — should NOT appear in inputTokens
        cachedWriteTokens: 12000, // large cache write — should NOT appear in inputTokens
      },
    };
    const { inputTokens, outputTokens } = parseAcpUsage(promptResult);
    expect(inputTokens).toBe(500);   // unchanged by cache fields
    expect(outputTokens).toBe(150);
  });

  // ── degenerate / missing cases ────────────────────────────────────────────

  test('usage field absent → all undefined', () => {
    const promptResult = { stopReason: 'end_turn' };
    const result = parseAcpUsage(promptResult);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.tokensUsed).toBeUndefined();
  });

  test('usage field null → all undefined', () => {
    const promptResult = { usage: null };
    const result = parseAcpUsage(promptResult);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.tokensUsed).toBeUndefined();
  });

  test('usage.inputTokens is zero → treated as absent (undefined)', () => {
    // Zero typically indicates the usage_update notification was not fired
    // for this session (not a valid reading of 0 real tokens processed).
    const promptResult = {
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
    const result = parseAcpUsage(promptResult);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.tokensUsed).toBeUndefined();
  });

  test('inputTokens present but outputTokens zero → tokensUsed = inputTokens', () => {
    const promptResult = {
      usage: { inputTokens: 600, outputTokens: 0, totalTokens: 600 },
    };
    const { inputTokens, outputTokens, tokensUsed } = parseAcpUsage(promptResult);
    expect(inputTokens).toBe(600);
    expect(outputTokens).toBeUndefined();  // zero → absent
    expect(tokensUsed).toBe(600);
  });

  test('usage.inputTokens is non-numeric string → all undefined', () => {
    const promptResult = {
      usage: { inputTokens: 'twelve hundred', outputTokens: 'unknown' },
    };
    const result = parseAcpUsage(promptResult as unknown as object);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.tokensUsed).toBeUndefined();
  });

  test('null promptResult → all undefined (no crash)', () => {
    const result = parseAcpUsage(null);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.tokensUsed).toBeUndefined();
  });

  test('undefined promptResult → all undefined (no crash)', () => {
    const result = parseAcpUsage(undefined);
    expect(result.inputTokens).toBeUndefined();
    expect(result.outputTokens).toBeUndefined();
    expect(result.tokensUsed).toBeUndefined();
  });
});
