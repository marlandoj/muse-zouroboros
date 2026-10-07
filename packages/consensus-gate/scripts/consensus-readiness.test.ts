import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  callVendorWithFallback,
  preflightConsensusRoles,
  type Verdict,
} from "./consensus-gate";

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function validVerdict(model: string): Verdict {
  return {
    model,
    pass: true,
    issues: [],
    confidence: 1,
    latencyMs: 1,
    servingProvider: "openrouter",
    servingModel: model,
  };
}

beforeEach(() => {
  process.env.OPENCODE_API_KEY = "test-opencode";
  process.env.OPENROUTER_API_KEY = "test-openrouter";
  process.env.CG_TRANSIENT_RETRY_DELAY_MS = "0";
  delete process.env.SYNTHETIC_API_KEY;
  delete process.env.ZO_CLIENT_IDENTITY_TOKEN;
  delete process.env.ZO_TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("consensus readiness", () => {
  test("resolves HTTP 429 to the configured fallback during preflight", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      urls.push(url);
      if (url.includes("opencode.ai")) return new Response("rate limited", { status: 429 });
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ pass: true, claims: [], confidence: 1 }) } }],
      }), { status: 200 });
    }) as typeof fetch;

    const verdict = await callVendorWithFallback(
      { primary: "oc:glm-5.2", fallbacks: ["or:z-ai/glm-5.2"] },
      "export const preflight = true;",
      "correctness",
    );

    expect(verdict.confidence).toBe(1);
    expect(verdict.servingModel).toBe("or:z-ai/glm-5.2");
    expect(verdict.chainAttempts).toEqual(["oc:glm-5.2", "or:z-ai/glm-5.2"]);
    expect(urls.filter((url) => url.includes("opencode.ai"))).toHaveLength(2);
    expect(urls.filter((url) => url.includes("openrouter.ai"))).toHaveLength(1);
  });

  test("resolves malformed model JSON before binding the review route", async () => {
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      const content = url.includes("opencode.ai")
        ? "narrative response without a verdict"
        : JSON.stringify({ pass: true, claims: [], confidence: 1 });
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }) as typeof fetch;

    const verdict = await callVendorWithFallback(
      { primary: "oc:glm-5.2", fallbacks: ["or:z-ai/glm-5.2"] },
      "export const preflight = true;",
      "correctness",
    );

    expect(verdict.servingModel).toBe("or:z-ai/glm-5.2");
    expect(verdict.chainAttemptDetails?.[0]).toMatchObject({ ok: false });
    expect(verdict.chainAttemptDetails?.[1]).toMatchObject({ ok: true });
  });

  test("resolves a timed-out provider before binding the review route", async () => {
    let opencodeAttempts = 0;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.includes("opencode.ai")) {
        opencodeAttempts++;
        throw new DOMException("The operation was aborted", "AbortError");
      }
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({ pass: true, claims: [], confidence: 1 }) } }],
      }), { status: 200 });
    }) as typeof fetch;

    const verdict = await callVendorWithFallback(
      { primary: "oc:glm-5.2", fallbacks: ["or:z-ai/glm-5.2"] },
      "export const preflight = true;",
      "correctness",
    );

    expect(opencodeAttempts).toBe(2);
    expect(verdict.servingModel).toBe("or:z-ai/glm-5.2");
    expect(verdict.chainAttemptDetails?.map((attempt) => attempt.ok)).toEqual([false, true]);
  });

  test("binds healthy routes and fails closed when any required seat is unhealthy", async () => {
    const call = async (role: any): Promise<Verdict> => {
      const primary = typeof role === "string" ? role : role.primary;
      if (primary === "seat-b") {
        return { ...validVerdict(primary), confidence: 0, issues: ["API error: 429"] };
      }
      return { ...validVerdict(primary), servingModel: `${primary}-healthy` };
    };

    const readiness = await preflightConsensusRoles(["seat-a", "seat-b"], call as typeof callVendorWithFallback);
    expect(readiness.healthy).toBe(false);
    expect(readiness.boundRoles).toEqual([]);
    expect(readiness.evidence.codePayloadSent).toBe(false);
    expect(readiness.evidence.seats[0].servingModel).toBe("seat-a-healthy");
    expect(readiness.evidence.seats[1]).toMatchObject({ healthy: false, error: "API error: 429" });
  });
});
