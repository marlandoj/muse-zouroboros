import { test, expect, beforeAll, afterAll, describe } from "bun:test";
import { mkdirSync, rmSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { type Subprocess } from "bun";

const TEST_PORT = 17821;
const TEST_DIR = "/tmp/swarm-events-server-test-" + process.pid;
let serverProc: Subprocess;

beforeAll(async () => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });

  serverProc = Bun.spawn(
    ["bun", join(__dirname, "..", "event-server.ts")],
    {
      env: {
        ...process.env,
        SWARM_EVENT_PORT: String(TEST_PORT),
        SWARM_SENTINEL_DIR: TEST_DIR,
      },
      stdout: "pipe",
      stderr: "pipe",
    }
  );

  // Wait for server to be ready
  for (let i = 0; i < 30; i++) {
    try {
      const resp = await fetch(`http://localhost:${TEST_PORT}/health`);
      if (resp.ok) break;
    } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
});

afterAll(() => {
  serverProc.kill();
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("health endpoint", () => {
  test("GET /health returns status ok", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/health`);
    expect(resp.status).toBe(200);
    const body = await resp.json();
    expect(body.status).toBe("ok");
    expect(body.sentinel_dir).toBe(TEST_DIR);
    expect(body.stats).toBeDefined();
  });
});

describe("event endpoint", () => {
  test("POST /swarm/event accepts valid event", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/swarm/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: "wave1-build",
        event_type: "pattern_match",
        pattern: "BUILD SUCCESS",
        matched_line: "✓ Build completed",
        source: "test",
      }),
    });
    expect(resp.status).toBe(202);
    const body = await resp.json();
    expect(body.accepted).toBe(true);
    expect(body.sentinel).toContain("wave1-build");
  });

  test("writes sentinel file to disk", async () => {
    await fetch(`http://localhost:${TEST_PORT}/swarm/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: "disk-check",
        event_type: "task_complete",
        source: "test",
      }),
    });

    const files = readdirSync(TEST_DIR).filter(f => f.includes("disk-check"));
    expect(files.length).toBeGreaterThanOrEqual(1);

    const content = JSON.parse(readFileSync(join(TEST_DIR, files[0]), "utf-8"));
    expect(content.task_id).toBe("disk-check");
    expect(content.event_type).toBe("task_complete");
  });

  test("rejects missing task_id", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/swarm/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event_type: "pattern_match" }),
    });
    expect(resp.status).toBe(400);
  });

  test("rejects invalid event_type", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/swarm/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task_id: "x", event_type: "invalid" }),
    });
    expect(resp.status).toBe(400);
  });

  test("rejects invalid JSON", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/swarm/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json{",
    });
    expect(resp.status).toBe(400);
  });

  test("adds timestamp if missing", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/swarm/event`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        task_id: "ts-check",
        event_type: "health_check",
        source: "test",
      }),
    });
    expect(resp.status).toBe(202);

    const files = readdirSync(TEST_DIR).filter(f => f.includes("ts-check"));
    const content = JSON.parse(readFileSync(join(TEST_DIR, files[0]), "utf-8"));
    expect(content.timestamp).toBeDefined();
    expect(new Date(content.timestamp).getTime()).toBeGreaterThan(0);
  });

  test("404 for unknown routes", async () => {
    const resp = await fetch(`http://localhost:${TEST_PORT}/unknown`);
    expect(resp.status).toBe(404);
  });
});

describe("rate limiting", () => {
  test("allows up to 100 events per task_id per minute", async () => {
    const promises = Array.from({ length: 10 }, () =>
      fetch(`http://localhost:${TEST_PORT}/swarm/event`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          task_id: "rate-test",
          event_type: "pattern_match",
          source: "test",
        }),
      })
    );

    const responses = await Promise.all(promises);
    expect(responses.every(r => r.status === 202)).toBe(true);
  });
});
