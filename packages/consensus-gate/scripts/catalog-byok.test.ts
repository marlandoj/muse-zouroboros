import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import { loadRegistry, probeAlive } from "./catalog-byok";

const REGISTRY_PATH = path.resolve(import.meta.dir, "../assets/byok-registry.json");
const realFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("byok probeAlive", () => {
  beforeEach(() => {
    process.env.ZO_CLIENT_IDENTITY_TOKEN ||= "test-token";
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a 200 with an empty body is retried, not treated as dead", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return calls === 1 ? jsonResponse({ output: "" }) : jsonResponse({ output: "OK" });
    }) as typeof fetch;

    const result = await probeAlive("byok:test");
    expect(result.alive).toBe(true);
    expect(calls).toBe(2);
  }, 30_000);

  test("a persistently empty body is only dead after exhausting retries", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return jsonResponse({ output: "   " });
    }) as typeof fetch;

    const result = await probeAlive("byok:test");
    expect(result.alive).toBe(false);
    expect(calls).toBe(3);
  }, 30_000);

  test("HTTP 400 is terminal — a rotated config must not be retried", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response('{"error":"not found"}', { status: 400 });
    }) as typeof fetch;

    const result = await probeAlive("byok:gone");
    expect(result.alive).toBe(false);
    expect(calls).toBe(1);
  });
});

describe("byok registry", () => {
  const entries = loadRegistry();

  test("every registered id is namespaced byok:<uuid>", () => {
    for (const e of entries) {
      if (e.id === null) continue;
      expect(e.id).toMatch(/^byok:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  test("no duplicate ids or labels", () => {
    const ids = entries.filter((e) => e.id).map((e) => e.id);
    const labels = entries.map((e) => e.label);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("pending entries carry a note explaining what is missing", () => {
    for (const e of entries) {
      if (e.id === null) expect(typeof e.pending).toBe("string");
    }
  });

  test("registry file is stored as UTF-8, not \\uXXXX-escaped", () => {
    const raw = fs.readFileSync(REGISTRY_PATH, "utf-8");
    expect(raw).not.toMatch(/\\u2192/);
  });
});
