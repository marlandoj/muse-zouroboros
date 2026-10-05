#!/usr/bin/env bun
/**
 * Provider rotation for the agentic /zo/ask transport.
 *
 * The factory executes via /zo/ask — an AGENTIC endpoint: the child Zo runs the
 * full interview → seed → eval → execute → post-flight → gap-audit pipeline.
 * /zo/ask picks the backing LLM from the `model_name` provider prefix. When one
 * provider rate-limits (429) or transiently fails, we retry once, then rotate to
 * the next model_name in the chain — a DIFFERENT provider serving (ideally) the
 * SAME model, so agentic capability and output quality are preserved.
 *
 * Prefixes confirmed reachable THROUGH /zo/ask (re-probed 2026-07-04):
 *   byok:<id>                        → Synthetic.new (GLM-5.2) OR a DIRECT provider
 *                                      (e.g. byok:a3556112… routes DeepSeek-v4-pro
 *                                      DIRECT — 402 "Insufficient Balance" until the
 *                                      DeepSeek account is topped up; genuinely
 *                                      cross-provider, so re-add it once funded).
 *   vercel:anthropic/<m> | claude-*  → Anthropic (haiku + sonnet-4-6 probed OK).
 * DEAD through /zo/ask (do NOT put back — not a creds issue, a platform model-disable):
 *   openrouter:z-ai/glm-5.2 → 403 "Model is disabled: vercel:zai/glm-5.2". The
 *   platform remaps the openrouter prefix onto a DISABLED vercel:zai model; a valid
 *   OPENROUTER_API_KEY cannot revive it. Swapped to Anthropic Sonnet 4.6 (2026-07-04).
 *   Also dead: oc:, hf:, opencode: (→ 502 "Unknown provider"). Opencode would need
 *   its own byok:<uuid> to route.
 */

import * as fs from "fs";

// Same set the consensus-gate treats as transient (retry, then rotate).
export const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 529]);

/**
 * Failover chain source of truth.
 *
 * ZOU-546 post-mortem: the old fallback tier was two `vercel:anthropic/*` rungs
 * that shared ONE Vercel AI Gateway billing account. When that account hit a 402
 * "insufficient balance", BOTH rungs collapsed at once and the run exhausted the
 * chain. The fix moves the fallback tier onto flat-rate ("subscription") BYOK
 * configs — each a DIFFERENT vendor/account, none of which can 402 — and derives
 * the live set from the /zo/ask-probed byok-catalog (see deriveChain).
 *
 * Rungs (priority order, operator-set 2026-07-10):
 *   1. Claude Code Fable 5 — flat-rate flagship PRIMARY (402/429-immune subscription).
 *   2. Codex GPT 5.6 Sol   — flagship, separate vendor + account.
 *   3. Synthetic GLM-5.2   — usage-billed; demoted off primary while quota-429'd.
 *   4. Claude Code Haiku   — cheap subscription.
 *   5. Kimi K2.7-Code      — usage-billed, separate vendor.
 * Every rung routes through /zo/ask via its `byok:<uuid>` config. Override the
 * whole chain with FACTORY_MODEL_CHAIN (comma-separated model_names, priority
 * order) — e.g. to re-add a `vercel:anthropic/*` rung once that gateway is funded.
 */
// Vendor-diverse byok ladder, priority order (operator-set 2026-07-10 — Fable 5
// promoted to primary over GLM-5.2, which is usage-billed and persistently
// quota-429'd). Every id is a `byok:<uuid>` config routable through /zo/ask; the
// flat-rate "subscription" rungs (Fable 5, Sol, Haiku) are immune both to the 402
// that collapsed the old vercel tier (ZOU-546) and to probe-time 429s. deriveChain
// uses the /zo/ask-probed byok-catalog only to REORDER — demoting configs that
// were not live at the last probe to the tail — never to DROP a rung: the probe
// can't tell a transient 429 from a rotated UUID, and the usage-billed configs
// (GLM-5.2, Kimi) 429 at probe time (observed 2026-07-10 — a refresh 429'd both
// and would have evicted them). A genuinely-dead UUID simply sinks to the tail and
// costs one cheap non-retried 400 at runtime.
const BYOK_CHAIN_PREFERENCE = [
  "byok:d879829b-6d2c-44f6-a60e-0c1e31149b9e", // Claude Code Fable 5   (claude flagship — PRIMARY)
  "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f", // Codex GPT 5.6 Sol     (gpt flagship, separate account)
  "byok:bb3d131d-749f-423b-a285-9f9efd103926", // Synthetic GLM-5.2     (usage-billed, currently 429-capped)
  "byok:461d8d6f-9616-4391-960e-3caea2a27829", // Claude Code Haiku 4.5 (cheap subscription)
  "byok:463350ac-4a49-4ceb-8653-042ecffa513f", // Kimi K2.7-Code        (usage-billed, separate vendor)
];

// Cold-start fallback: used verbatim when the byok-catalog is missing/stale, so
// an unrefreshed workspace still runs the full byok ladder (no vercel 402 tier).
export const DEFAULT_MODEL_CHAIN = [...BYOK_CHAIN_PREFERENCE];

const BYOK_CATALOG_STALE_MS = 14 * 24 * 60 * 60 * 1000; // matches catalog-byok probe TTL

function byokCatalogPath(env: Record<string, string | undefined>): string {
  return env.BYOK_CATALOG_PATH || (env.HOME ? `${env.HOME}/.zouroboros/byok-catalog.json` : "");
}

/** Ids live in the /zo/ask-probed byok-catalog, or null if the cache is
 *  missing, unreadable, empty, or staler than the probe TTL. */
function liveByokIds(env: Record<string, string | undefined>): Set<string> | null {
  const p = byokCatalogPath(env);
  if (!p || !fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf-8")) as { fetched_at?: string; models?: { id?: string }[] };
    const age = Date.now() - Date.parse(raw.fetched_at ?? "");
    if (!Number.isFinite(age) || age > BYOK_CATALOG_STALE_MS) return null;
    const ids = new Set<string>();
    for (const m of raw.models ?? []) if (m.id) ids.add(m.id);
    return ids.size ? ids : null;
  } catch {
    return null;
  }
}

/**
 * Order the byok ladder by last-probed liveness WITHOUT dropping any rung: the
 * pinned primary (Fable 5) stays first, then the fallbacks that were live at the
 * last catalog probe (in preference order), then any that were probe-absent
 * (demoted — they MAY be dead, but are kept in case they were only transiently
 * rate-limited when probed; e.g. usage-billed GLM-5.2/Kimi 429 at probe time, so
 * a 429-capped GLM sinks below Haiku until its quota clears). Returns the plain
 * curated order when the catalog is missing/stale/empty. loadModelChain lets
 * FACTORY_MODEL_CHAIN override entirely.
 */
export function deriveChain(env: Record<string, string | undefined> = process.env): string[] {
  const live = liveByokIds(env);
  if (!live) return [...DEFAULT_MODEL_CHAIN];
  const [primary, ...fallbacks] = BYOK_CHAIN_PREFERENCE;
  const up = fallbacks.filter((id) => live.has(id));
  const down = fallbacks.filter((id) => !live.has(id));
  return [primary, ...up, ...down];
}

export function loadModelChain(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.FACTORY_MODEL_CHAIN?.trim();
  if (raw) {
    const chain = raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (chain.length) return chain;
  }
  return deriveChain(env);
}

// Body-level markers that mean "rate limited / retry" even when the HTTP status
// itself is a generic wrapper (e.g. /zo/ask returns 502 wrapping a provider 429).
const RATE_LIMIT_MARKERS = [
  "rate limit",
  "rate_limit",
  "ratelimit",
  "exceeded your subscription",
  "resource_exhausted",
  "too many requests",
  "overloaded",
  "429",
  "529",
];

export function isTransientBody(body: string): boolean {
  const b = body.toLowerCase();
  return RATE_LIMIT_MARKERS.some((m) => b.includes(m));
}

// ── Non-stream transient classification ───────────────────────────────────────
// Rate-limit / overload signal even when the HTTP status is a generic wrapper
// (e.g. /zo/ask returns 502 wrapping a provider 429).

/** Statuses that ALWAYS warrant a same-provider retry + rotation. */
export const ALWAYS_TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);
/**
 * Statuses that warrant a same-provider retry before rotation ONLY when the body
 * carries rate-limit / overload markers — quota-shaped 4xx that alternative
 * providers may dodge. stream-idle-timeout 408s ALWAYS retry (they're plausibly
 * still running server-side; conversation-resume is how the thinking-model loop
 * closes that hole).
 */
export function isTransientHttp(status: number | null, body: string): boolean {
  if (status == null) return true;
  if (ALWAYS_TRANSIENT_STATUSES.has(status)) return true;
  if (status === 400 || status === 404 || status === 422) {
    return RATE_LIMIT_MARKERS.some((m) => body.toLowerCase().includes(m));
  }
  return false;
}

export function shouldRetry(status: number | null, body: string): boolean {
  if (status == null) return true;
  if (status === 408 || status === 429) return true;
  if (status === 500 || status === 502 || status === 503 || status === 504 || status === 529) {
    // 1xx is impossible here; 429-observed bodies are also retried above.
    try {
      const j = JSON.parse(body);
      const inner = (j && typeof j === "object" && (j.error ?? j.detail ?? j.message)) ?? body;
      if (typeof inner === "string" && RATE_LIMIT_MARKERS.some((m) => inner.toLowerCase().includes(m))) return true;
    } catch { /* body not JSON */ }
    return RATE_LIMIT_MARKERS.some((m) => body.toLowerCase().includes(m));
  }
  return false;
}

export interface AskAttempt {
  model: string;
  attempt: number; // 1 = first try, 2 = same-provider retry
  status: number | null; // null = threw (network / timeout)
  ok: boolean;
  detail: string;
}

export interface AskResult {
  output: string;
  model: string; // the provider model_name that actually served the result
  conversationId?: string;
  trail: AskAttempt[]; // full attempt-by-attempt failover trail
}

export type FetchLike = typeof fetch;

// ── Streaming-with-resume for long-thinking models ──────────────────────────
// /zo/ask children on thinking models regularly exceed the host's ~120s
// stream-idle watchdog: the child run is killed mid-thought and the caller
// gets either a network drop or an HTTP error wrapping "no content events".
// This primitive (a) opens the ask as SSE, (b) aborts any stream that goes
// quiet past STREAM_STALL_TIMEOUT_MS, and (c) lets askWithFailover RESUME the
// killed conversation with its partial text instead of discarding the work.
// Opt-in per call via askWithFailover({ streamResume: true }).
export const STREAM_STALL_TIMEOUT_MS = 130_000;
const STALL_WATCHDOG_TICK_MS = 1_000;

interface ParsedStream {
  output: string;
  conversationId?: string;
  completed: boolean;
  stalled: boolean;
}

/** Merge overlapping text fragments from consecutive stream windows so resume
 *  output doesn't duplicate the tail of the previous window. */
function joinPartial(prev: string, next: string): string {
  if (!next) return prev;
  if (prev.endsWith(next)) return prev;
  const maxOverlap = Math.min(prev.length, next.length);
  for (let k = maxOverlap; k > 0; k--) {
    if (prev.slice(-k) === next.slice(0, k)) return prev + next.slice(k);
  }
  return prev + "\n" + next;
}

class StreamStall extends Error {
  constructor() { super("stream_idle_stall"); this.name = "StreamStall"; }
}

function classifyStreamEvent(ev: Record<string, any>): { kind: "text" | "thinking" | "done"; text: string } {
  const d = ev?.delta;
  if (d && typeof d === "object" && typeof d.content_delta === "string" && d.content_delta) {
    return { kind: d.part_delta_kind === "thinking" ? "thinking" : "text", text: d.content_delta };
  }
  const p = ev?.part;
  if (p && typeof p === "object" && typeof p.content === "string" && p.content) {
    return { kind: p.part_kind === "thinking" ? "thinking" : "text", text: p.content };
  }
  if (typeof ev?.output === "string" && ev.output) return { kind: "text", text: ev.output };
  if (typeof ev?.delta === "string" && ev.delta) return { kind: "text", text: ev.delta };
  if (typeof ev?.text === "string" && ev.text) return { kind: "text", text: ev.text };
  if (ev?.status === "succeeded" || ev?.type === "completed") return { kind: "done", text: "" };
  return { kind: "thinking", text: "" };
}

function findConversationId(ev: Record<string, any>): string | undefined {
  if (typeof ev?.conversation_id === "string" && ev.conversation_id) return ev.conversation_id;
  const d = ev?.data;
  if (d && typeof d === "object" && typeof d.conversation_id === "string" && d.conversation_id) return d.conversation_id;
  return undefined;
}

async function readSseStream(
  body: ReadableStream<Uint8Array>,
  deadlineMs: number,
  wallDeadlineAt: number,
): Promise<ParsedStream> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let output = "";
  let conversationId: string | undefined;
  let completed = false;
  let stalled = false;
  let lastEventAt = Date.now();
  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt > deadlineMs) {
      stalled = true;
      reader.cancel(new StreamStall()).catch(() => {});
    }
  }, STALL_WATCHDOG_TICK_MS);
  const handleEvent = (raw: string): void => {
    if (!raw) return;
    lastEventAt = Date.now();
    if (raw.startsWith(":")) return; // heartbeat comment
    let dataText = "";
    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith("data:")) dataText += line.slice(5).trimStart() + "\n";
    }
    const payload = dataText.trim();
    if (!payload) return;
    if (payload === "[DONE]") { completed = true; return; }
    try {
      const ev = JSON.parse(payload) as Record<string, any>;
      const conv = findConversationId(ev);
      if (conv) conversationId = conv;
      const c = classifyStreamEvent(ev);
      if (c.kind === "text") output += c.text;
      else if (c.kind === "done") completed = true;
    } catch { /* partial JSON junk — ignore */ }
  };
  const flush = (): void => {
    if (buffer.trim()) { handleEvent(buffer.trim()); buffer = ""; }
  };
  try {
    for (;;) {
      if (Date.now() > wallDeadlineAt) { reader.cancel(new Error("per_attempt_timeout")).catch(() => {}); break; }
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.indexOf("\n\n");
      while (idx >= 0) {
        handleEvent(buffer.slice(0, idx).trim());
        buffer = buffer.slice(idx + 2);
        idx = buffer.indexOf("\n\n");
      }
    }
    flush();
  } catch (e) {
    flush();
    if (!stalled && !(e instanceof StreamStall)) {
      if ((e as Error)?.name === "AbortError") stalled = true;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
    clearInterval(watchdog);
  }
  return { output, conversationId, completed, stalled };
}

const RESUME_LEAD =
  "Your previous response was interrupted by an upstream stream timeout. " +
  "Resume from the partial output below, continuing exactly where it cut off — " +
  "do not repeat content already produced (thinking may differ; that is fine):\n---BEGIN PARTIAL OUTPUT---\n";
const RESUME_TAIL = "\n---END PARTIAL OUTPUT---\nContinue now.";

function buildResumeInput(original: string, partial: string): string {
  if (!partial.trim()) return original;
  const trimmed = partial.length > 6000 ? `…${partial.slice(-6000)}` : partial;
  return `${original}\n\n${RESUME_LEAD}${trimmed}${RESUME_TAIL}`;
}

function looksLikeStreamIdleKill(
  status: number | null,
  text: string,
  err?: { name?: string; message?: string },
): boolean {
  const hay = `${text ?? ""} ${err?.message ?? ""}`.toLowerCase();
  return (
    (status === 408 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529
      || status == null) &&
    (hay.includes("no content events") || hay.includes("stream idle") || hay.includes("stream-idle") ||
      (hay.includes("timed out") && hay.includes("no content")) || hay.includes("stream_idle_stall"))
  );
}


export interface AskOptions {
  url: string;
  token: string;
  input: string;
  chain: string[];
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  retryDelayMs?: number;
  maxAttemptsPerModel?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Opt-in: open /zo/ask as SSE and auto-resume conversations killed by the
   *  host stream-idle watchdog. Off by default — identical to prior behavior. */
  streamResume?: boolean;
  /** Abort any stream with this much silence between SSE events (default
   *  STREAM_STALL_TIMEOUT_MS, hardwired under the observed ~120s host kill). */
  stallTimeoutMs?: number;
  /** Max resume posts to the same conversation after a stall kill. Default 2. */
  maxStreamResumes?: number;
  /** Hard wall-clock cap on one physical attempt incl. paused read loops. */
  perAttemptTimeoutMs?: number;
}

interface StreamRequestExtras {
  stream: boolean;
  conversationId?: string;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface CallOutcome {
  ok: boolean;
  status: number | null;
  output?: string;
  conversationId?: string;
  detail?: string;
  transient?: boolean;
  /** True when the attempt ran over the SSE path (for trail detail notes). */
  streamed?: boolean;
}

async function callStreamOnce(
  model: string,
  opts: AskOptions,
  extras: StreamRequestExtras,
  fetchImpl: FetchLike,
  timeoutMs: number,
  inputOverride?: string,
): Promise<CallOutcome> {
  const wallDeadlineAt = Date.now() + Math.max(30_000, opts.perAttemptTimeoutMs ?? timeoutMs);
  const controller = new AbortController();
  let parsed: ParsedStream | null = null;
  const body: Record<string, unknown> = {
    input: inputOverride ?? opts.input,
    model_name: model,
    stream: extras.stream,
  };
  if (extras.conversationId) body.conversation_id = extras.conversationId;
  try {
    const resp = await fetchImpl(opts.url, {
      method: "POST",
      headers: {
        Authorization: opts.token,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      return {
        ok: false,
        status: resp.status,
        detail: text.slice(0, 300).replace(/\s+/g, " "),
        transient: isTransientHttp(resp.status, text),
      };
    }
    if (!resp.body) {
      return { ok: false, status: resp.status, detail: "SSE response had no body", transient: true };
    }
    parsed = await readSseStream(
      resp.body,
      Math.max(5_000, opts.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS),
      wallDeadlineAt,
    );
    const output = parsed.output;
    if (parsed.completed && output.trim()) {
      return { ok: true, status: resp.status, output, conversationId: parsed.conversationId ?? extras.conversationId };
    }
    if (parsed.stalled) {
      return {
        ok: false,
        status: resp.status,
        detail: "stream_idle_stall",
        conversationId: parsed.conversationId ?? extras.conversationId,
        output: output || undefined,
        transient: true,
      };
    }
    return {
      ok: false,
      status: resp.status,
      detail: "stream ended without completion marker",
      conversationId: parsed.conversationId ?? extras.conversationId,
      output: output || undefined,
      transient: true,
    };
  } catch (e: any) {
    return {
      ok: false,
      status: null,
      detail: `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`,
      transient: true,
      conversationId: extras.conversationId,
    };
  } finally {
    controller.abort();
  }
}

async function callOnce(
  model: string,
  opts: AskOptions,
  fetchImpl: FetchLike,
  timeoutMs: number
): Promise<CallOutcome> {
  try {
    const resp = await fetchImpl(opts.url, {
      method: "POST",
      headers: {
        Authorization: opts.token,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ input: opts.input, model_name: model }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await resp.text();
    if (resp.ok) {
      try {
        const data = JSON.parse(text) as { output?: string; conversation_id?: string };
        return { ok: true, status: resp.status, output: data.output ?? "", conversationId: data.conversation_id };
      } catch {
        return { ok: true, status: resp.status, output: text }; // non-JSON 200 → body is the output
      }
    }
    return {
      ok: false,
      status: resp.status,
      detail: text.slice(0, 300).replace(/\s+/g, " "),
      transient: isTransientHttp(resp.status, text),
    };
  } catch (e: any) {
    // Network error / timeout — treat as transient (retry once, then rotate).
    return { ok: false, status: null, detail: `${e?.name ?? "Error"}: ${e?.message ?? String(e)}`, transient: true };
  }
}

/**
 * Call /zo/ask, rotating model_name across the chain on transient failures. Each
 * model gets ONE same-provider retry (after retryDelayMs) before rotation.
 * Resolves with the first success; rejects with the full trail attached (.trail)
 * if every model in the chain is exhausted.
 *
 * opts.streamResume === true switches each attempt to the SSE transport:
 *  - stream:true + accept: text/event-stream; text-part deltas accumulate.
 *  - A stall watchdog aborts when no event arrives for stallTimeoutMs
 *    (default STREAM_STALL_TIMEOUT_MS = 130s, under the ~120s container
 *    no-content-events ceiling observed 2026-09-22).
 *  - On stall, the attempt RESUMES same model via conversation_id, leading with
 *    RESUME_LEAD + the accumulated partial output, up to maxStreamResumes
 *    (default 2) before the failover trail counts one attempt failure.
 *  - Safe only when the endpoint semantics tolerate streamed text = final
 *    output (no output_format envelope consumers).
 *
 * streamResume defaults OFF — all pre-existing callers keep synchronous JSON.
 */
export async function askStreamWithResume(
  model: string,
  opts: AskOptions,
  fetchImpl: FetchLike,
  timeoutMs: number,
  stallTimeoutMs: number,
  maxStreamResumes: number,
  trail: AskAttempt[],
  attempt: number,
): Promise<CallOutcome> {
  const base = { model, attempt };
  const streamOpts = { ...opts, timeoutMs, stallTimeoutMs };
  let conversationId: string | undefined;
  let partial = "";
  for (let leg = 0; leg <= maxStreamResumes; leg++) {
    const isResume = leg > 0 && Boolean(conversationId);
    const r = await callStreamOnce(
      model,
      streamOpts,
      { stream: true, conversationId },
      fetchImpl,
      timeoutMs,
      isResume ? opts.input + "\n\nContinue exactly where you left off. Do not restate anything you already output." : undefined,
    );
    if (r.ok) {
      const output = isResume && partial ? joinPartial(partial, r.output ?? "") : (r.output ?? partial);
      return { ok: true, status: r.status, output, conversationId: r.conversationId ?? conversationId, streamed: true };
    }
    if (r.conversationId) conversationId = r.conversationId;
    if (r.output) partial = partial ? joinPartial(partial, r.output) : r.output;
    trail.push({ ...base, ok: false, status: r.status, detail: `${isResume ? `resume ${leg}` : "initial stream"}: ${r.detail ?? "stream failed"}` });
    if (!conversationId || leg >= maxStreamResumes) {
      return { ok: false, status: r.status, detail: r.detail ?? "stream failed", conversationId, transient: r.transient ?? true, streamed: true, output: partial || undefined };
    }
  }
  return { ok: false, status: null, detail: "stream exhausted resumes", conversationId, transient: true, streamed: true, output: partial || undefined };
}

export async function askWithFailover(opts: AskOptions): Promise<AskResult> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000; // agentic runs are long-lived
  const retryDelayMs = opts.retryDelayMs ?? 2500;
  const sleep = opts.sleep ?? defaultSleep;
  const chain = opts.chain.length ? opts.chain : [...DEFAULT_MODEL_CHAIN];
  const maxAttemptsPerModel = opts.maxAttemptsPerModel ?? 2;
  if (!Number.isSafeInteger(maxAttemptsPerModel) || maxAttemptsPerModel < 1) {
    throw new Error("maxAttemptsPerModel must be a positive safe integer");
  }
  const streamResume = opts.streamResume === true;
  const stallTimeoutMs = opts.stallTimeoutMs ?? STREAM_STALL_TIMEOUT_MS;
  const maxStreamResumes = opts.maxStreamResumes ?? 2;
  const trail: AskAttempt[] = [];

  for (const model of chain) {
    for (let attempt = 1; attempt <= maxAttemptsPerModel; attempt++) {
      let r: CallOutcome;
      if (streamResume) {
        r = await askStreamWithResume(model, opts, fetchImpl, timeoutMs, stallTimeoutMs, maxStreamResumes, trail, attempt);
      } else {
        r = await callOnce(model, opts, fetchImpl, timeoutMs);
      }
      if (r.ok) {
        trail.push({ model, attempt, status: r.status, ok: true, detail: "ok" });
        return { output: r.output ?? "", model, conversationId: r.conversationId, trail };
      }
      trail.push({ model, attempt, status: r.status, ok: false, detail: r.detail ?? "" });
      if (r.transient && attempt < maxAttemptsPerModel) {
        await sleep(retryDelayMs); // one same-provider retry
        continue;
      }
      break; // non-transient, or transient after retry → rotate to next model
    }
  }

  const summary = trail.map((t) => `${t.model}#${t.attempt}=${t.status ?? "throw"}`).join(" → ");
  const err = new Error(
    `/zo/ask failover exhausted after ${trail.length} attempt(s) across ${chain.length} model(s): ${summary}`
  );
  (err as Error & { trail: AskAttempt[] }).trail = trail;
  throw err;
}

/** Compact one-line rendering of a failover trail for logs / exec records. */
export function formatTrail(trail: AskAttempt[]): string {
  return trail.map((t) => `${t.model}#${t.attempt}=${t.ok ? "ok" : (t.status ?? "throw")}`).join(" → ");
}
