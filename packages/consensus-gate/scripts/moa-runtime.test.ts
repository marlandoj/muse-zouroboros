import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  callMoaModel,
  DEFAULT_PRODUCTION_MOA_LINEUP,
  providerForMoaModel,
  resolveProductionMoaLineup,
} from "./moa-runtime";

const fallback = {
  proposers: ["legacy/a", "legacy/b", "legacy/c"],
  aggregator: "legacy/judge",
};

describe("production MoA lineup resolution", () => {
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "moa-runtime-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("uses a valid persisted mixed-provider lineup", () => {
    const path = join(dir, "lineup.json");
    writeFileSync(path, JSON.stringify({
      valid: true,
      lineup: {
        proposers: ["byok:claude", "byok:gpt", "hf:nvidia/Nemotron"],
        aggregator: "hf:MiniMaxAI/MiniMax-M3",
        generatedAt: "2026-07-10T11:38:05.337Z",
      },
    }));

    expect(resolveProductionMoaLineup(fallback, { lineupPath: path, env: {} })).toMatchObject({
      proposers: ["byok:claude", "byok:gpt", "hf:nvidia/Nemotron"],
      aggregator: "hf:MiniMaxAI/MiniMax-M3",
      source: "dynamic",
      generatedAt: "2026-07-10T11:38:05.337Z",
    });
  });

  test("explicit runtime overrides take precedence over the persisted lineup", () => {
    const path = join(dir, "lineup.json");
    writeFileSync(path, JSON.stringify({
      valid: true,
      lineup: { proposers: ["byok:a", "hf:b/C"], aggregator: "hf:d/E" },
    }));

    expect(resolveProductionMoaLineup(fallback, {
      lineupPath: path,
      env: { ZO_MOA_PROPOSERS: "oc:one,oc:two", ZO_MOA_AGGREGATOR: "oc:judge" },
    })).toMatchObject({
      proposers: ["oc:one", "oc:two"],
      aggregator: "oc:judge",
      source: "env",
    });
  });

  test("invalid or missing persisted state falls back safely", () => {
    const path = join(dir, "lineup.json");
    writeFileSync(path, JSON.stringify({
      valid: true,
      lineup: { proposers: ["byok:a"], aggregator: "byok:a" },
    }));

    expect(resolveProductionMoaLineup(fallback, { lineupPath: path, env: {} })).toMatchObject({
      ...fallback,
      source: "fallback",
    });
  });
});

test("static production fallback keeps the aggregator independent", () => {
  expect(DEFAULT_PRODUCTION_MOA_LINEUP.proposers).not.toContain(DEFAULT_PRODUCTION_MOA_LINEUP.aggregator);
});

test("static production fallback uses currently funded providers", () => {
  for (const model of [
    ...DEFAULT_PRODUCTION_MOA_LINEUP.proposers,
    DEFAULT_PRODUCTION_MOA_LINEUP.aggregator,
  ]) {
    expect(model.startsWith("oc:") || model.startsWith("hf:")).toBe(true);
  }
});

describe("provider-aware MoA dispatch", () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SYNTHETIC_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_API_KEY;
    delete process.env.XAI_API_KEY;
    delete process.env.KIMI_API_KEY;
    delete process.env.ZO_TOKEN;
    delete process.env.ZO_CLIENT_IDENTITY_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test("recognizes every supported model prefix", () => {
    expect(providerForMoaModel("byok:abc")).toBe("zo-byok");
    expect(providerForMoaModel("hf:org/model")).toBe("synthetic");
    expect(providerForMoaModel("oc:model")).toBe("opencode");
    expect(providerForMoaModel("xai:model")).toBe("xai");
    expect(providerForMoaModel("kimi:kimi-k3")).toBe("kimi");
    expect(providerForMoaModel("org/model")).toBe("openrouter");
  });

  test("routes BYOK models through Zo ask with model_name", async () => {
    process.env.ZO_CLIENT_IDENTITY_TOKEN = "test-token";
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({ output: "BYOK_OK" }), { status: 200 });
    }) as typeof fetch;

    const result = await callMoaModel("byok:subscription-model", "test", { maxTokens: 32, temperature: 0 });
    expect(result).toMatchObject({ ok: true, provider: "zo-byok", text: "BYOK_OK", costUsd: 0 });
    expect(JSON.parse(String(request?.body))).toMatchObject({ model_name: "byok:subscription-model" });
  });

  test("routes hf models to Synthetic with their canonical id", async () => {
    process.env.SYNTHETIC_API_KEY = "test-token";
    let request: RequestInit | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      request = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "SYNTHETIC_OK" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callMoaModel("hf:MiniMaxAI/MiniMax-M3", "test", { maxTokens: 32, temperature: 0 });
    expect(result).toMatchObject({ ok: true, provider: "synthetic", text: "SYNTHETIC_OK" });
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: "hf:MiniMaxAI/MiniMax-M3" });
  });

  test("routes direct Kimi models with their supported temperature", async () => {
    process.env.KIMI_API_KEY = "test-token";
    let requestUrl = "";
    let request: RequestInit | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      requestUrl = input.toString();
      request = init;
      return new Response(JSON.stringify({
        choices: [{ message: { content: "KIMI_OK" } }],
        usage: { prompt_tokens: 4, completion_tokens: 2 },
      }), { status: 200 });
    }) as typeof fetch;

    const result = await callMoaModel("kimi:kimi-k2.6", "test", { maxTokens: 32, temperature: 0 });
    expect(result).toMatchObject({ ok: true, provider: "kimi", text: "KIMI_OK" });
    expect(requestUrl).toBe("https://api.moonshot.ai/v1/chat/completions");
    expect(JSON.parse(String(request?.body))).toMatchObject({ model: "kimi-k2.6", temperature: 1 });
  });
});
