#!/usr/bin/env bun
import { parseArgs } from "util";
import { callMoaModel } from "./moa-runtime";
import {
  buildProviderFallbackChain,
  loadProviderCatalogs,
  providerForConsensusModel,
  writeRouteHealth,
  type ResilientProvider,
} from "./provider-resilience";
import { resolveConsensusLineup } from "./consensus-lineup";

const REQUIRED_PROVIDERS: ResilientProvider[] = ["zo-byok", "openrouter", "opencode", "synthetic"];

export function buildAudit() {
  const lineup = resolveConsensusLineup();
  const catalogs = loadProviderCatalogs();
  const seats = lineup.models.map((primary) => {
    const primaryProvider = providerForConsensusModel(primary);
    const fallbacks = buildProviderFallbackChain(primary, catalogs);
    const coveredProviders = new Set<ResilientProvider>([primaryProvider, ...fallbacks.map((fallback) => fallback.provider)]);
    const missingProviders = REQUIRED_PROVIDERS.filter((provider) => !coveredProviders.has(provider));
    return {
      primary,
      primaryProvider,
      fallbacks: fallbacks.map((fallback) => ({ id: fallback.id, provider: fallback.provider })),
      coveredProviders: [...coveredProviders],
      missingProviders,
      coverageOk: missingProviders.length === 0,
    };
  });
  return {
    lineupSource: lineup.source,
    lineupProfile: lineup.profile,
    requiredProviders: REQUIRED_PROVIDERS,
    coverageOk: seats.every((seat) => seat.coverageOk),
    seats,
  };
}

async function probeAudit(audit: ReturnType<typeof buildAudit>) {
  const routes = [...new Map(
    audit.seats.flatMap((seat) => [
      { id: seat.primary, provider: seat.primaryProvider },
      ...seat.fallbacks,
    ]).map((route) => [route.id, route]),
  ).values()];
  const results: Array<{ id: string; provider: string; ok: boolean; latencyMs: number; error?: string }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, routes.length) }, async () => {
    while (cursor < routes.length) {
      const route = routes[cursor++];
      const result = await callMoaModel(route.id, "Reply with exactly OK", { maxTokens: 64, temperature: 0 });
      results.push({
        id: route.id,
        provider: result.provider,
        ok: result.ok,
        latencyMs: result.latencyMs,
        ...(result.error ? { error: result.error.slice(0, 160) } : {}),
      });
    }
  });
  await Promise.all(workers);
  results.sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
  writeRouteHealth(results);
  const health = new Map(results.map((result) => [result.id, result]));
  const seatProviderHealth = audit.seats.map((seat) => {
    const routes = [{ id: seat.primary, provider: seat.primaryProvider }, ...seat.fallbacks];
    const providers = Object.fromEntries(audit.requiredProviders.map((provider) => {
      const candidates = routes.filter((route) => route.provider === provider);
      return [provider, {
        healthy: candidates.some((candidate) => health.get(candidate.id)?.ok),
        candidates: candidates.map((candidate) => ({ id: candidate.id, ok: health.get(candidate.id)?.ok ?? false })),
      }];
    }));
    return { primary: seat.primary, providers };
  });
  const resilienceHealthy = seatProviderHealth.every((seat) =>
    Object.values(seat.providers).every((provider) => provider.healthy),
  );
  return { allRoutesHealthy: results.every((result) => result.ok), resilienceHealthy, seatProviderHealth, results };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      probe: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(`Provider Resilience Audit

Usage:
  bun scripts/provider-resilience-audit.ts [--probe] [--json]

Checks every active consensus seat for fallback coverage across Zo BYOK,
OpenRouter, OpenCode, and Synthetic. --probe calls every exact planned route.`);
    return;
  }
  const audit = buildAudit();
  const probes = values.probe ? await probeAudit(audit) : undefined;
  const result = { ...audit, ...(probes ? { probes } : {}) };
  if (values.json) console.log(JSON.stringify(result, null, 2));
  else {
    for (const seat of audit.seats) {
      console.log(`${seat.coverageOk ? "PASS" : "FAIL"} ${seat.primary} (${seat.primaryProvider})`);
      for (const fallback of seat.fallbacks) console.log(`  -> ${fallback.provider}: ${fallback.id}`);
      if (seat.missingProviders.length) console.log(`  missing: ${seat.missingProviders.join(", ")}`);
    }
    if (probes) {
      for (const probe of probes.results) console.log(`${probe.ok ? "PASS" : "FAIL"} ${probe.provider}: ${probe.id} (${probe.latencyMs}ms)${probe.error ? ` ${probe.error}` : ""}`);
    }
  }
  if (!audit.coverageOk || (probes && !probes.resilienceHealthy)) process.exitCode = 1;
}

if (import.meta.main) main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
