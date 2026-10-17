#!/usr/bin/env bun
/**
 * Harness-backed seat execution for the persona panel.
 *
 * Why this exists
 * ---------------
 * The persona panel (persona-panel.ts) re-keyed seat identity on persona, but
 * seat *execution* still went through `callMoaModel` — Zo-era BYOK model routes
 * that are retired on this host, so every gate run held at preflight with "no
 * transport- and schema-healthy route". The panel had personas with nowhere to
 * sit. This module is the missing seat executor: each panel seat is dispatched
 * to its resolved local harness through the swarm `ExecutorClient`, with the
 * persona carried as the seat identity. The model string the gate passes is
 * ignored on purpose — with a persona panel the model is execution metadata,
 * and the harness runs whatever model it is configured with.
 *
 * Contract notes
 * --------------
 * - Returns a `CallModel`-shaped function for `consensus-quality-gate.ts`.
 *   Routing is by `options.seat.seat` (seat name), because the panel transport
 *   profile deliberately gives every seat the same model id.
 * - Never throws. A harness failure, a held seat (no live harness in the
 *   chain), or missing seat context returns `ok: false`, which the gate
 *   already treats as an unavailable seat -> HOLD. A suggester/executor that
 *   can crash the gate is worse than a held panel.
 * - `temperature` / `maxTokens` are accepted and ignored: harness CLIs do not
 *   take them. Prompts already instruct the exact JSON shape the gate parses.
 * - Shadow only. This executes reviews; it does not change the gate's
 *   `enforcement: "disabled"` / `profileStatus: "shadow"` posture.
 */
import { ExecutorClient } from "../../zo-swarm-orchestrator/src/client/executor-client";
import type { MoaCallResult } from "./moa-runtime";
import type { PanelSeat, PersonaPanelArtifact } from "./persona-panel";

/** Seat context the gate attaches to each call so the executor can route it. */
export interface SeatCallContext {
  seat: string;
  role: "reviewer" | "adjudicator";
  personaId?: string;
  personaName?: string;
  domain?: string;
}

/** Minimal client surface, so tests can inject a fake without a registry. */
export interface SeatClient {
  run(prompt: string, opts: Record<string, unknown>): Promise<{ output: string; success: boolean; durationMs: number }>;
}

export type SeatClientFactory = (harness: string) => Promise<SeatClient>;

export interface HarnessSeatCallModelOptions {
  panel: PersonaPanelArtifact;
  /** Factory override for tests. Defaults to swarm ExecutorClient per harness. */
  clientFactory?: SeatClientFactory;
  /** Registry the ExecutorClient loads executor entries from. */
  registryPath?: string;
  /** Repo root used to resolve registry-relative bridge/adapter paths. */
  workspaceRoot?: string;
  /** Per-call harness timeout. Default 180s (CLI cold start + review). */
  timeoutMs?: number;
  /** Working directory handed to the harness. Default: process cwd. */
  workdir?: string;
}

const DEFAULT_TIMEOUT_MS = 180_000;

function failure(model: string, provider: string, error: string, latencyMs = 0): MoaCallResult {
  return {
    model,
    provider,
    ok: false,
    text: "",
    source: "none",
    latencyMs,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    error,
  };
}

export function createHarnessSeatCallModel(options: HarnessSeatCallModelOptions) {
  const seats = new Map<string, PanelSeat>(
    [...options.panel.reviewers, options.panel.adjudicator].map((seat) => [seat.seat, seat]),
  );
  const clients = new Map<string, Promise<SeatClient>>();
  const clientFactory: SeatClientFactory =
    options.clientFactory ??
    (async (harness: string) =>
      ExecutorClient.for(harness, {
        registryPath: options.registryPath,
        workspaceRoot: options.workspaceRoot,
      }));

  const clientFor = (harness: string): Promise<SeatClient> => {
    let pending = clients.get(harness);
    if (!pending) {
      pending = clientFactory(harness);
      clients.set(harness, pending);
    }
    return pending;
  };

  return async (
    model: string,
    prompt: string,
    callOptions: { maxTokens: number; temperature: number; system?: string; seat?: SeatCallContext },
  ): Promise<MoaCallResult> => {
    const started = Date.now();
    const seatName = callOptions.seat?.seat;
    if (!seatName) {
      return failure(model, "harness:none", "harness seat execution requires seat context");
    }
    const seat = seats.get(seatName);
    if (!seat) {
      return failure(model, "harness:none", `unknown panel seat: ${seatName}`);
    }
    const harness = seat.resolvedHarness;
    if (!harness) {
      return failure(model, "harness:none", `seat ${seatName} is held: no live harness in chain [${seat.binding.chain.join(", ")}]`);
    }
    const provider = `harness:${harness}`;
    try {
      const client = await clientFor(harness);
      const identity =
        `You are acting as ${seat.personaName}, the panel seat chartered for ${seat.domain}. ` +
        `Answer exactly in the format the request specifies and nothing else.`;
      const fullPrompt = [callOptions.system, identity, prompt].filter(Boolean).join("\n\n");
      const result = await client.run(fullPrompt, {
        persona: seat.personaName,
        seat: seatName,
        skipRAG: true,
        timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        workdir: options.workdir ?? process.cwd(),
      });
      const latencyMs = result.durationMs || Date.now() - started;
      if (!result.success) {
        return failure(model, provider, `harness ${harness} reported failure for seat ${seatName}`, latencyMs);
      }
      if (!result.output?.trim()) {
        return failure(model, provider, `harness ${harness} returned empty output for seat ${seatName}`, latencyMs);
      }
      return {
        model: provider,
        provider,
        ok: true,
        text: result.output,
        source: "content",
        latencyMs,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
    } catch (error) {
      return failure(model, provider, error instanceof Error ? error.message : String(error), Date.now() - started);
    }
  };
}
