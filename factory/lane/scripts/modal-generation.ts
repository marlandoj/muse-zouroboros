import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  ModalGenerationError,
  ModalOpenAIClient,
  type ModalDataClassification,
  type ModalGenerationResult,
  type ModalGenerationWorkload,
  type ModalOpenAIClientConfig,
} from "../../../packages/modal-exec/src/modal-openai-client";
import type { AskAttempt, AskResult } from "./model-chain";

export const MODAL_OVERFLOW_CONFIG_ENV = "FACTORY_MODAL_OVERFLOW_CONFIG";
export const DEFAULT_MODAL_OVERFLOW_CONFIG = "/root/.zouroboros/modal-overflow-runtime.json";
export const FACTORY_ZO_REQUEST_LIMIT = 3;

export interface ModalOverflowRuntime {
  schemaVersion: 1;
  enabled: boolean;
  endpointName: string;
  endpointId: string;
  endpointUrl: string;
  model: string;
  authorization: string;
  allowedWorkloads: string[];
  prespecClassification: Exclude<ModalDataClassification, "sensitive">;
  maxConcurrency: number;
  maxAttempts: number;
  estimatedUsdPerSecond: number;
  aggregateBudgetUsd: number;
  perCallReservationUsd: number;
  budgetLedgerPath: string;
  circuitFailureThreshold: number;
  circuitResetMs: number;
}

export interface ModalBudgetReservation {
  schemaVersion: 1;
  reservationId: string;
  endpointId: string;
  workload: ModalGenerationWorkload;
  amountUsd: number;
  reservedAt: string;
}

export interface ModalCompletionClient {
  complete(request: Parameters<ModalOpenAIClient["complete"]>[0]): Promise<ModalGenerationResult>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertPositiveNumber(value: unknown, field: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new ModalGenerationError("invalid_contract", `Modal runtime ${field} must be a positive number`);
  }
}

export function parseModalOverflowRuntime(value: unknown): ModalOverflowRuntime {
  if (!isRecord(value) || value.schemaVersion !== 1) throw new ModalGenerationError("invalid_contract", "Modal runtime schema is invalid");
  for (const field of ["endpointName", "endpointId", "endpointUrl", "model", "authorization", "budgetLedgerPath"] as const) {
    if (typeof value[field] !== "string" || !value[field].trim()) throw new ModalGenerationError("invalid_contract", `Modal runtime ${field} is missing`);
  }
  if (value.enabled !== true) throw new ModalGenerationError("disabled", "Modal overflow runtime is disabled");
  if (!(value.endpointUrl as string).startsWith("https://")) throw new ModalGenerationError("invalid_contract", "Modal endpoint must use HTTPS");
  if (!(value.authorization as string).startsWith("Bearer ")) throw new ModalGenerationError("invalid_contract", "Modal proxy authorization is invalid");
  if (!Array.isArray(value.allowedWorkloads) || !value.allowedWorkloads.every((entry) => typeof entry === "string")) {
    throw new ModalGenerationError("invalid_contract", "Modal runtime workload allowlist is invalid");
  }
  if (value.prespecClassification !== "public" && value.prespecClassification !== "internal") {
    throw new ModalGenerationError("sensitive_data", "Factory pre-spec classification must be public or internal non-sensitive");
  }
  for (const field of [
    "maxConcurrency",
    "maxAttempts",
    "estimatedUsdPerSecond",
    "aggregateBudgetUsd",
    "perCallReservationUsd",
    "circuitFailureThreshold",
    "circuitResetMs",
  ] as const) assertPositiveNumber(value[field], field);
  const maxConcurrency = value.maxConcurrency as number;
  const maxAttempts = value.maxAttempts as number;
  const perCallReservationUsd = value.perCallReservationUsd as number;
  const aggregateBudgetUsd = value.aggregateBudgetUsd as number;
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency > 16) throw new ModalGenerationError("invalid_contract", "Modal runtime maxConcurrency is invalid");
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts > 2) throw new ModalGenerationError("invalid_contract", "Modal runtime maxAttempts is invalid");
  if (perCallReservationUsd > 1 || perCallReservationUsd > aggregateBudgetUsd) {
    throw new ModalGenerationError("invalid_contract", "Modal runtime reservation exceeds its permitted budget");
  }
  return value as unknown as ModalOverflowRuntime;
}

export function loadModalOverflowRuntime(
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModalOverflowRuntime | null {
  const path = env[MODAL_OVERFLOW_CONFIG_ENV] || DEFAULT_MODAL_OVERFLOW_CONFIG;
  if (!existsSync(path)) return null;
  return parseModalOverflowRuntime(JSON.parse(readFileSync(path, "utf8")));
}

function readBudgetReservations(path: string): ModalBudgetReservation[] {
  if (!existsSync(path)) return [];
  const reservations: ModalBudgetReservation[] = [];
  for (const [index, line] of readFileSync(path, "utf8").split("\n").entries()) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new ModalGenerationError("invalid_contract", `Modal budget ledger line ${index + 1} is invalid JSON`);
    }
    if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.reservationId !== "string" || typeof value.amountUsd !== "number") {
      throw new ModalGenerationError("invalid_contract", `Modal budget ledger line ${index + 1} is invalid`);
    }
    reservations.push(value as unknown as ModalBudgetReservation);
  }
  return reservations;
}

async function acquireBudgetLock(lockPath: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error) {
      const code = isRecord(error) && typeof error.code === "string" ? error.code : "";
      if (code !== "EEXIST") throw error;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > 30_000) rmSync(lockPath, { recursive: true, force: true });
      } catch {
        // The competing process may have released the lock between checks.
      }
      await Bun.sleep(25);
    }
  }
  throw new ModalGenerationError("budget", "Modal budget ledger lock timed out");
}

export async function reserveModalBudget(
  runtime: ModalOverflowRuntime,
  reservationId: string,
  now: Date = new Date(),
  workload: ModalGenerationWorkload = "factory-prespec",
): Promise<ModalBudgetReservation> {
  mkdirSync(dirname(runtime.budgetLedgerPath), { recursive: true });
  const lockPath = `${runtime.budgetLedgerPath}.lock`;
  await acquireBudgetLock(lockPath);
  try {
    const existing = readBudgetReservations(runtime.budgetLedgerPath);
    const duplicate = existing.find((entry) => entry.reservationId === reservationId);
    if (duplicate) return duplicate;
    const reserved = existing.reduce((total, entry) => total + entry.amountUsd, 0);
    if (reserved + runtime.perCallReservationUsd > runtime.aggregateBudgetUsd + Number.EPSILON) {
      throw new ModalGenerationError("budget", `Modal pilot budget exhausted at USD ${reserved.toFixed(2)}`);
    }
    const reservation: ModalBudgetReservation = {
      schemaVersion: 1,
      reservationId,
      endpointId: runtime.endpointId,
      workload,
      amountUsd: runtime.perCallReservationUsd,
      reservedAt: now.toISOString(),
    };
    appendFileSync(runtime.budgetLedgerPath, `${JSON.stringify(reservation)}\n`, { mode: 0o600 });
    return reservation;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

const PROHIBITED_TRANSIENT_MARKERS = [
  "insufficient balance",
  "insufficient credit",
  "unauthorized",
  "forbidden",
  "invalid request",
  "model is disabled",
  "safety",
  "policy",
];

const WORKSPACE_CAPACITY_MARKERS = [
  "workspace request",
  "workspace capacity",
  "too many active requests",
  "concurrent request limit",
  "request limit",
];

export function isEligibleZoOverflowFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const trail = (error as Error & { trail?: AskAttempt[] }).trail;
  if (!Array.isArray(trail) || trail.length === 0) return false;
  return trail.every((attempt) => {
    const detail = attempt.detail.toLowerCase();
    if (PROHIBITED_TRANSIENT_MARKERS.some((marker) => detail.includes(marker))) return false;
    if (attempt.status === null) return true;
    if (attempt.status === 429) return WORKSPACE_CAPACITY_MARKERS.some((marker) => detail.includes(marker));
    return attempt.status === 500 || attempt.status === 502 || attempt.status === 503 || attempt.status === 504;
  });
}

export class ZoRequestPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(readonly limit: number = FACTORY_ZO_REQUEST_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("Zo request pool limit must be a positive integer");
  }

  tryAcquire(): (() => void) | null {
    if (this.active >= this.limit) return null;
    this.active += 1;
    return () => this.release();
  }

  async acquire(): Promise<() => void> {
    const immediate = this.tryAcquire();
    if (immediate) return immediate;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    return () => this.release();
  }

  private release(): void {
    this.active -= 1;
    this.waiters.shift()?.();
  }
}

const productionZoPool = new ZoRequestPool();

function modalClientConfig(runtime: ModalOverflowRuntime): ModalOpenAIClientConfig {
  return {
    enabled: true,
    baseUrl: runtime.endpointUrl,
    model: runtime.model,
    authorization: runtime.authorization,
    allowedWorkloads: new Set(["factory-prespec"]),
    maxConcurrency: runtime.maxConcurrency,
    maxAttempts: runtime.maxAttempts,
    estimatedUsdPerSecond: runtime.estimatedUsdPerSecond,
    circuitFailureThreshold: runtime.circuitFailureThreshold,
    circuitResetMs: runtime.circuitResetMs,
  };
}

export interface GeneratePrespecWithOverflowOptions {
  input: string;
  zoCall: () => Promise<AskResult>;
  runtime?: ModalOverflowRuntime | null;
  zoPool?: ZoRequestPool;
  modalClient?: ModalCompletionClient;
  reserveBudget?: typeof reserveModalBudget;
}

async function callModal(
  options: GeneratePrespecWithOverflowOptions,
  runtime: ModalOverflowRuntime,
  reason: string,
): Promise<AskResult> {
  const reservationId = `prespec:${createHash("sha256").update(options.input).digest("hex").slice(0, 48)}`;
  await (options.reserveBudget ?? reserveModalBudget)(runtime, reservationId);
  const client = options.modalClient ?? new ModalOpenAIClient(modalClientConfig(runtime));
  const result = await client.complete({
    workload: "factory-prespec",
    classification: runtime.prespecClassification,
    messages: [{ role: "user", content: options.input }],
    idempotencyKey: reservationId,
    maxTokens: 8_192,
    timeoutMs: 120_000,
    maxEstimatedCostUsd: runtime.perCallReservationUsd,
    canonicalWrites: false,
    externalMutations: false,
    temperature: 0.2,
  });
  return {
    output: result.content,
    model: `modal:${result.model}`,
    trail: [{
      model: `modal:${result.model}`,
      attempt: result.attempts,
      status: 200,
      ok: true,
      detail: reason,
    }],
  };
}

export async function generatePrespecWithOverflow(
  options: GeneratePrespecWithOverflowOptions,
): Promise<AskResult> {
  const runtime = options.runtime === undefined ? loadModalOverflowRuntime() : options.runtime;
  const pool = options.zoPool ?? productionZoPool;
  if (!runtime || !runtime.allowedWorkloads.includes("factory-prespec")) {
    const release = await pool.acquire();
    try {
      return await options.zoCall();
    } finally {
      release();
    }
  }

  const release = pool.tryAcquire();
  if (!release) return callModal(options, runtime, "local Zo concurrency cap reached");
  try {
    return await options.zoCall();
  } catch (error) {
    if (!isEligibleZoOverflowFailure(error)) throw error;
    return await callModal(options, runtime, "eligible Zo capacity or transient failure");
  } finally {
    release();
  }
}
