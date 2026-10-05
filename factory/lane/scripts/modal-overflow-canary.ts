#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ModalOpenAIClient, type ModalGenerationResult } from "../../../packages/modal-exec/src/modal-openai-client";
import {
  generatePrespecWithOverflow,
  isEligibleZoOverflowFailure,
  loadModalOverflowRuntime,
  reserveModalBudget,
  ZoRequestPool,
} from "./modal-generation";
import type { AskAttempt } from "./model-chain";

const OUTPUT_DIR = join(import.meta.dir, "..", "modal-open-weight-overflow-2026-08-15", "evaluations");
const JSON_PATH = join(OUTPUT_DIR, "modal-overflow-canary.json");
const MARKDOWN_PATH = join(OUTPUT_DIR, "modal-overflow-canary.md");
const PROMPT_COUNT = 30;
const CONCURRENCY = 6;

interface PromptResult {
  index: number;
  expected: string;
  valid: boolean;
  latencyMs: number;
  estimatedCostUsd: number;
  attempts: number;
  promptTokens: number | null;
  completionTokens: number | null;
  responseSha256: string;
  error?: string;
}

function fakeZoError(status: number | null, detail: string): Error {
  const error = new Error("/zo/ask exhausted") as Error & { trail: AskAttempt[] };
  error.trail = [{ model: "test", attempt: 1, status, ok: false, detail }];
  return error;
}

async function runBounded<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= tasks.length) return;
      results[index] = await tasks[index]();
    }
  }));
  return results;
}

function resultRow(index: number, expected: string, result: ModalGenerationResult): PromptResult {
  return {
    index,
    expected,
    valid: result.content.trim() === expected,
    latencyMs: result.latencyMs,
    estimatedCostUsd: result.estimatedCostUsd,
    attempts: result.attempts,
    promptTokens: result.usage?.promptTokens ?? null,
    completionTokens: result.usage?.completionTokens ?? null,
    responseSha256: createHash("sha256").update(result.content).digest("hex"),
  };
}

async function main(): Promise<void> {
  const runtime = loadModalOverflowRuntime();
  if (!runtime) throw new Error("Modal overflow runtime is unavailable");
  const client = new ModalOpenAIClient({
    enabled: true,
    baseUrl: runtime.endpointUrl,
    model: runtime.model,
    authorization: runtime.authorization,
    allowedWorkloads: new Set(["benchmark", "factory-prespec"]),
    maxConcurrency: runtime.maxConcurrency,
    maxAttempts: runtime.maxAttempts,
    estimatedUsdPerSecond: runtime.estimatedUsdPerSecond,
    circuitFailureThreshold: runtime.circuitFailureThreshold,
    circuitResetMs: runtime.circuitResetMs,
  });

  const unauthorized = await fetch(`${runtime.endpointUrl}/v1/models`);
  const tasks = Array.from({ length: PROMPT_COUNT }, (_, index) => async (): Promise<PromptResult> => {
    const expected = `ZO_MODAL_${index.toString().padStart(2, "0")}`;
    const reservationId = `canary:${expected}`;
    await reserveModalBudget(runtime, reservationId);
    try {
      const result = await client.complete({
        workload: "benchmark",
        classification: "public",
        messages: [{ role: "user", content: `Respond with exactly ${expected} and no other text.` }],
        idempotencyKey: `benchmark:${expected}`,
        maxTokens: 32,
        timeoutMs: 120_000,
        maxEstimatedCostUsd: runtime.perCallReservationUsd,
        canonicalWrites: false,
        externalMutations: false,
        temperature: 0,
      });
      return resultRow(index, expected, result);
    } catch (error) {
      return {
        index,
        expected,
        valid: false,
        latencyMs: 0,
        estimatedCostUsd: 0,
        attempts: 0,
        promptTokens: null,
        completionTokens: null,
        responseSha256: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });

  const cold = await tasks[0]();
  const concurrent = await runBounded(tasks.slice(1), CONCURRENCY);
  const prompts = [cold, ...concurrent];

  const pool = new ZoRequestPool(1);
  const release = pool.tryAcquire();
  if (!release) throw new Error("failed to prepare saturated Zo pool");
  let productionZoCalls = 0;
  const productionPrompt = "Respond with exactly ZO_MODAL_PRODUCTION_PATH and no other text.";
  const productionResult = await generatePrespecWithOverflow({
    input: productionPrompt,
    runtime,
    zoPool: pool,
    zoCall: async () => {
      productionZoCalls += 1;
      throw new Error("Zo must not be called while the local capacity cap is saturated");
    },
    modalClient: client,
  }).finally(release);

  const valid = prompts.filter((result) => result.valid).length;
  const estimatedCostUsd = prompts.reduce((total, result) => total + result.estimatedCostUsd, 0);
  const reservationUsd = (PROMPT_COUNT + 1) * runtime.perCallReservationUsd;
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    endpoint: {
      name: runtime.endpointName,
      id: runtime.endpointId,
      model: runtime.model,
      url: runtime.endpointUrl,
      authenticated: unauthorized.status === 401 || unauthorized.status === 403,
      anonymousStatus: unauthorized.status,
    },
    contract: {
      promptCount: PROMPT_COUNT,
      concurrency: CONCURRENCY,
      requiredValid: 29,
      aggregateBudgetUsd: runtime.aggregateBudgetUsd,
      reservationUsd,
      estimatedCostUsd,
      zoCallsOnModalLane: 0,
    },
    results: {
      valid,
      invalid: PROMPT_COUNT - valid,
      coldStartLatencyMs: cold.latencyMs,
      maxLatencyMs: Math.max(...prompts.map((result) => result.latencyMs)),
      productionPath: {
        valid: productionResult.output.trim() === "ZO_MODAL_PRODUCTION_PATH",
        model: productionResult.model,
        zoCalls: productionZoCalls,
      },
      failureTaxonomy: {
        workspaceCapacityEligible: isEligibleZoOverflowFailure(fakeZoError(429, "workspace request limit reached")),
        timeoutEligible: isEligibleZoOverflowFailure(fakeZoError(null, "TimeoutError")),
        providerRateLimitIneligible: !isEligibleZoOverflowFailure(fakeZoError(429, "provider rate limit")),
        creditsIneligible: !isEligibleZoOverflowFailure(fakeZoError(502, "insufficient balance")),
      },
    },
    prompts,
    passed: valid >= 29
      && reservationUsd <= runtime.aggregateBudgetUsd
      && (unauthorized.status === 401 || unauthorized.status === 403)
      && productionResult.output.trim() === "ZO_MODAL_PRODUCTION_PATH"
      && productionZoCalls === 0,
  };

  mkdirSync(OUTPUT_DIR, { recursive: true });
  writeFileSync(JSON_PATH, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(MARKDOWN_PATH, `# Modal Open-Weight Overflow Canary

**Date:** ${report.generatedAt}
**Status:** ${report.passed ? "PASS" : "FAIL"}
**Endpoint:** ${runtime.endpointName}
**Model:** ${runtime.model}

## Results

| Metric | Result |
|---|---:|
| Valid deterministic prompts | ${valid}/${PROMPT_COUNT} |
| Concurrency | ${CONCURRENCY} |
| Cold-start latency | ${cold.latencyMs} ms |
| Maximum latency | ${report.results.maxLatencyMs} ms |
| Anonymous request status | HTTP ${unauthorized.status} |
| Zo calls on direct Modal lane | 0 |
| Production pre-spec-path Zo calls while saturated | ${productionZoCalls} |
| Conservative budget reserved | $${reservationUsd.toFixed(2)} / $${runtime.aggregateBudgetUsd.toFixed(2)} |
| Runtime cost estimate | $${estimatedCostUsd.toFixed(4)} |

## Failure Injection

- Workspace-capacity 429: ${report.results.failureTaxonomy.workspaceCapacityEligible ? "overflow eligible" : "incorrectly blocked"}
- Timeout/network failure: ${report.results.failureTaxonomy.timeoutEligible ? "overflow eligible" : "incorrectly blocked"}
- Provider-specific 429: ${report.results.failureTaxonomy.providerRateLimitIneligible ? "held" : "incorrectly overflowed"}
- Credit failure wrapped by 502: ${report.results.failureTaxonomy.creditsIneligible ? "held" : "incorrectly overflowed"}

The direct lane used the same \`ModalOpenAIClient\` and \`generatePrespecWithOverflow\` production functions as the activated consumer. Prompt bodies, credentials, and response text were not written to the report; only expected public tokens, hashes, usage, latency, and cost estimates were retained.
`);
  console.log(JSON.stringify({ passed: report.passed, valid, promptCount: PROMPT_COUNT, productionZoCalls, reservationUsd, estimatedCostUsd, json: JSON_PATH, markdown: MARKDOWN_PATH }));
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.main) await main();
