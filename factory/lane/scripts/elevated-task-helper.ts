#!/usr/bin/env bun
/**
 * Isolated privileged helper for elevated tasks (threat-model R2) and the
 * authenticated broker → helper handoff protocol it speaks.
 *
 * The helper is its own systemd unit
 * (deploy/vps/elevated-task/zouroboros-elevated-helper.service)
 * listening on a Unix socket under its RuntimeDirectory. Peer gating is two-fold:
 *
 *   1. The socket file is 0660 root:zouroboros, so only the Command Center
 *      service account (and root) can connect at all. The Bun runtime does not
 *      expose SO_PEERCRED, so the filesystem mode is the peer-credential check.
 *   2. Every request carries an HMAC-SHA256 over the canonical handoff envelope
 *      keyed with CC_ELEVATED_HELPER_TOKEN, which lives in the helper's own
 *      EnvironmentFile and in a CC-only file — never in the shared cc.env.
 *
 * The helper trusts nothing in the envelope beyond the signature: it
 * re-validates the request, re-runs the dangerous-operation detector,
 * re-classifies, checks the approval binding and nonce TTL, refuses categories
 * outside its allowlist, refuses replays (envelope id, request id, and a
 * dispatched-marker on disk), and only then executes under the same bounds the
 * broker uses. It keeps its own hash-chained audit trail.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import { chmodSync, chownSync, existsSync, mkdirSync, openSync, closeSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ELEVATED_SCHEMA_VERSION,
  ELEVATED_REQUEST_ID,
  canonicalJson,
  categoryIndex,
  classifyElevatedTask,
  computeBoundArgumentsSha256,
  createAuditRecord,
  crockfordUlid,
  isElevatedCategory,
  policyFor,
  sha256Hex,
  validateElevatedTaskRequest,
  type ElevatedApproval,
  type ElevatedCategory,
  type ElevatedExecutionResult,
  type ElevatedTaskDecision,
  type ElevatedTaskRequest,
} from "./elevated-task-contract";
import { detectDangerousOperation } from "./elevated-task-detector";
import {
  buildExecutionEnv,
  collectSecretValues,
  executeBounded,
  toExecutionResult,
  type ExecutionFailureCode,
} from "./elevated-task-executor";
import { ElevatedAuditStore } from "./elevated-task-audit";

// ─── Handoff envelope ─────────────────────────────────────────────────────────

export const ELEVATED_HANDOFF_CONTRACT_ID = "zouroboros-elevated-handoff/v1" as const;
export const HANDOFF_SIGNATURE_HEADER = "x-elevated-signature";
export const HANDOFF_ENVELOPE_ID = /^eh-[0-9A-HJKMNP-TV-Z]{26}$/;
export const HANDOFF_MAX_AGE_MS = 10 * 60_000;
export const HANDOFF_MAX_SKEW_MS = 60_000;
export const HANDOFF_MAX_BODY_BYTES = 1024 * 1024;

export interface HandoffEnvelope {
  contract_id: typeof ELEVATED_HANDOFF_CONTRACT_ID;
  schema_version: typeof ELEVATED_SCHEMA_VERSION;
  envelope_id: string;
  issued_at: string;
  expires_at: string;
  broker_instance: string;
  request: ElevatedTaskRequest;
  decision: ElevatedTaskDecision;
  approval: ElevatedApproval | null;
  /** Plaintext nonce the broker already consumed; lets the helper re-check the binding. */
  expected_nonce: string | null;
  timeout_ms: number;
  output_cap_bytes: number;
}

export interface HandoffResponse {
  contract_id: typeof ELEVATED_HANDOFF_CONTRACT_ID;
  envelope_id: string;
  request_id: string;
  helper_pid: number;
  accepted: boolean;
  refusal_code: string | null;
  refusal_message: string | null;
  result: ElevatedExecutionResult | null;
  failure: ExecutionFailureCode | null;
  error_message: string | null;
  kill_signal: "SIGTERM" | "SIGKILL" | null;
  full_output_path: string | null;
}

export function newEnvelopeId(now?: Date): string {
  return `eh-${crockfordUlid(now)}`;
}

export function signEnvelope(envelope: HandoffEnvelope, token: string): string {
  return createHmac("sha256", token).update(canonicalJson(envelope)).digest("hex");
}

export function verifyEnvelopeSignature(envelope: HandoffEnvelope, signature: string | null, token: string): boolean {
  if (!signature || !/^[0-9a-f]{64}$/.test(signature)) return false;
  const expected = Buffer.from(signEnvelope(envelope, token), "hex");
  const presented = Buffer.from(signature, "hex");
  return expected.length === presented.length && timingSafeEqual(expected, presented);
}

export function createHandoffEnvelope(input: {
  broker_instance: string;
  request: ElevatedTaskRequest;
  decision: ElevatedTaskDecision;
  approval: ElevatedApproval | null;
  expected_nonce: string | null;
  timeout_ms: number;
  output_cap_bytes: number;
  now?: Date;
}): HandoffEnvelope {
  const now = input.now ?? new Date();
  return {
    contract_id: ELEVATED_HANDOFF_CONTRACT_ID,
    schema_version: ELEVATED_SCHEMA_VERSION,
    envelope_id: newEnvelopeId(now),
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + Math.min(HANDOFF_MAX_AGE_MS, input.timeout_ms + HANDOFF_MAX_SKEW_MS)).toISOString(),
    broker_instance: input.broker_instance,
    request: input.request,
    decision: input.decision,
    approval: input.approval,
    expected_nonce: input.expected_nonce,
    timeout_ms: input.timeout_ms,
    output_cap_bytes: input.output_cap_bytes,
  };
}

// ─── Helper-side verification ────────────────────────────────────────────────

export interface HelperVerification {
  ok: boolean;
  code: string | null;
  message: string | null;
  /** The helper's own classification; authoritative on the helper side. */
  decision: ElevatedTaskDecision | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Structural checks on the envelope before any signature or policy work. */
export function validateEnvelopeShape(input: unknown): { ok: boolean; message: string | null } {
  if (!isRecord(input)) return { ok: false, message: "envelope must be an object" };
  if (input.contract_id !== ELEVATED_HANDOFF_CONTRACT_ID) return { ok: false, message: "invalid handoff contract id" };
  if (input.schema_version !== ELEVATED_SCHEMA_VERSION) return { ok: false, message: "invalid handoff schema version" };
  if (typeof input.envelope_id !== "string" || !HANDOFF_ENVELOPE_ID.test(input.envelope_id)) return { ok: false, message: "invalid envelope id" };
  for (const key of ["issued_at", "expires_at"]) {
    if (typeof input[key] !== "string" || Number.isNaN(Date.parse(input[key] as string))) return { ok: false, message: `invalid ${key}` };
  }
  if (typeof input.broker_instance !== "string" || !input.broker_instance) return { ok: false, message: "missing broker instance" };
  if (!isRecord(input.request) || !isRecord(input.decision)) return { ok: false, message: "missing request or decision" };
  if (input.approval !== null && !isRecord(input.approval)) return { ok: false, message: "invalid approval" };
  if (input.expected_nonce !== null && typeof input.expected_nonce !== "string") return { ok: false, message: "invalid expected nonce" };
  if (!Number.isInteger(input.timeout_ms) || (input.timeout_ms as number) <= 0) return { ok: false, message: "invalid timeout" };
  if (!Number.isInteger(input.output_cap_bytes) || (input.output_cap_bytes as number) <= 0) return { ok: false, message: "invalid output cap" };
  return { ok: true, message: null };
}

/**
 * Independent re-derivation of the decision plus approval-binding checks. The
 * helper never learns the second secret; it requires the approval to carry the
 * second-secret hash for production and trusts the HMAC-signed broker for the
 * plaintext comparison that happened there.
 */
export function verifyHandoff(
  envelope: HandoffEnvelope,
  options: { categories: readonly ElevatedCategory[]; now: Date; home?: string; cc_clone_root?: string },
): HelperVerification {
  const fail = (code: string, message: string): HelperVerification => ({ ok: false, code, message, decision: null });
  const issuedAt = Date.parse(envelope.issued_at);
  const expiresAt = Date.parse(envelope.expires_at);
  const nowMs = options.now.getTime();
  if (issuedAt - nowMs > HANDOFF_MAX_SKEW_MS) return fail("envelope_from_future", "envelope issued_at is ahead of the helper clock");
  if (nowMs > expiresAt) return fail("envelope_expired", "envelope has expired");
  if (expiresAt - issuedAt > HANDOFF_MAX_AGE_MS + HANDOFF_MAX_SKEW_MS) return fail("envelope_window_too_long", "envelope validity window exceeds the maximum");

  const validation = validateElevatedTaskRequest(envelope.request);
  if (!validation.ok) return fail("malformed_request", validation.issues.map((issue) => `${issue.path}: ${issue.message}`).join("; "));
  const request = envelope.request;
  if (!ELEVATED_REQUEST_ID.test(envelope.decision.request_id)) return fail("invalid_request_id", "decision request id is malformed");

  const detector = detectDangerousOperation({
    argv: request.command.argv,
    cwd: request.command.cwd,
    home: options.home,
    cc_clone_root: options.cc_clone_root,
  });
  const decision = classifyElevatedTask(request, detector, {
    mode: "enforce",
    rung_cap: "production",
    now: new Date(envelope.decision.classified_at),
    request_id: envelope.decision.request_id,
  });
  if (decision.outcome !== "auto_execute" && decision.outcome !== "await_approval") {
    return fail("helper_classification_refused", `helper classification outcome is ${decision.outcome} (${decision.reasons.join(",")})`);
  }
  const category = decision.effective_category;
  if (!category || category !== envelope.decision.effective_category) {
    return fail("category_mismatch", `helper derived ${category ?? "none"}, broker sent ${envelope.decision.effective_category ?? "none"}`);
  }
  if (!options.categories.includes(category)) return fail("category_not_permitted", `helper does not execute ${category}`);
  const policy = policyFor(category);
  if (policy.executes_in !== "helper" && request.target !== "full-vps") {
    return fail("wrong_execution_site", `${category} executes in the broker, not the helper`);
  }
  if (!policy.targets.includes(request.target)) return fail("target_not_allowed", `${category} does not permit target ${request.target}`);
  const boundHash = computeBoundArgumentsSha256(request, category);
  if (boundHash !== envelope.decision.bound_arguments_sha256 || boundHash !== decision.bound_arguments_sha256) {
    return fail("bound_arguments_mismatch", "bound-arguments hash does not match the request");
  }
  if (envelope.timeout_ms > policy.timeout_ms) return fail("timeout_exceeds_policy", `timeout ${envelope.timeout_ms} exceeds policy ${policy.timeout_ms}`);
  if (envelope.output_cap_bytes > policy.output_cap_bytes) return fail("output_cap_exceeds_policy", "output cap exceeds policy");

  if (policy.execution === "approval") {
    const approval = envelope.approval;
    if (!approval) return fail("approval_missing", `${category} requires an operator approval`);
    if (approval.request_id !== decision.request_id) return fail("approval_request_mismatch", "approval is for a different request");
    if (approval.bound_arguments_sha256 !== boundHash) return fail("approval_binding_mismatch", "approval is bound to different arguments");
    if (policy.approval.nonce) {
      if (!envelope.expected_nonce || approval.nonce !== envelope.expected_nonce) return fail("nonce_mismatch", "approval nonce does not match");
      const classifiedAt = Date.parse(envelope.decision.classified_at);
      const approvedAt = Date.parse(approval.approved_at);
      if (Number.isNaN(classifiedAt) || Number.isNaN(approvedAt)) return fail("invalid_timestamps", "classification or approval timestamp is invalid");
      if (approvedAt - classifiedAt > policy.nonce_ttl_ms) return fail("nonce_expired", "approval arrived after the nonce TTL");
      if (nowMs - approvedAt > HANDOFF_MAX_AGE_MS) return fail("approval_stale", "approval is older than the handoff window");
    }
    if (policy.approval.second_secret && !(typeof approval.second_secret_hash === "string" && /^[0-9a-f]{64}$/.test(approval.second_secret_hash))) {
      return fail("second_secret_missing", `${category} requires a second-secret verification hash`);
    }
    if (!approval.approver_fingerprint) return fail("approver_missing", "approval lacks an approver fingerprint");
  }
  if (categoryIndex(category) < 0) return fail("invalid_category", "category is not in the ladder");
  return { ok: true, code: null, message: null, decision };
}

// ─── Helper server ────────────────────────────────────────────────────────────

export interface HelperConfig {
  socket_path: string;
  token: string;
  categories: ElevatedCategory[];
  state_dir: string;
  allowed_env_keys: string[];
  max_concurrent: number;
  socket_mode: number;
  /** Numeric gid to chown the socket to (root only); null leaves the process gid. */
  socket_gid: number | null;
  home?: string;
  cc_clone_root?: string;
  source_env: Record<string, string | undefined>;
  emit?: (line: string) => void;
  now?: () => Date;
}

export interface RunningHelper {
  pid: number;
  socket_path: string;
  active(): number;
  stop(): Promise<void>;
}

export const HELPER_TOKEN_ENV = "CC_ELEVATED_HELPER_TOKEN";
export const HELPER_SOCKET_ENV = "CC_ELEVATED_HELPER_SOCKET";
export const HELPER_CATEGORIES_ENV = "CC_ELEVATED_HELPER_CATEGORIES";
export const HELPER_STATE_DIR_ENV = "CC_ELEVATED_HELPER_STATE_DIR";
export const HELPER_ALLOWED_ENV_KEYS_ENV = "CC_ELEVATED_HELPER_ALLOWED_ENV_KEYS";
export const HELPER_SOCKET_GID_ENV = "CC_ELEVATED_HELPER_SOCKET_GID";
export const DEFAULT_HELPER_SOCKET = "/run/zouroboros-elevated/helper.sock";
export const DEFAULT_HELPER_STATE_DIR = "/var/lib/zouroboros/elevated-helper";

export function helperConfigFromEnv(env: Record<string, string | undefined> = process.env): HelperConfig {
  const token = (env[HELPER_TOKEN_ENV] ?? "").trim();
  if (token.length < 32) throw new Error(`${HELPER_TOKEN_ENV} must be at least 32 characters (openssl rand -hex 32)`);
  const categories = (env[HELPER_CATEGORIES_ENV] ?? "production")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const category of categories) {
    if (!isElevatedCategory(category)) throw new Error(`${HELPER_CATEGORIES_ENV} contains an unknown category: ${category}`);
  }
  const gidRaw = env[HELPER_SOCKET_GID_ENV];
  const gid = gidRaw === undefined || gidRaw === "" ? null : Number(gidRaw);
  if (gid !== null && (!Number.isInteger(gid) || gid < 0)) throw new Error(`${HELPER_SOCKET_GID_ENV} must be a non-negative integer`);
  return {
    socket_path: env[HELPER_SOCKET_ENV] ?? DEFAULT_HELPER_SOCKET,
    token,
    categories: categories as ElevatedCategory[],
    state_dir: env[HELPER_STATE_DIR_ENV] ?? DEFAULT_HELPER_STATE_DIR,
    allowed_env_keys: (env[HELPER_ALLOWED_ENV_KEYS_ENV] ?? "").split(",").map((value) => value.trim()).filter(Boolean),
    max_concurrent: 1,
    socket_mode: 0o660,
    socket_gid: gid,
    home: env.HOME,
    source_env: env,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function startElevatedHelper(config: HelperConfig): RunningHelper {
  const now = config.now ?? (() => new Date());
  const emit = config.emit ?? ((line: string) => console.log(line));
  const audit = new ElevatedAuditStore({
    state_dir: config.state_dir,
    secrets: collectSecretValues(config.source_env, [config.token]),
    emit,
    now,
  });
  const dispatchedDir = join(config.state_dir, "dispatched");
  mkdirSync(dispatchedDir, { recursive: true, mode: 0o700 });
  const seenEnvelopes = new Map<string, number>();
  const children = new Set<Bun.Subprocess>();
  let active = 0;
  let stopping = false;

  function pruneSeen(): void {
    const cutoff = now().getTime() - HANDOFF_MAX_AGE_MS - HANDOFF_MAX_SKEW_MS;
    for (const [id, at] of seenEnvelopes) if (at < cutoff) seenEnvelopes.delete(id);
  }

  function refusal(envelope: Partial<HandoffEnvelope>, code: string, message: string, status: number): Response {
    emit(`[elevated-helper] refused ${JSON.stringify({ code, envelope_id: envelope.envelope_id ?? null, request_id: envelope.decision?.request_id ?? null })}`);
    const body: HandoffResponse = {
      contract_id: ELEVATED_HANDOFF_CONTRACT_ID,
      envelope_id: envelope.envelope_id ?? "",
      request_id: envelope.decision?.request_id ?? "",
      helper_pid: process.pid,
      accepted: false,
      refusal_code: code,
      refusal_message: message,
      result: null,
      failure: null,
      error_message: null,
      kill_signal: null,
      full_output_path: null,
    };
    return jsonResponse(body, status);
  }

  async function handleExecute(request: Request): Promise<Response> {
    if (stopping) return refusal({}, "helper_stopping", "helper is shutting down", 503);
    const lengthHeader = Number(request.headers.get("content-length") ?? "0");
    if (lengthHeader > HANDOFF_MAX_BODY_BYTES) return refusal({}, "body_too_large", "envelope exceeds the size limit", 413);
    const raw = await request.text();
    if (Buffer.byteLength(raw, "utf8") > HANDOFF_MAX_BODY_BYTES) return refusal({}, "body_too_large", "envelope exceeds the size limit", 413);
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return refusal({}, "bad_json", "envelope is not valid JSON", 400);
    }
    const shape = validateEnvelopeShape(parsed);
    if (!shape.ok) return refusal({}, "malformed_envelope", shape.message ?? "malformed envelope", 400);
    const envelope = parsed as HandoffEnvelope;
    if (!verifyEnvelopeSignature(envelope, request.headers.get(HANDOFF_SIGNATURE_HEADER), config.token)) {
      return refusal(envelope, "bad_signature", "envelope signature is invalid", 401);
    }
    pruneSeen();
    if (seenEnvelopes.has(envelope.envelope_id)) return refusal(envelope, "replay", "envelope id was already presented", 409);
    seenEnvelopes.set(envelope.envelope_id, now().getTime());

    const verification = verifyHandoff(envelope, {
      categories: config.categories,
      now: now(),
      home: config.home,
      cc_clone_root: config.cc_clone_root,
    });
    if (!verification.ok || !verification.decision) {
      return refusal(envelope, verification.code ?? "refused", verification.message ?? "refused", 403);
    }
    const decision = verification.decision;
    if (active >= config.max_concurrent) return refusal(envelope, "helper_busy", "helper concurrency limit reached", 429);
    if (!existsSync(envelope.request.command.cwd)) return refusal(envelope, "cwd_missing", "working directory does not exist", 400);

    // Dispatched marker: created exclusively before the spawn so a request id can
    // never execute twice on this host even across helper restarts.
    try {
      closeSync(openSync(join(dispatchedDir, decision.request_id), "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return refusal(envelope, "replay", "request id was already dispatched on this host", 409);
      throw error;
    }

    active += 1;
    const policy = policyFor(decision.effective_category!);
    const envBuild = buildExecutionEnv({
      requested_keys: envelope.request.env_keys,
      allowed_keys: config.allowed_env_keys,
      source: config.source_env,
    });
    const baseRecord = createAuditRecord(envelope.request, decision, envelope.approval, null, null);
    try {
      await audit.append("intent", baseRecord, {
        execution_site: "helper",
        helper_pid: process.pid,
        broker_instance: envelope.broker_instance,
        actor_fingerprint: envelope.approval?.approver_fingerprint ?? null,
        note: envBuild.refused.length ? `env refused: ${envBuild.refused.map((entry) => `${entry.key}(${entry.reason})`).join(",")}` : null,
      });
      const outcome = await executeBounded(envelope.request.command, decision.request_id, {
        timeout_ms: Math.min(envelope.timeout_ms, policy.timeout_ms),
        output_cap_bytes: Math.min(envelope.output_cap_bytes, policy.output_cap_bytes),
        env: envBuild.env,
        secrets: collectSecretValues(config.source_env, [config.token]),
        now,
        onSpawn: (child) => children.add(child),
        onExit: (child) => children.delete(child),
      });
      let fullOutputPath: string | null = null;
      try {
        fullOutputPath = audit.writeFullOutput(decision.request_id, outcome.full_output).path;
      } catch (error) {
        emit(`[elevated-helper] output persistence failed ${JSON.stringify({ request_id: decision.request_id, error: String(error) })}`);
      }
      const result = toExecutionResult(outcome);
      await audit.append("effect", createAuditRecord(envelope.request, decision, envelope.approval, result, outcome.error_message), {
        execution_site: "helper",
        helper_pid: process.pid,
        broker_instance: envelope.broker_instance,
        actor_fingerprint: envelope.approval?.approver_fingerprint ?? null,
        outcome_code: outcome.failure ?? "completed",
      });
      const body: HandoffResponse = {
        contract_id: ELEVATED_HANDOFF_CONTRACT_ID,
        envelope_id: envelope.envelope_id,
        request_id: decision.request_id,
        helper_pid: process.pid,
        accepted: true,
        refusal_code: null,
        refusal_message: null,
        result,
        failure: outcome.failure,
        error_message: outcome.error_message,
        kill_signal: outcome.kill_signal,
        full_output_path: fullOutputPath,
      };
      return jsonResponse(body);
    } finally {
      active -= 1;
    }
  }

  if (existsSync(config.socket_path)) {
    // A stale socket from an unclean stop blocks bind(); a live one means a second helper.
    try { unlinkSync(config.socket_path); } catch {}
  }
  mkdirSync(dirname(config.socket_path), { recursive: true, mode: 0o750 });
  const server = Bun.serve({
    unix: config.socket_path,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/healthz") {
        return jsonResponse({ ok: true, pid: process.pid, categories: config.categories, active, contract_id: ELEVATED_HANDOFF_CONTRACT_ID });
      }
      if (request.method === "POST" && url.pathname === "/execute") {
        try {
          return await handleExecute(request);
        } catch (error) {
          emit(`[elevated-helper] unhandled error ${JSON.stringify({ error: String(error) })}`);
          return refusal({}, "internal_error", "helper failed to process the envelope", 500);
        }
      }
      return jsonResponse({ error: "not_found" }, 404);
    },
  });
  chmodSync(config.socket_path, config.socket_mode);
  if (config.socket_gid !== null) {
    try { chownSync(config.socket_path, -1, config.socket_gid); } catch (error) {
      emit(`[elevated-helper] socket chown failed ${JSON.stringify({ gid: config.socket_gid, error: String(error) })}`);
    }
  }
  emit(`[elevated-helper] listening ${JSON.stringify({ socket: config.socket_path, categories: config.categories, pid: process.pid })}`);

  return {
    pid: process.pid,
    socket_path: config.socket_path,
    active: () => active,
    async stop() {
      stopping = true;
      for (const child of children) { try { child.kill("SIGTERM"); } catch {} }
      const deadline = Date.now() + 5_000;
      while (active > 0 && Date.now() < deadline) await Bun.sleep(25);
      for (const child of children) { try { child.kill("SIGKILL"); } catch {} }
      server.stop(true);
      try { unlinkSync(config.socket_path); } catch {}
    },
  };
}

// ─── Broker-side client ───────────────────────────────────────────────────────

export type HelperCallResult =
  | { kind: "response"; response: HandoffResponse; status: number }
  /** Nothing was sent (socket missing or connection refused): no effect can have happened. */
  | { kind: "unreachable"; message: string }
  /** The request may have been received: the outcome is unknown and must be held. */
  | { kind: "ambiguous"; message: string };

export interface HelperClientOptions {
  socket_path: string;
  token: string;
  fetch?: typeof fetch;
}

const UNREACHABLE_PATTERN = /ECONNREFUSED|ENOENT|Unable to connect|ConnectionRefused|FailedToOpenSocket|No such file/i;

export class HelperClient {
  constructor(private readonly options: HelperClientOptions) {}

  async health(timeoutMs = 2_000): Promise<{ ok: boolean; categories: ElevatedCategory[]; pid: number | null }> {
    try {
      const response = await (this.options.fetch ?? fetch)("http://elevated-helper.local/healthz", {
        unix: this.options.socket_path,
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);
      if (!response.ok) return { ok: false, categories: [], pid: null };
      const body = await response.json() as { categories?: ElevatedCategory[]; pid?: number };
      return { ok: true, categories: body.categories ?? [], pid: body.pid ?? null };
    } catch {
      return { ok: false, categories: [], pid: null };
    }
  }

  async execute(envelope: HandoffEnvelope, timeoutMs: number): Promise<HelperCallResult> {
    const body = JSON.stringify(envelope);
    // A missing socket file means nothing can have been sent: definitively unreachable.
    if (!existsSync(this.options.socket_path)) {
      return { kind: "unreachable", message: `helper socket ${this.options.socket_path} does not exist` };
    }
    let response: Response;
    try {
      response = await (this.options.fetch ?? fetch)("http://elevated-helper.local/execute", {
        method: "POST",
        unix: this.options.socket_path,
        headers: {
          "Content-Type": "application/json",
          [HANDOFF_SIGNATURE_HEADER]: signEnvelope(envelope, this.options.token),
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      } as RequestInit);
    } catch (error) {
      // Bun reports connect failures with a generic message ("Was there a typo in
      // the url or port?") and the real cause in `code`, so classify on both.
      const code = typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : "";
      const detail = error instanceof Error ? error.message : String(error);
      const message = code ? `${code}: ${detail}` : detail;
      if (UNREACHABLE_PATTERN.test(message)) return { kind: "unreachable", message };
      return { kind: "ambiguous", message };
    }
    let parsed: HandoffResponse;
    try {
      parsed = await response.json() as HandoffResponse;
    } catch (error) {
      return { kind: "ambiguous", message: `helper returned status ${response.status} without a parseable body: ${String(error)}` };
    }
    return { kind: "response", response: parsed, status: response.status };
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

if (import.meta.main) {
  const config = helperConfigFromEnv();
  const running = startElevatedHelper(config);
  const shutdown = (signal: string): void => {
    console.log(`[elevated-helper] ${signal} received, stopping`);
    void running.stop().finally(() => process.exit(0));
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
}

export { sha256Hex as helperSha256Hex };
