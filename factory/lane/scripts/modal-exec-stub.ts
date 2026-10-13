/**
 * modal-exec-stub.ts — Local stand-in for the modal-exec package
 * (packages/modal-exec/src/modal-openai-client.ts).
 *
 * The upstream module is not vendored in this distribution. Types are
 * provided faithfully so call sites compile; the client's `complete()`
 * throws fail-closed because there is no Modal transport here.
 *
 * If Modal generation is needed, vendor the upstream package and repoint
 * the importers at it.
 */

export const MODAL_GENERATION_ENABLED_ENV = "ZOUROBOROS_MODAL_GENERATION";
export const MODAL_INFERENCE_BASE_URL_ENV = "MODAL_INFERENCE_BASE_URL";
export const MODAL_INFERENCE_MODEL_ENV = "MODAL_INFERENCE_MODEL";
export const MODAL_PROXY_AUTHORIZATION_ENV = "MODAL_PROXY_AUTHORIZATION";
export const MODAL_PROXY_TOKEN_ID_ENV = "MODAL_PROXY_TOKEN_ID";
export const MODAL_PROXY_TOKEN_SECRET_ENV = "MODAL_PROXY_TOKEN_SECRET";
export const MODAL_GENERATION_WORKLOADS_ENV = "MODAL_GENERATION_WORKLOADS";
export const MODAL_GENERATION_MAX_CONCURRENCY_ENV =
  "MODAL_GENERATION_MAX_CONCURRENCY";
export const MODAL_GENERATION_ESTIMATED_USD_PER_SECOND_ENV =
  "MODAL_GENERATION_ESTIMATED_USD_PER_SECOND";

export type ModalGenerationWorkload =
  | "benchmark"
  | "factory-prespec"
  | "memory-extraction"
  | "memory-summarization";

export type ModalDataClassification = "public" | "internal" | "sensitive";
export type ModalMessageRole = "system" | "user" | "assistant";

export interface ModalGenerationMessage {
  role: ModalMessageRole;
  content: string;
}

export interface ModalGenerationRequest {
  workload: ModalGenerationWorkload;
  classification: ModalDataClassification;
  messages: readonly ModalGenerationMessage[];
  idempotencyKey: string;
  maxTokens: number;
  timeoutMs: number;
  maxEstimatedCostUsd: number;
  canonicalWrites: false;
  externalMutations: false;
  temperature?: number;
  json?: boolean;
}

export interface ModalGenerationUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface ModalGenerationResult {
  content: string;
  model: string;
  finishReason?: string;
  usage?: ModalGenerationUsage;
  latencyMs: number;
  estimatedCostUsd: number;
  providerRequestId?: string;
  attempts: number;
}

export interface ModalOpenAIClientConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  authorization: string;
  tokenId: string;
  tokenSecret: string;
  allowedWorkloads: ReadonlySet<ModalGenerationWorkload>;
  maxConcurrency: number;
  maxAttempts: number;
  estimatedUsdPerSecond: number;
  circuitFailureThreshold: number;
  circuitResetMs: number;
}

export type ModalGenerationErrorCode =
  | "disabled"
  | "invalid_contract"
  | "prohibited_workload"
  | "sensitive_data"
  | "authentication"
  | "credits"
  | "validation"
  | "rate_limit"
  | "transient"
  | "timeout"
  | "empty_response"
  | "budget"
  | "circuit_open";

export class ModalGenerationError extends Error {
  constructor(
    readonly code: ModalGenerationErrorCode,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ModalGenerationError";
  }
}

export type ModalFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ModalOpenAIClientDependencies {
  fetchImpl?: ModalFetch;
  sleepImpl?: (milliseconds: number) => Promise<void>;
  nowImpl?: () => number;
}

/**
 * Fail-closed: constructing is fine (config plumbing), but completing a
 * generation throws — there is no Modal transport in this distribution.
 */
export class ModalOpenAIClient {
  constructor(
    readonly config: ModalOpenAIClientConfig,
    _dependencies: ModalOpenAIClientDependencies = {},
  ) {}

  async complete(_request: ModalGenerationRequest): Promise<ModalGenerationResult> {
    throw new ModalGenerationError(
      "disabled",
      "modal-exec is not vendored in this distribution — cannot complete Modal generation",
    );
  }
}
