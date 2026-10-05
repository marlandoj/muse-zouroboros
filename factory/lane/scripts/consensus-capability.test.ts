import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAPABILITY_SUFFIX,
  deadRouteSeed,
  evaluateVerdictContract,
  extractVerdict,
  incapableRoutes,
  persistCapability,
  probeRoute,
  probeRoutes,
  providerForRoute,
  readCapability,
  refreshIfStale,
  type ProbeCall,
} from "./consensus-capability";

const dirs: string[] = [];
function storePath(): string {
  const dir = mkdtempSync(join(tmpdir(), "capability-"));
  dirs.push(dir);
  return join(dir, "provider-resilience-health.json");
}

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const VALID = '{"pass": false, "issues": ["timing-unsafe comparison"], "confidence": 0.9}';
/** What a ZBRE seat actually returned instead of a verdict. */
const NARRATIVE =
  "Looking at this diff, the change replaces a constant-time comparison with `==`, "
  + "which introduces a timing side channel. I would not approve this change.";

describe("verdict contract (FH-03)", () => {
  test("accepts a bare verdict object", () => {
    expect(evaluateVerdictContract(VALID)).toEqual({ verdict_parseable: true, failure: null });
  });

  test("accepts a verdict inside a fenced block", () => {
    expect(evaluateVerdictContract("```json\n" + VALID + "\n```").verdict_parseable).toBe(true);
  });

  test("accepts a verdict embedded in surrounding prose", () => {
    expect(evaluateVerdictContract(`Here is my review:\n${VALID}\nHope that helps.`).verdict_parseable).toBe(true);
  });

  test("rejects narrative analysis — the run's dominant failure mode", () => {
    expect(evaluateVerdictContract(NARRATIVE)).toEqual({
      verdict_parseable: false,
      failure: "unparseable_verdict",
    });
  });

  test("rejects an empty body", () => {
    expect(evaluateVerdictContract("").failure).toBe("empty_response");
    expect(evaluateVerdictContract("   \n ").failure).toBe("empty_response");
    expect(evaluateVerdictContract(null).failure).toBe("empty_response");
  });

  test("rejects a JSON object missing or mistyping the required fields", () => {
    expect(evaluateVerdictContract('{"pass": "yes"}').failure).toBe("incomplete_verdict");
    expect(evaluateVerdictContract('{"pass": true, "confidence": "high"}').failure).toBe("incomplete_verdict");
    expect(evaluateVerdictContract('{"pass": true, "issues": "one string"}').failure).toBe("incomplete_verdict");
    expect(evaluateVerdictContract('{"verdict": "ok"}').failure).toBe("unparseable_verdict");
  });

  test("accepts `claims` as an alias for `issues`", () => {
    expect(evaluateVerdictContract('{"pass": true, "claims": []}').verdict_parseable).toBe(true);
  });

  test("extractor is string- and escape-aware inside JSON values", () => {
    const tricky = '{"pass": true, "issues": ["a } brace in a string", "an \\" escaped quote"]}';
    expect(extractVerdict(tricky)?.pass).toBe(true);
  });
});

describe("capability probing (FH-03)", () => {
  const call = (content: string, ok = true): ProbeCall =>
    async () => ({ ok, provider: "synthetic", latencyMs: 120, content });

  test("a reachable route that returns prose is UNUSABLE, not healthy", async () => {
    const result = await probeRoute("hf:vendor/model", {
      call: call(NARRATIVE),
      now: "2026-07-26T18:00:00.000Z",
    });
    expect(result.reachable).toBe(true);
    expect(result.capable).toBe(false);
    expect(result.failure).toBe("unparseable_verdict");
  });

  test("a route that returns a verdict is capable", async () => {
    const result = await probeRoute("hf:vendor/model", { call: call(VALID), now: "2026-07-26T18:00:00.000Z" });
    expect(result.capable).toBe(true);
    expect(result.verdict_parseable).toBe(true);
    expect(result.failure).toBeNull();
  });

  test("a transport failure is unreachable, not an unparseable verdict", async () => {
    const result = await probeRoute("oc:model", {
      call: async () => ({ ok: false, latencyMs: 30_000, error: "API error: 401" }),
      now: "2026-07-26T18:00:00.000Z",
    });
    expect(result).toMatchObject({ reachable: false, capable: false, failure: "unreachable" });
  });

  test("a thrown transport error is caught, not propagated", async () => {
    const result = await probeRoute("oc:model", {
      call: async () => { throw new Error("socket hang up"); },
      now: "2026-07-26T18:00:00.000Z",
    });
    expect(result.failure).toBe("unreachable");
    expect(result.error).toContain("socket hang up");
  });

  test("derives the provider from the route prefix", () => {
    expect(providerForRoute("byok:abc")).toBe("zo-byok");
    expect(providerForRoute("oc:glm")).toBe("opencode");
    expect(providerForRoute("hf:vendor/m")).toBe("synthetic");
    expect(providerForRoute("xai:grok-3-mini")).toBe("xai");
    expect(providerForRoute("z-ai/glm-5.2")).toBe("openrouter");
  });
});

describe("capability store (FH-03 / FH-22)", () => {
  const now = Date.parse("2026-07-26T18:00:00.000Z");

  test("persists capability under its own key and survives a fresh read", async () => {
    const path = storePath();
    await probeRoutes(["hf:a", "hf:b"], {
      call: async (model) => ({ ok: true, provider: "synthetic", latencyMs: 100, content: model === "hf:a" ? VALID : NARRATIVE }),
      now: "2026-07-26T18:00:00.000Z",
      path,
    });
    const statuses = readCapability({ now, path });
    expect(statuses.get("hf:a")?.capable).toBe(true);
    expect(statuses.get("hf:b")?.capable).toBe(false);
    expect(incapableRoutes({ now, path })).toEqual(["hf:b"]);
  });

  test("preserves unrelated keys already in the shared store", () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({
      observedAt: "2026-07-15T05:00:00.000Z",
      routes: { "xai:grok-3-mini::review": { ok: true, provider: "xai", latencyMs: 4866, observedAt: "2026-07-15T05:00:00.000Z" } },
    }));
    persistCapability([{
      id: "hf:a", provider: "synthetic", capable: true, reachable: true, verdict_parseable: true,
      failure: null, latencyMs: 100, observedAt: "2026-07-26T18:00:00.000Z",
    }], { path });
    const raw = JSON.parse(require("node:fs").readFileSync(path, "utf8"));
    expect(raw.routes["xai:grok-3-mini::review"]).toBeDefined();
    expect(raw.routes[`hf:a${CAPABILITY_SUFFIX}`].ok).toBe(true);
  });

  test("evidence past the TTL is not readable — a stale store cannot gate", () => {
    const path = storePath();
    writeFileSync(path, JSON.stringify({
      observedAt: "2026-07-15T05:00:00.000Z",
      routes: { [`hf:a${CAPABILITY_SUFFIX}`]: { ok: true, provider: "synthetic", latencyMs: 1, observedAt: "2026-07-15T05:00:00.000Z" } },
    }));
    expect(readCapability({ now, path }).size).toBe(0);
  });

  test("a corrupt store reads as empty rather than wedging the conveyor", () => {
    const path = storePath();
    writeFileSync(path, "{ not json");
    expect(readCapability({ now, path }).size).toBe(0);
  });

  test("seeds deadRoutes across processes with the gate's key shape", async () => {
    const path = storePath();
    await probeRoutes(["byok:uuid-1", "oc:glm-5.2"], {
      call: async () => ({ ok: true, provider: "zo-byok", latencyMs: 10, content: NARRATIVE }),
      now: "2026-07-26T18:00:00.000Z",
      path,
    });
    const seed = deadRouteSeed({ now, path });
    expect(seed.map((entry) => entry.model).sort()).toEqual(["glm-5.2", "uuid-1"]);
  });

  test("a route with no evidence is not treated as incapable", () => {
    const path = storePath();
    expect(incapableRoutes({ now, path })).toEqual([]);
  });
});

describe("refresh trigger (FH-22)", () => {
  const now = Date.parse("2026-07-26T18:00:00.000Z");

  test("probes routes whose evidence is missing", async () => {
    const path = storePath();
    let calls = 0;
    const outcome = await refreshIfStale({
      models: ["hf:a", "hf:b"],
      now,
      path,
      call: async () => { calls++; return { ok: true, provider: "synthetic", latencyMs: 5, content: VALID }; },
    });
    expect(calls).toBe(2);
    expect(outcome.refreshed).toBe(true);
    expect(outcome.capable).toBe(2);
    expect(outcome.capable_routes.sort()).toEqual(["hf:a", "hf:b"]);
  });

  test("skips routes with fresh evidence — cheap enough to call before every promotion", async () => {
    const path = storePath();
    const call: ProbeCall = async () => ({ ok: true, provider: "synthetic", latencyMs: 5, content: VALID });
    await refreshIfStale({ models: ["hf:a"], now, path, call });

    let calls = 0;
    const second = await refreshIfStale({
      models: ["hf:a"],
      now: now + 60_000,
      path,
      call: async (...args) => { calls++; return call(...args); },
    });
    expect(calls).toBe(0);
    expect(second.refreshed).toBe(false);
    expect(second.capable).toBe(1);
  });

  test("re-probes once the evidence ages past the window — the 2026-07-15 staleness case", async () => {
    const path = storePath();
    const call: ProbeCall = async () => ({ ok: true, provider: "synthetic", latencyMs: 5, content: VALID });
    await refreshIfStale({ models: ["hf:a"], now, path, call });

    let calls = 0;
    const later = await refreshIfStale({
      models: ["hf:a"],
      now: now + 7 * 60 * 60 * 1000,
      path,
      call: async (...args) => { calls++; return call(...args); },
    });
    expect(calls).toBe(1);
    expect(later.refreshed).toBe(true);
  });

  test("--force re-probes regardless of freshness", async () => {
    const path = storePath();
    const call: ProbeCall = async () => ({ ok: true, provider: "synthetic", latencyMs: 5, content: VALID });
    await refreshIfStale({ models: ["hf:a"], now, path, call });
    let calls = 0;
    await refreshIfStale({
      models: ["hf:a"], now, path, force: true,
      call: async (...args) => { calls++; return call(...args); },
    });
    expect(calls).toBe(1);
  });

  test("reports zero capable routes when every seat returns prose", async () => {
    const path = storePath();
    const outcome = await refreshIfStale({
      models: ["hf:a", "hf:b", "oc:c"],
      now,
      path,
      call: async () => ({ ok: true, provider: "synthetic", latencyMs: 5, content: NARRATIVE }),
    });
    expect(outcome.capable).toBe(0);
    expect(outcome.capable_routes).toEqual([]);
  });

  test("an empty route list is reported, not silently treated as healthy", async () => {
    const outcome = await refreshIfStale({ models: [], path: storePath() });
    expect(outcome).toMatchObject({ refreshed: false, capable: 0, reason: "no routes supplied" });
  });
});
