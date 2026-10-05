import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generatePrespecWithOverflow,
  isEligibleZoOverflowFailure,
  parseModalOverflowRuntime,
  reserveModalBudget,
  ZoRequestPool,
  type ModalOverflowRuntime,
} from "./modal-generation";
import type { AskAttempt } from "./model-chain";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function runtime(overrides: Partial<ModalOverflowRuntime> = {}): ModalOverflowRuntime {
  const directory = mkdtempSync(join(tmpdir(), "modal-overflow-test-"));
  directories.push(directory);
  return {
    schemaVersion: 1,
    enabled: true,
    endpointName: "zouroboros-qwen-overflow",
    endpointId: "ep-test",
    endpointUrl: "https://example.modal.run",
    model: "Qwen/Qwen3.6-35B-A3B",
    authorization: "Bearer redacted",
    allowedWorkloads: ["benchmark", "factory-prespec"],
    prespecClassification: "internal",
    maxConcurrency: 6,
    maxAttempts: 2,
    estimatedUsdPerSecond: 0.002,
    aggregateBudgetUsd: 10,
    perCallReservationUsd: 0.25,
    budgetLedgerPath: join(directory, "budget.jsonl"),
    circuitFailureThreshold: 3,
    circuitResetMs: 60_000,
    ...overrides,
  };
}

function zoError(trail: AskAttempt[]): Error {
  const error = new Error("/zo/ask exhausted") as Error & { trail: AskAttempt[] };
  error.trail = trail;
  return error;
}

describe("Modal pre-spec overflow", () => {
  test("validates the fail-closed runtime contract", () => {
    expect(parseModalOverflowRuntime(runtime()).endpointName).toBe("zouroboros-qwen-overflow");
    expect(() => parseModalOverflowRuntime({ ...runtime(), authorization: "" })).toThrow("authorization");
    expect(() => parseModalOverflowRuntime({ ...runtime(), prespecClassification: "sensitive" })).toThrow("classification");
    expect(parseModalOverflowRuntime({ ...runtime(), allowedWorkloads: ["memory-summarization"] }).allowedWorkloads).toEqual(["memory-summarization"]);
  });

  test("classifies only capacity, timeout, and non-policy 5xx failures as eligible", () => {
    expect(isEligibleZoOverflowFailure(zoError([{ model: "x", attempt: 1, status: null, ok: false, detail: "TimeoutError" }]))).toBe(true);
    expect(isEligibleZoOverflowFailure(zoError([{ model: "x", attempt: 1, status: 429, ok: false, detail: "workspace request limit reached" }]))).toBe(true);
    expect(isEligibleZoOverflowFailure(zoError([{ model: "x", attempt: 1, status: 503, ok: false, detail: "upstream unavailable" }]))).toBe(true);
    expect(isEligibleZoOverflowFailure(zoError([{ model: "x", attempt: 1, status: 429, ok: false, detail: "provider rate limit" }]))).toBe(false);
    expect(isEligibleZoOverflowFailure(zoError([{ model: "x", attempt: 1, status: 502, ok: false, detail: "insufficient balance" }]))).toBe(false);
    expect(isEligibleZoOverflowFailure(new Error("plain error"))).toBe(false);
  });

  test("preserves the Zo path exactly when Modal is disabled", async () => {
    let zoCalls = 0;
    const result = await generatePrespecWithOverflow({
      input: "prompt",
      runtime: null,
      zoCall: async () => {
        zoCalls += 1;
        return { output: "zo", model: "byok:test", trail: [] };
      },
    });
    expect(result.output).toBe("zo");
    expect(zoCalls).toBe(1);
  });

  test("preserves the Zo path when factory pre-spec is not allowlisted", async () => {
    const pool = new ZoRequestPool(1);
    const heldRelease = pool.tryAcquire();
    let modalCalls = 0;
    const resultPromise = generatePrespecWithOverflow({
      input: "prompt",
      runtime: runtime({ allowedWorkloads: ["memory-summarization"] }),
      zoPool: pool,
      zoCall: async () => ({ output: "zo", model: "byok:test", trail: [] }),
      modalClient: { complete: async () => { modalCalls += 1; throw new Error("must not run"); } },
    });
    await Bun.sleep(5);
    heldRelease?.();
    const result = await resultPromise;
    expect(result.output).toBe("zo");
    expect(modalCalls).toBe(0);
  });

  test("overflows a fourth concurrent request directly without calling Zo", async () => {
    const pool = new ZoRequestPool(1);
    const heldRelease = pool.tryAcquire();
    expect(heldRelease).not.toBeNull();
    let zoCalls = 0;
    let modalCalls = 0;
    const rt = runtime();
    const result = await generatePrespecWithOverflow({
      input: "prompt",
      runtime: rt,
      zoPool: pool,
      zoCall: async () => { zoCalls += 1; throw new Error("must not run"); },
      reserveBudget: async () => ({
        schemaVersion: 1,
        reservationId: "prespec:test",
        endpointId: rt.endpointId,
        workload: "factory-prespec",
        amountUsd: 0.25,
        reservedAt: new Date().toISOString(),
      }),
      modalClient: {
        complete: async () => {
          modalCalls += 1;
          return { content: "modal", model: rt.model, latencyMs: 10, estimatedCostUsd: 0.001, attempts: 1 };
        },
      },
    });
    heldRelease?.();
    expect(result.output).toBe("modal");
    expect(zoCalls).toBe(0);
    expect(modalCalls).toBe(1);
  });

  test("does not overflow authentication or provider-credit failures", async () => {
    let modalCalls = 0;
    const rt = runtime();
    await expect(generatePrespecWithOverflow({
      input: "prompt",
      runtime: rt,
      zoCall: async () => { throw zoError([{ model: "x", attempt: 1, status: 502, ok: false, detail: "insufficient balance" }]); },
      modalClient: { complete: async () => { modalCalls += 1; throw new Error("must not run"); } },
    })).rejects.toThrow("/zo/ask exhausted");
    expect(modalCalls).toBe(0);
  });

  test("reserves budget idempotently and fails before exceeding the aggregate cap", async () => {
    const rt = runtime({ aggregateBudgetUsd: 0.5, perCallReservationUsd: 0.25 });
    const first = await reserveModalBudget(rt, "prespec:budget-01");
    const duplicate = await reserveModalBudget(rt, "prespec:budget-01");
    await reserveModalBudget(rt, "summary:budget-02", new Date(), "memory-summarization");
    await expect(reserveModalBudget(rt, "prespec:budget-03")).rejects.toMatchObject({ code: "budget" });
    expect(duplicate).toEqual(first);
    const entries = readFileSync(rt.budgetLedgerPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(entries).toHaveLength(2);
    expect(entries[1].workload).toBe("memory-summarization");
  });
});
