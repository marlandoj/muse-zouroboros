#!/usr/bin/env bun
/**
 * valve-ask-server.ts — HTTP socket for the gate escalation valve.
 *
 * WHY: Anthropic now meters Claude Code + ACP (Zo chat) at API rates for every
 * Anthropic model. The cheapest protection is to call Anthropic LESS OFTEN. The
 * valve (escalation-valve.ts) does exactly that: a cheap non-Anthropic generator
 * (MoA) answers first, the consensus panel votes on sufficiency, and we only
 * escalate to Opus when the cheap answer is judged inadequate. This server is the
 * deployable seam — any caller WE control (agents, automations, ACP scripts, a
 * future platform interception hook) POSTs a task here and gets a ration-protected
 * answer instead of calling Opus directly.
 *
 * PLATFORM BOUNDARY (read this before assuming this "intercepts" interactive chat):
 *   The Zo interactive-chat model call is made by the Zo platform, NOT by code we
 *   control. model-route-gate.ts only CLASSIFIES a message and emits a behavioral
 *   directive / persona switch; it never makes the model call itself. So this
 *   socket cannot transparently sit in front of the live interactive Complex-tier
 *   call today. What it CAN do — and does — is (a) serve every controllable caller
 *   the cheap-first→gate→escalate path now, and (b) back the route-gate's opt-in
 *   shadow probe (VALVE_SHADOW) that measures, at the exact complex-tier decision
 *   point, how often the cheap answer WOULD have sufficed. The day the platform
 *   exposes a real interception hook, the answer is already being produced here.
 *
 * Endpoints:
 *   GET  /health     — uptime, openrouter readiness, panel models, escalate default
 *   POST /valve/ask  — { task, criteria?, escalateModel?, cheap?, models?, forceEscalate? }
 *                      → ValveResult (escalated, answer, reason, sufficiency, cheap, escalation)
 *
 * Auth: reuses ZO_GATE_TOKEN (same secret the memory gate uses). /valve/ask is
 * gated (constant-time bearer, fail-closed when the token is unset); /health is open.
 *
 * Launch (API keys from operator-managed env vars — see docs/api-keys.md):
 *   bun packages/consensus-gate/scripts/valve-ask-server.ts
 *   (default port 7821; override with VALVE_PORT)
 */

import { createHash, timingSafeEqual } from "crypto";
import { runValve, type CheapSpec, type MoaConfig, DEFAULT_MOA } from "./escalation-valve.ts";
import { getActiveModels } from "./quarantine.ts";

const PORT = parseInt(process.env.VALVE_PORT || "7821");
const HOST = process.env.ZO_GATE_HOST || "127.0.0.1";
const startedAt = Date.now();

const GATE_TOKEN = process.env.ZO_GATE_TOKEN || "";
if (!GATE_TOKEN) {
  console.error(
    "[valve-ask-server] WARNING: ZO_GATE_TOKEN is unset — /valve/ask will deny all requests (fail closed). Set ZO_GATE_TOKEN in your operator-managed env file (see docs/api-keys.md).",
  );
}

function sha256(s: string): Buffer {
  return createHash("sha256").update(s).digest();
}

function isAuthorized(req: Request): boolean {
  if (!GATE_TOKEN) return false; // fail closed
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  return timingSafeEqual(sha256(m[1]), sha256(GATE_TOKEN));
}

interface AskBody {
  task?: string;
  criteria?: string;
  escalateModel?: string;
  models?: string[];
  forceEscalate?: boolean;
  escalateMode?: "solo" | "panel"; // Experiment C — "panel": Opus joins the MoA panel on gate-FAIL
  escalateAggregator?: string; // round-2 fusion judge override (Opus-as-judge knob)
  // cheap spec: "moa" | "single:<slug>" | { proposers, aggregator, ... }
  cheap?: "moa" | string | (Partial<MoaConfig> & { kind?: never });
}

function parseCheap(cheap: AskBody["cheap"]): CheapSpec | undefined {
  if (!cheap) return undefined;
  if (cheap === "moa") return { kind: "moa", cfg: DEFAULT_MOA };
  if (typeof cheap === "string") {
    const model = cheap.startsWith("single:") ? cheap.slice("single:".length) : cheap;
    return { kind: "single", model };
  }
  // object → MoA config override (merge over defaults)
  return { kind: "moa", cfg: { ...DEFAULT_MOA, ...cheap } };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // valve runs can take ~20s (cheap gen + 3-model sufficiency panel + optional escalate)
  idleTimeout: 120,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/health" && req.method === "GET") {
      let panel: string[] = [];
      try {
        panel = getActiveModels();
      } catch { /* quarantine config missing — report empty panel, still healthy */ }
      return Response.json({
        status: "ok",
        uptime_s: Math.round((Date.now() - startedAt) / 1000),
        port: PORT,
        openrouter_ready: Boolean(process.env.OPENROUTER_API_KEY),
        zo_ask_ready: Boolean(process.env.ZO_TOKEN || process.env.ZO_CLIENT_IDENTITY_TOKEN),
        auth_required: Boolean(GATE_TOKEN),
        panel_models: panel,
        panel_size: panel.length,
        default_escalate_model: "claude-opus-4-8",
      });
    }

    if (url.pathname === "/valve/ask" && req.method === "POST") {
      if (!isAuthorized(req)) {
        return Response.json({ error: "unauthorized" }, { status: 401 });
      }
      let body: AskBody;
      try {
        body = (await req.json()) as AskBody;
      } catch {
        return Response.json({ error: "invalid JSON body" }, { status: 400 });
      }
      if (!body.task || !body.task.trim()) {
        return Response.json({ error: "missing 'task' field" }, { status: 400 });
      }
      try {
        const result = await runValve(body.task, {
          cheap: parseCheap(body.cheap),
          escalateModel: body.escalateModel,
          criteria: body.criteria,
          models: body.models,
          forceEscalate: body.forceEscalate,
          escalateMode: body.escalateMode === "panel" ? "panel" : undefined,
          escalateAggregator: body.escalateAggregator,
        });
        return Response.json(result);
      } catch (err) {
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },
});

console.error(
  `[valve-ask-server] listening on http://${HOST}:${server.port} ` +
    `(openrouter=${process.env.OPENROUTER_API_KEY ? "yes" : "no"}, ` +
    `auth=${GATE_TOKEN ? "on" : "OFF/fail-closed"})`,
);
