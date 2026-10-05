import { afterEach, describe, expect, test } from "bun:test";
import {
  LinearPullError,
  executeReadOnlyGraphql,
  isTransientLinearTransportError,
  pickHighestPriority,
  pullTickets,
  type IntakeTicket,
} from "./linear-puller";

type FetchStep = Response | Error;

function sequence(...steps: FetchStep[]) {
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    const step = steps.shift();
    if (!step) throw new Error("unexpected fetch call");
    if (step instanceof Error) throw step;
    return step;
  }) as unknown as typeof fetch;
  return { fetchFn, calls: () => calls };
}

function ok(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function ticket(identifier: string, priority: number, createdAt: string): IntakeTicket {
  return {
    linear_id: identifier,
    identifier,
    title: identifier,
    description: "",
    url: "",
    state: "Backlog",
    state_type: "backlog",
    labels: ["factory-ready"],
    created_at: createdAt,
    updated_at: createdAt,
    priority,
  };
}

const originalFetch = globalThis.fetch;
const originalKey = process.env.LINEAR_API_KEY;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.LINEAR_API_KEY;
  else process.env.LINEAR_API_KEY = originalKey;
});

describe("read-only Linear retry policy", () => {
  test("retries one typed connection failure and then returns data", async () => {
    const failure = Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    const mock = sequence(failure, ok({ issues: { nodes: [] } }));
    const delays: number[] = [];
    const warnings: string[] = [];

    const result = await executeReadOnlyGraphql<{ issues: { nodes: unknown[] } }>("query Test", {}, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      sleep: async (delay) => { delays.push(delay); },
      onRetry: (message) => { warnings.push(message); },
      requestTimeoutMs: 0,
    });

    expect(result).toEqual({ issues: { nodes: [] } });
    expect(mock.calls()).toBe(2);
    expect(delays).toEqual([250]);
    expect(warnings).toHaveLength(1);
  });

  test("classifies timeout and known connection codes, but not arbitrary errors", () => {
    expect(isTransientLinearTransportError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isTransientLinearTransportError(Object.assign(new Error("dns"), { cause: { code: "EAI_AGAIN" } }))).toBe(true);
    expect(isTransientLinearTransportError(new TypeError("fetch failed"))).toBe(true);
    expect(isTransientLinearTransportError(new TypeError("Invalid URL"))).toBe(false);
    expect(isTransientLinearTransportError(Object.assign(new TypeError("fetch() URL is invalid"), { code: "ERR_INVALID_URL" }))).toBe(false);
    expect(isTransientLinearTransportError(new Error("application bug"))).toBe(false);
  });

  test("recognizes Bun's live connection-refusal failure shape", async () => {
    let failure: unknown;
    try {
      await fetch("http://127.0.0.1:1");
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "Error",
      code: "ConnectionRefused",
      message: "Unable to connect. Is the computer able to access the url?",
    });
    expect(isTransientLinearTransportError(failure)).toBe(true);
  });

  for (const status of [408, 429, 500, 503]) {
    test(`retries transient HTTP ${status} once`, async () => {
      const headers = status === 429 ? { "Retry-After": "120" } : undefined;
      const mock = sequence(new Response("temporary", { status, headers }), ok({ value: status }));
      const delays: number[] = [];

      const result = await executeReadOnlyGraphql<{ value: number }>("query Test", undefined, {
        apiKey: "test-key",
        fetchFn: mock.fetchFn,
        sleep: async (delay) => { delays.push(delay); },
        onRetry: () => {},
        requestTimeoutMs: 0,
      });

      expect(result).toEqual({ value: status });
      expect(mock.calls()).toBe(2);
      expect(delays).toEqual([status === 429 ? 5_000 : 250]);
    });
  }

  test("caps an HTTP-date Retry-After value with an injected clock", async () => {
    const now = Date.parse("2026-08-11T00:00:00Z");
    const mock = sequence(
      new Response("temporary", { status: 503, headers: { "Retry-After": "Mon, 11 Aug 2026 00:00:30 GMT" } }),
      ok({ value: true }),
    );
    const delays: number[] = [];

    await executeReadOnlyGraphql("query Test", undefined, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      sleep: async (delay) => { delays.push(delay); },
      now: () => now,
      onRetry: () => {},
      requestTimeoutMs: 0,
    });

    expect(delays).toEqual([5_000]);
  });

  test("retries malformed successful JSON once", async () => {
    const mock = sequence(new Response('{"data":', { status: 200 }), ok({ value: "valid" }));
    const delays: number[] = [];

    const result = await executeReadOnlyGraphql<{ value: string }>("query Test", undefined, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      sleep: async (delay) => { delays.push(delay); },
      onRetry: () => {},
      requestTimeoutMs: 0,
    });

    expect(result).toEqual({ value: "valid" });
    expect(mock.calls()).toBe(2);
    expect(delays).toEqual([250]);
  });

  test("stops after two transient failures", async () => {
    const mock = sequence(new Response("temporary", { status: 500 }), new Response("still down", { status: 503 }));

    await expect(executeReadOnlyGraphql("query Test", undefined, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      sleep: async () => {},
      onRetry: () => {},
      requestTimeoutMs: 0,
    })).rejects.toMatchObject({ kind: "http", exitCode: 1, retryable: true });
    expect(mock.calls()).toBe(2);
  });

  test("does not retry non-transient HTTP failures", async () => {
    const mock = sequence(new Response("bad request", { status: 400 }), ok({ shouldNotRun: true }));

    await expect(executeReadOnlyGraphql("query Test", undefined, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      sleep: async () => { throw new Error("sleep should not run"); },
      onRetry: () => {},
      requestTimeoutMs: 0,
    })).rejects.toMatchObject({ kind: "http", exitCode: 1, retryable: false, details: { status: 400 } });
    expect(mock.calls()).toBe(1);
  });

  test("does not retry GraphQL application errors", async () => {
    const mock = sequence(new Response(JSON.stringify({ errors: [{ message: "denied" }] }), { status: 200 }), ok({ shouldNotRun: true }));

    await expect(executeReadOnlyGraphql("query Test", undefined, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      sleep: async () => { throw new Error("sleep should not run"); },
      onRetry: () => {},
      requestTimeoutMs: 0,
    })).rejects.toMatchObject({ kind: "graphql", exitCode: 1, retryable: false });
    expect(mock.calls()).toBe(1);
  });

  test("fails with exit code 2 before fetch when credentials are missing", async () => {
    const mock = sequence(ok({ shouldNotRun: true }));

    await expect(executeReadOnlyGraphql("query Test", undefined, {
      apiKey: "",
      fetchFn: mock.fetchFn,
      requestTimeoutMs: 0,
    })).rejects.toMatchObject({ kind: "missing_credentials", exitCode: 2, retryable: false });
    expect(mock.calls()).toBe(0);
  });

  test("does not retry an untyped thrown error", async () => {
    const mock = sequence(new Error("injected application failure"), ok({ shouldNotRun: true }));

    await expect(executeReadOnlyGraphql("query Test", undefined, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      requestTimeoutMs: 0,
    })).rejects.toMatchObject({ kind: "transport", exitCode: 1, retryable: false });
    expect(mock.calls()).toBe(1);
  });

  test("does not retry an invalid URL TypeError", async () => {
    const mock = sequence(new TypeError("Invalid URL"), ok({ shouldNotRun: true }));

    await expect(executeReadOnlyGraphql("query Test", undefined, {
      apiKey: "test-key",
      fetchFn: mock.fetchFn,
      requestTimeoutMs: 0,
    })).rejects.toMatchObject({ kind: "transport", exitCode: 1, retryable: false });
    expect(mock.calls()).toBe(1);
  });

  for (const code of ["ERR_INVALID_URL", "ENOTFOUND", "DEPTH_ZERO_SELF_SIGNED_CERT", "CERT_HAS_EXPIRED"]) {
    test(`does not retry fetch failed with explicit nested ${code}`, async () => {
      const failure = Object.assign(new TypeError("fetch failed"), { cause: { code } });
      const mock = sequence(failure, ok({ shouldNotRun: true }));

      await expect(executeReadOnlyGraphql("query Test", undefined, {
        apiKey: "test-key",
        fetchFn: mock.fetchFn,
        requestTimeoutMs: 0,
      })).rejects.toMatchObject({ kind: "transport", exitCode: 1, retryable: false });
      expect(mock.calls()).toBe(1);
    });
  }
});

describe("preserved puller behavior", () => {
  test("keeps urgent-first ordering and FIFO tie-breaking", () => {
    const selected = pickHighestPriority([
      ticket("ZOU-3", 1, "2026-08-11T00:03:00Z"),
      ticket("ZOU-1", 2, "2026-08-11T00:01:00Z"),
      ticket("ZOU-2", 1, "2026-08-11T00:02:00Z"),
      ticket("ZOU-0", 0, "2026-08-11T00:00:00Z"),
    ]);

    expect(selected.map(({ identifier }) => identifier)).toEqual(["ZOU-2"]);
  });

  test("never retries the issueUpdate reap mutation", async () => {
    process.env.LINEAR_API_KEY = "test-key";
    let calls = 0;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      const payload = JSON.parse(String(init?.body));
      if (calls === 1) {
        expect(payload.query).toContain("query FactoryReadyTickets");
        return ok({
          issues: {
            nodes: [{
              id: "issue-id",
              identifier: "ZOU-TEST",
              state: { name: "Done", type: "completed" },
              labels: { nodes: [{ id: "f4a73851-6c6b-4a19-b397-c2bd62eeb694", name: "factory-ready" }] },
            }],
          },
        });
      }
      expect(payload.query).toContain("mutation ReapFactoryReady");
      throw Object.assign(new Error("socket reset"), { code: "ECONNRESET" });
    }) as unknown as typeof fetch;

    expect(await pullTickets()).toEqual([]);
    expect(calls).toBe(2);
  });

  test("CLI preserves exit code 2 for a missing key", () => {
    const env = { ...process.env };
    delete env.LINEAR_API_KEY;
    const result = Bun.spawnSync({
      cmd: [process.execPath, new URL("./linear-puller.ts", import.meta.url).pathname],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(2);
    expect(result.stdout.toString()).toBe("");
    expect(result.stderr.toString()).toContain("FATAL: LINEAR_API_KEY not set");
  });

  test("CLI dry-run remains network-free and exits zero", () => {
    const env = { ...process.env };
    delete env.LINEAR_API_KEY;
    const result = Bun.spawnSync({
      cmd: [process.execPath, new URL("./linear-puller.ts", import.meta.url).pathname, "--dry-run"],
      env,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain("query FactoryReadyTickets");
    expect(result.stderr.toString()).toBe("");
  });

  test("CLI preserves compact stdout JSON on a successful pull", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        return ok({
          issues: {
            nodes: [{
              id: "issue-id",
              identifier: "ZOU-TEST",
              title: "Test ticket",
              description: "Test description",
              url: "https://linear.app/test",
              priority: 1,
              createdAt: "2026-08-11T00:00:00Z",
              updatedAt: "2026-08-11T00:00:00Z",
              state: { id: "state-id", name: "Backlog", type: "backlog" },
              labels: { nodes: [{ id: "f4a73851-6c6b-4a19-b397-c2bd62eeb694", name: "factory-ready" }] },
              team: { id: "team-id", name: "Zouroboros", key: "ZOU" },
            }],
          },
        });
      },
    });
    try {
      const processHandle = Bun.spawn({
        cmd: [process.execPath, new URL("./linear-puller.ts", import.meta.url).pathname],
        env: {
          ...process.env,
          LINEAR_API_KEY: "test-key",
          LINEAR_API_URL: `http://127.0.0.1:${server.port}/graphql`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);

      expect(exitCode).toBe(0);
      expect(requests).toBe(1);
      expect(stderr).toBe("");
      const lines = stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]!)).toEqual([expect.objectContaining({ identifier: "ZOU-TEST", priority: 1 })]);
    } finally {
      server.stop(true);
    }
  });

  test("CLI preserves exit code 1 and does not retry HTTP 400", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests += 1;
        return new Response("bad request", { status: 400 });
      },
    });
    try {
      const processHandle = Bun.spawn({
        cmd: [process.execPath, new URL("./linear-puller.ts", import.meta.url).pathname],
        env: {
          ...process.env,
          LINEAR_API_KEY: "test-key",
          LINEAR_API_URL: `http://127.0.0.1:${server.port}/graphql`,
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        processHandle.exited,
        new Response(processHandle.stdout).text(),
        new Response(processHandle.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(requests).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("FATAL: Linear API returned 400: bad request");
    } finally {
      server.stop(true);
    }
  });
});
