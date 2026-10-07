#!/usr/bin/env bun
import { parseArgs } from "util";
import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { callMoaModel } from "./moa-runtime";
import { loadRouteHealth, providerForConsensusModel, writeRouteHealth } from "./provider-resilience";

const LINEUP_PATH = `${process.env.HOME}/.zouroboros/lineup.json`;
// Resolved against the repo checkout: packages/consensus-gate/scripts → repo root → factory/lane.
const CAPABILITY_SCRIPT = resolve(import.meta.dir, "..", "..", "..", "factory", "lane", "scripts", "consensus-capability.ts");
const DEFAULT_MAX_AGE_HOURS = 6;

interface Seat {
  id: string;
  name: string;
  role: string;
  provider: string;
}

/**
 * Seats are read from the persisted lineup rather than resolveConsensusLineup()
 * so the probe covers exactly the rows the /zouroboros/health panel renders.
 * resolveConsensusLineup() drops the aggregator and is env-sensitive, which
 * would let "seats at risk" disagree with what was actually probed.
 */
export function loadSeats(path = LINEUP_PATH): Seat[] {
  if (!existsSync(path)) return [];
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    members?: { id: string; name?: string; role?: string; provider?: string }[];
  };
  return (parsed.members ?? []).map((member) => ({
    id: member.id,
    name: member.name ?? member.id,
    role: member.role ?? "proposer",
    provider: member.provider ?? providerForConsensusModel(member.id),
  }));
}

async function probeTransport(seats: Seat[], maxAgeMs: number, force: boolean) {
  const fresh = force ? {} : loadRouteHealth(Date.now());
  const stale = seats.filter((seat) => {
    const record = fresh[seat.id];
    if (!record) return true;
    const age = Date.now() - Date.parse(record.observedAt);
    return !Number.isFinite(age) || age > maxAgeMs;
  });
  if (stale.length === 0) return { probed: [] as any[], skipped: seats.length };

  const results: Array<{ id: string; provider: string; ok: boolean; latencyMs: number; error?: string }> = [];
  let cursor = 0;
  const workers = Array.from({ length: Math.min(3, stale.length) }, async () => {
    while (cursor < stale.length) {
      const seat = stale[cursor++];
      const result = await callMoaModel(seat.id, "Reply with exactly OK", { maxTokens: 64, temperature: 0 });
      results.push({
        id: seat.id,
        provider: result.provider,
        ok: result.ok,
        latencyMs: result.latencyMs,
        ...(result.error ? { error: result.error.slice(0, 160) } : {}),
      });
    }
  });
  await Promise.all(workers);
  writeRouteHealth(results);
  return { probed: results, skipped: seats.length - stale.length };
}

async function probeCapability(seats: Seat[], maxAgeHours: number, force: boolean) {
  if (!existsSync(CAPABILITY_SCRIPT)) {
    throw new Error(`capability prober missing at ${CAPABILITY_SCRIPT}`);
  }
  const args = [
    "bun", CAPABILITY_SCRIPT, "refresh",
    "--models", seats.map((seat) => seat.id).join(","),
    "--max-age-hours", String(maxAgeHours),
    "--json",
  ];
  if (force) args.push("--force");
  const child = Bun.spawn(args, { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`capability prober returned unparseable output: ${(stderr || stdout).slice(0, 200)}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      help: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      "max-age-hours": { type: "string" },
      models: { type: "string" },
      "transport-only": { type: "boolean", default: false },
      "capability-only": { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(`Seat Health Probe

Usage:
  bun scripts/seat-health-probe.ts [--force] [--json] [--max-age-hours 6]
                                   [--models id,id] [--transport-only|--capability-only]

Probes only the seats in the persisted lineup (~/.zouroboros/lineup.json) on both
lanes — transport reachability and capability (can it return a parseable verdict) —
and writes both into provider-resilience-health.json, which /zouroboros/health reads.

Routes with evidence newer than --max-age-hours are skipped, so running this on the
routing TTL costs nothing when the store is already fresh. Use provider-resilience-audit.ts
--probe for the full fallback-catalog sweep; this command deliberately does not probe
fallbacks.`);
    return;
  }

  const maxAgeHours = Number.parseFloat(String(values["max-age-hours"] ?? DEFAULT_MAX_AGE_HOURS));
  const maxAgeMs = (Number.isFinite(maxAgeHours) ? maxAgeHours : DEFAULT_MAX_AGE_HOURS) * 3_600_000;

  const override = String(values.models ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const seats: Seat[] = override.length
    ? override.map((id) => ({ id, name: id, role: "override", provider: providerForConsensusModel(id) }))
    : loadSeats();

  if (seats.length === 0) {
    console.error("No seats to probe — lineup.json has no members. Run lineup-picker.ts first.");
    process.exitCode = 2;
    return;
  }

  const transport = values["capability-only"]
    ? null
    : await probeTransport(seats, maxAgeMs, Boolean(values.force));
  const capability = values["transport-only"]
    ? null
    : await probeCapability(seats, maxAgeHours, Boolean(values.force));

  const unusable = seats.filter((seat) => {
    const t = transport?.probed.find((r: any) => r.id === seat.id);
    if (t && !t.ok) return true;
    const c = capability?.results?.find((r: any) => r.id === seat.id);
    return Boolean(c && !c.capable);
  });

  const summary = {
    seats: seats.length,
    transport: transport ? { probed: transport.probed.length, skipped: transport.skipped, failing: transport.probed.filter((r: any) => !r.ok).length } : null,
    capability: capability ? { refreshed: capability.refreshed, probed: capability.probed, capable: capability.capable, reason: capability.reason } : null,
    unusableSeats: unusable.map((seat) => seat.id),
  };

  if (values.json) {
    console.log(JSON.stringify({ summary, transport, capability }, null, 2));
  } else {
    console.log(`seats: ${seats.length}`);
    if (transport) {
      console.log(`transport: probed ${transport.probed.length}, skipped ${transport.skipped} (fresh)`);
      for (const result of transport.probed) {
        console.log(`  ${result.ok ? "PASS" : "FAIL"} ${result.provider}: ${result.id} (${result.latencyMs}ms)${result.error ? ` ${result.error}` : ""}`);
      }
    }
    if (capability) {
      console.log(`capability: ${capability.refreshed ? "refreshed" : "skipped"} — ${capability.reason}; ${capability.capable}/${seats.length} capable`);
      for (const result of capability.results ?? []) {
        console.log(`  ${result.capable ? "CAPABLE " : "UNUSABLE"} ${result.provider}: ${result.id}${result.failure ? ` — ${result.failure}` : ""}`);
      }
    }
    console.log(unusable.length === 0 ? "all seats usable" : `UNUSABLE SEATS: ${unusable.map((s) => s.id).join(", ")}`);
  }

  if (unusable.length > 0) process.exitCode = 1;
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
