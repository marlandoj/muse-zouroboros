#!/usr/bin/env bun
/**
 * FH-03 (P0-3) + FH-22 — Consensus-capability health.
 *
 * The existing resilience probe sends `"Reply with exactly OK"`. That proves a
 * route is *reachable*. It does not prove the route can execute a consensus
 * prompt and return the structured verdict the gate requires, so a model can be
 * marked healthy while being unusable as a consensus seat.
 *
 * That gap produced the ZBRE run's dominant failure class. Seats returned
 * narrative analysis instead of verdict JSON, empty bodies, HTTP 400 from
 * OpenRouter, HTTP 401 from OpenCode, and aborted BYOK calls — eleven of twelve
 * tickets needed a human. The consensus review of the audit report itself
 * reproduced it: one of four seats returned prose and two needed a format
 * re-ask.
 *
 * This module probes the *exact* route with a real consensus-shaped prompt and
 * accepts it only when a `{pass, issues, confidence}` verdict can be recovered.
 * Results extend the existing store at
 * `~/.zouroboros/provider-resilience-health.json` under a `::capability` key —
 * deliberately not a second store, since a second store is the fragmentation
 * this program exists to remove.
 *
 * Why it lives in the factory project rather than `Skills/consensus-gate`:
 * this module reaches the gate the same way `factory-consensus.ts` does — by
 * invoking its CLI — instead of importing gate internals. That is the existing
 * boundary between the two, and it keeps the probe runnable from a clean
 * checkout. The store is a *data* contract shared with
 * `Skills/consensus-gate/scripts/provider-resilience.ts`; its shape (a
 * `{observedAt, routes}` object keyed by route id) is mirrored below and any
 * unrecognized key is preserved on write.
 *
 * FH-22: the store was stale since 2026-07-15 because nothing on the conveyor
 * path refreshed it. `refreshIfStale()` is that trigger, and
 * `project-preflight.ts` calls it before the first promotion of a project.
 *
 * CLI:
 *   bun consensus-capability.ts probe --models a,b [--json]
 *   bun consensus-capability.ts status [--json]
 *   bun consensus-capability.ts refresh --models a,b [--max-age-hours 6] [--force]
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

/** Shared with Skills/consensus-gate/scripts/provider-resilience.ts. */
export const HEALTH_PATH = join(process.env.HOME ?? homedir(), ".zouroboros", "provider-resilience-health.json");

/** Health-store key suffix. Keeps capability distinct from transport/review. */
export const CAPABILITY_SUFFIX = "::capability";

/** Matches the store's own TTL so the two views expire together. */
export const HEALTH_TTL_MS = 6 * 60 * 60 * 1000;

/** A route probed longer ago than this cannot gate a promotion. */
export const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * A minimal but genuine review task. Small enough to be cheap, and unambiguous
 * enough that any competent reviewer returns `pass: false` — though the probe
 * checks contract compliance, never the verdict's value.
 */
export const PROBE_DIFF = [
  "--- a/auth.ts",
  "+++ b/auth.ts",
  "@@ -1,3 +1,3 @@",
  " export function check(token: string, expected: string): boolean {",
  "-  return timingSafeEqual(Buffer.from(token), Buffer.from(expected));",
  "+  return token == expected;",
  " }",
].join("\n");

export const PROBE_PROMPT = [
  "You are a code reviewer. Review the diff below for correctness and security.",
  "",
  "Respond with ONLY a JSON object, no prose, in exactly this shape:",
  '{"pass": <boolean>, "issues": [<string>, ...], "confidence": <number between 0 and 1>}',
  "",
  "```diff",
  PROBE_DIFF,
  "```",
].join("\n");

export type CapabilityFailure =
  | "unreachable"
  | "empty_response"
  | "unparseable_verdict"
  | "incomplete_verdict"
  | null;

export interface CapabilityResult {
  id: string;
  provider: string;
  /** True only when a complete, parseable verdict came back. */
  capable: boolean;
  /** True when the transport succeeded, regardless of verdict shape. */
  reachable: boolean;
  verdict_parseable: boolean;
  failure: CapabilityFailure;
  latencyMs: number;
  error?: string;
  observedAt: string;
}

// ─── Verdict contract ─────────────────────────────────────────────────────────

/** Yield balanced `{...}` slices, string- and escape-aware, in document order. */
function* balancedObjectSlices(text: string): Generator<string> {
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index];
      if (escaped) { escaped = false; continue; }
      if (char === "\\") { escaped = true; continue; }
      if (char === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (char === "{") depth++;
      else if (char === "}") {
        depth--;
        if (depth === 0) { yield text.slice(start, index + 1); break; }
      }
    }
  }
}

/**
 * Recover a verdict object from a raw model response. Mirrors the tolerance of
 * the gate's own extractor: fenced blocks first, then the whole body, then any
 * balanced object embedded in prose.
 */
export function extractVerdict(output: string): Record<string, unknown> | null {
  const candidates: string[] = [];
  for (const match of output.matchAll(/```[\w.-]*[ \t]*\r?\n?([\s\S]*?)(?:```|$)/g)) {
    const body = match[1].trim();
    if (body) candidates.push(body);
  }
  candidates.push(output.trim());

  for (const candidate of candidates) {
    try {
      const direct = JSON.parse(candidate);
      if (direct && typeof direct === "object" && "pass" in direct) return direct as Record<string, unknown>;
    } catch { /* fall through to embedded slices */ }
    for (const slice of balancedObjectSlices(candidate)) {
      try {
        const parsed = JSON.parse(slice);
        if (parsed && typeof parsed === "object" && "pass" in parsed) return parsed as Record<string, unknown>;
      } catch { /* not this slice */ }
    }
  }
  return null;
}

/**
 * Validate a raw response against the consensus verdict contract. Pure — this
 * is the behaviour under test, independent of any network call.
 */
export function evaluateVerdictContract(raw: string | null | undefined): {
  verdict_parseable: boolean;
  failure: CapabilityFailure;
} {
  const text = (raw ?? "").trim();
  if (!text) return { verdict_parseable: false, failure: "empty_response" };

  const parsed = extractVerdict(text);
  // The ZBRE seats that returned narrative analysis land here.
  if (!parsed) return { verdict_parseable: false, failure: "unparseable_verdict" };
  if (typeof parsed.pass !== "boolean") return { verdict_parseable: false, failure: "incomplete_verdict" };

  const confidence = parsed.confidence;
  if (confidence !== undefined && (typeof confidence !== "number" || !Number.isFinite(confidence))) {
    return { verdict_parseable: false, failure: "incomplete_verdict" };
  }
  const issues = parsed.issues ?? parsed.claims;
  if (issues !== undefined && !Array.isArray(issues)) {
    return { verdict_parseable: false, failure: "incomplete_verdict" };
  }
  return { verdict_parseable: true, failure: null };
}

// ─── Health store (shared data contract) ─────────────────────────────────────

export interface RouteHealthRecord {
  ok: boolean;
  provider: string;
  latencyMs: number;
  error?: string;
  observedAt: string;
  healthClass?: string;
}

export function providerForRoute(model: string): string {
  if (model.startsWith("byok:")) return "zo-byok";
  if (model.startsWith("oc:")) return "opencode";
  if (model.startsWith("hf:") || model.startsWith("syn:")) return "synthetic";
  if (model.startsWith("xai:")) return "xai";
  if (model.startsWith("kimi:")) return "kimi";
  return "openrouter";
}

function readStore(path = HEALTH_PATH): { observedAt?: string; routes: Record<string, RouteHealthRecord> } {
  if (!existsSync(path)) return { routes: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { observedAt?: string; routes?: Record<string, RouteHealthRecord> };
    return { observedAt: parsed.observedAt, routes: parsed.routes ?? {} };
  } catch {
    // A corrupt store must not wedge the conveyor; treat it as empty and let
    // the next probe rewrite it.
    return { routes: {} };
  }
}

/**
 * Persist capability results. `ok` carries the *capability* verdict, so a
 * reachable-but-unusable seat reads as unhealthy to every existing consumer
 * that already checks `ok`. Unrelated keys are preserved.
 */
export function persistCapability(
  results: readonly CapabilityResult[],
  options: { path?: string; now?: Date } = {},
): void {
  if (results.length === 0) return;
  const path = options.path ?? HEALTH_PATH;
  const now = options.now ?? new Date();
  const store = readStore(path);
  for (const result of results) {
    store.routes[`${result.id}${CAPABILITY_SUFFIX}`] = {
      ok: result.capable,
      provider: result.provider,
      latencyMs: result.latencyMs,
      healthClass: "capability",
      observedAt: result.observedAt,
      ...(result.error ? { error: result.error } : {}),
    };
  }
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, JSON.stringify({ observedAt: now.toISOString(), routes: store.routes }, null, 2));
  renameSync(temporary, path);
}

export interface CapabilityStatus {
  id: string;
  capable: boolean;
  provider: string;
  observedAt: string;
  ageMs: number;
}

/** Read persisted capability health, dropping records past the TTL. */
export function readCapability(options: { now?: number; path?: string } = {}): Map<string, CapabilityStatus> {
  const now = options.now ?? Date.now();
  const store = readStore(options.path ?? HEALTH_PATH);
  const statuses = new Map<string, CapabilityStatus>();
  for (const [key, record] of Object.entries(store.routes)) {
    if (!key.endsWith(CAPABILITY_SUFFIX)) continue;
    const observed = Date.parse(record.observedAt);
    if (!Number.isFinite(observed) || now - observed > HEALTH_TTL_MS) continue;
    const id = key.slice(0, -CAPABILITY_SUFFIX.length);
    statuses.set(id, {
      id,
      capable: record.ok,
      provider: record.provider,
      observedAt: record.observedAt,
      ageMs: now - observed,
    });
  }
  return statuses;
}

/**
 * Routes proven unusable as consensus seats. A route with no recent capability
 * record is NOT listed: absence of evidence must not silently shrink the panel.
 */
export function incapableRoutes(options: { now?: number; path?: string } = {}): string[] {
  return [...readCapability(options).values()].filter((status) => !status.capable).map((status) => status.id);
}

/**
 * FH-03 — seed for `deadRoutes` in `consensus-gate.ts`, whose module-scope Map
 * starts empty in every process. The factory launches a fresh process per
 * retry, so route failures were forgotten and rediscovered on every attempt.
 * Exported as `provider:vendorModel` pairs, the gate's own key shape.
 */
export function deadRouteSeed(options: { now?: number; path?: string } = {}): Array<{ provider: string; model: string }> {
  return [...readCapability(options).values()]
    .filter((status) => !status.capable)
    .map((status) => ({
      provider: status.provider,
      model: status.id.replace(/^(byok:|oc:|hf:|syn:|xai:|kimi:)/i, ""),
    }));
}

// ─── Probing ─────────────────────────────────────────────────────────────────

export type ProbeCall = (
  model: string,
  prompt: string,
) => Promise<{ ok: boolean; provider?: string; latencyMs: number; content?: string; error?: string }>;

/**
 * Default transport: the consensus gate's own single-model path, invoked as a
 * subprocess. Same boundary `factory-consensus.ts` uses — the factory never
 * imports gate internals.
 */
export const defaultProbeCall: ProbeCall = async (model, prompt) => {
  const repoRoot = join(import.meta.dir, "..", "..", "..");
  const started = Date.now();
  const result = Bun.spawnSync([
    "bun",
    join(repoRoot, "Skills/consensus-gate/scripts/provider-smoke-probe.ts"),
    "--model", model,
    "--prompt", prompt,
    "--json",
  ], { cwd: repoRoot, stdout: "pipe", stderr: "pipe" });
  const latencyMs = Date.now() - started;

  let rows: Array<{ provider?: string; genOk?: boolean; genText?: string; error?: string | null; elapsedMs?: number }>;
  try {
    const parsed = JSON.parse(result.stdout.toString());
    rows = Array.isArray(parsed) ? parsed : (parsed?.results ?? []);
  } catch {
    return {
      ok: false,
      latencyMs,
      error: (result.stderr.toString().trim() || "probe emitted no machine result").slice(0, 200),
    };
  }

  const row = rows[0];
  if (!row) return { ok: false, latencyMs, error: "probe returned no route row" };
  return {
    ok: Boolean(row.genOk),
    provider: row.provider,
    latencyMs: row.elapsedMs ?? latencyMs,
    content: row.genText ?? "",
    ...(row.error ? { error: String(row.error).slice(0, 200) } : {}),
  };
};

export async function probeRoute(
  model: string,
  options: { call?: ProbeCall; now?: string } = {},
): Promise<CapabilityResult> {
  const call = options.call ?? defaultProbeCall;
  const observedAt = options.now ?? new Date().toISOString();
  const provider = providerForRoute(model);

  let response: Awaited<ReturnType<ProbeCall>>;
  try {
    response = await call(model, PROBE_PROMPT);
  } catch (error) {
    return {
      id: model, provider, capable: false, reachable: false, verdict_parseable: false,
      failure: "unreachable", latencyMs: 0,
      error: (error instanceof Error ? error.message : String(error)).slice(0, 200),
      observedAt,
    };
  }

  if (!response.ok) {
    return {
      id: model, provider: response.provider ?? provider, capable: false, reachable: false,
      verdict_parseable: false, failure: "unreachable", latencyMs: response.latencyMs,
      ...(response.error ? { error: response.error } : {}),
      observedAt,
    };
  }

  const contract = evaluateVerdictContract(response.content);
  return {
    id: model,
    provider: response.provider ?? provider,
    capable: contract.verdict_parseable,
    reachable: true,
    verdict_parseable: contract.verdict_parseable,
    failure: contract.failure,
    latencyMs: response.latencyMs,
    ...(contract.failure ? { error: `verdict contract: ${contract.failure}` } : {}),
    observedAt,
  };
}

export async function probeRoutes(
  models: readonly string[],
  options: { call?: ProbeCall; concurrency?: number; now?: string; persist?: boolean; path?: string } = {},
): Promise<CapabilityResult[]> {
  const unique = [...new Set(models)];
  const results: CapabilityResult[] = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(options.concurrency ?? 3, unique.length)) }, async () => {
    while (cursor < unique.length) results.push(await probeRoute(unique[cursor++], options));
  });
  await Promise.all(workers);
  results.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  if (options.persist !== false) persistCapability(results, { path: options.path });
  return results;
}

export interface RefreshOutcome {
  refreshed: boolean;
  reason: string;
  probed: number;
  capable: number;
  /** Lineup routes with usable capability evidence after this refresh. */
  capable_routes: string[];
  results: CapabilityResult[];
}

/**
 * FH-22 — the conveyor-path refresh trigger. Probes only routes whose evidence
 * is missing or older than `maxAgeMs`, so it is cheap enough to call before
 * every promotion and self-heals a store that has gone stale.
 */
export async function refreshIfStale(options: {
  models: readonly string[];
  maxAgeMs?: number;
  now?: number;
  call?: ProbeCall;
  force?: boolean;
  path?: string;
}): Promise<RefreshOutcome> {
  const now = options.now ?? Date.now();
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const models = [...new Set(options.models)];

  if (models.length === 0) {
    return { refreshed: false, reason: "no routes supplied", probed: 0, capable: 0, capable_routes: [], results: [] };
  }

  const known = readCapability({ now, path: options.path });
  const stale = options.force
    ? models
    : models.filter((model) => {
        const status = known.get(model);
        return !status || status.ageMs > maxAgeMs;
      });

  const results = stale.length === 0
    ? []
    : await probeRoutes(stale, { call: options.call, now: new Date(now).toISOString(), path: options.path });

  const after = readCapability({ now, path: options.path });
  const capableRoutes = models.filter((model) =>
    results.find((result) => result.id === model)?.capable ?? after.get(model)?.capable ?? false);

  return {
    refreshed: stale.length > 0,
    reason: stale.length === 0
      ? `all ${models.length} route(s) have capability evidence newer than ${Math.round(maxAgeMs / 3_600_000)}h`
      : `probed ${stale.length} stale or unknown route(s)`,
    probed: results.length,
    capable: capableRoutes.length,
    capable_routes: capableRoutes,
    results,
  };
}

if (import.meta.main) {
  const [cmd] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      models: { type: "string" },
      json: { type: "boolean" },
      force: { type: "boolean" },
      "max-age-hours": { type: "string" },
    },
    strict: false,
  });

  const models = String(values.models ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const maxAgeHours = Number.parseFloat(String(values["max-age-hours"] ?? "6"));
  const maxAgeMs = Number.isFinite(maxAgeHours) ? maxAgeHours * 3_600_000 : DEFAULT_MAX_AGE_MS;

  if (cmd === "probe" || cmd === "refresh") {
    if (models.length === 0) {
      console.error(`Usage: bun consensus-capability.ts ${cmd} --models <id,id> [--json]`);
      process.exit(2);
    }
  }

  if (cmd === "probe") {
    const results = await probeRoutes(models);
    if (values.json) console.log(JSON.stringify(results, null, 2));
    else {
      for (const result of results) {
        console.log(
          `${result.capable ? "CAPABLE " : "UNUSABLE"} ${result.provider}: ${result.id}`
          + ` (${result.latencyMs}ms)${result.failure ? ` — ${result.failure}` : ""}`,
        );
      }
      console.log(`${results.filter((r) => r.capable).length}/${results.length} route(s) can return a verdict`);
    }
    process.exit(results.some((result) => !result.capable) ? 1 : 0);
  } else if (cmd === "status") {
    const statuses = [...readCapability().values()];
    if (values.json) console.log(JSON.stringify(statuses, null, 2));
    else if (statuses.length === 0) console.log("no capability evidence within TTL — run `probe` or `refresh`");
    else {
      for (const status of statuses) {
        console.log(
          `${status.capable ? "CAPABLE " : "UNUSABLE"} ${status.provider}: ${status.id}`
          + ` (${Math.round(status.ageMs / 60_000)}m old)`,
        );
      }
    }
    process.exit(statuses.length === 0 || statuses.some((status) => !status.capable) ? 1 : 0);
  } else if (cmd === "refresh") {
    const outcome = await refreshIfStale({ models, maxAgeMs, force: Boolean(values.force) });
    if (values.json) console.log(JSON.stringify(outcome, null, 2));
    else console.log(`${outcome.refreshed ? "refreshed" : "skipped"} — ${outcome.reason}; ${outcome.capable}/${models.length} capable`);
    process.exit(outcome.capable === 0 ? 1 : 0);
  } else {
    console.log("Usage: bun consensus-capability.ts <probe|status|refresh> --models <id,id> [--max-age-hours 6] [--force] [--json]");
    process.exit(0);
  }
}
