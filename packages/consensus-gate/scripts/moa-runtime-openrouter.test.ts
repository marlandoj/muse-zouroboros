import { afterEach, beforeEach, expect, test } from "bun:test";
import { callMoaModel, providerForMoaModel } from "./moa-runtime";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.OPENROUTER_API_KEY = "test-token";
  delete process.env.SYNTHETIC_API_KEY;
  delete process.env.OPENCODE_API_KEY;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

test("routes or-prefixed catalog ids to OpenRouter without the local prefix", async () => {
  let request: RequestInit | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    request = init;
    return new Response(JSON.stringify({
      choices: [{ message: { content: "OPENROUTER_OK" } }],
      usage: { prompt_tokens: 4, completion_tokens: 2 },
    }), { status: 200 });
  }) as typeof fetch;

  expect(providerForMoaModel("or:deepseek/deepseek-r1")).toBe("openrouter");
  const result = await callMoaModel("or:deepseek/deepseek-r1", "test", { maxTokens: 32, temperature: 0 });
  expect(result).toMatchObject({ ok: true, provider: "openrouter", text: "OPENROUTER_OK" });
  expect(JSON.parse(String(request?.body))).toMatchObject({ model: "deepseek/deepseek-r1" });
});
