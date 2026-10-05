import { test, expect, beforeEach, afterEach, describe } from "bun:test";
import { mkdirSync, rmSync, existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import {
  writeSentinel,
  readSentinel,
  consumeSentinels,
  cleanStaleSentinels,
  listSentinels,
  type SwarmEvent,
} from "../sentinel";

const TEST_DIR = "/tmp/swarm-events-test-" + process.pid;

function makeEvent(overrides: Partial<SwarmEvent> = {}): SwarmEvent {
  return {
    task_id: "test-task-1",
    event_type: "pattern_match",
    pattern: "BUILD SUCCESS",
    matched_line: "✓ Build completed in 4.2s",
    timestamp: new Date().toISOString(),
    source: "hermes:watch_patterns",
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("writeSentinel", () => {
  test("writes valid JSON file", () => {
    const event = makeEvent();
    const path = writeSentinel(event, { dir: TEST_DIR });

    expect(existsSync(path)).toBe(true);
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    expect(parsed.task_id).toBe("test-task-1");
    expect(parsed.event_type).toBe("pattern_match");
    expect(parsed.pattern).toBe("BUILD SUCCESS");
  });

  test("creates directory if missing", () => {
    const nested = join(TEST_DIR, "nested", "deep");
    const event = makeEvent();
    const path = writeSentinel(event, { dir: nested });

    expect(existsSync(path)).toBe(true);
  });

  test("atomic write — no .tmp_ files left", () => {
    writeSentinel(makeEvent(), { dir: TEST_DIR });

    const files = readdirSync(TEST_DIR);
    expect(files.every(f => !f.startsWith(".tmp_"))).toBe(true);
    expect(files.length).toBe(1);
  });

  test("filename includes task_id", () => {
    const path = writeSentinel(makeEvent({ task_id: "wave2-build" }), { dir: TEST_DIR });
    expect(path).toContain("wave2-build");
  });
});

describe("readSentinel", () => {
  test("reads valid sentinel", () => {
    const path = writeSentinel(makeEvent(), { dir: TEST_DIR });
    const event = readSentinel(path);

    expect(event).not.toBeNull();
    expect(event!.task_id).toBe("test-task-1");
  });

  test("returns null for malformed JSON", () => {
    const path = join(TEST_DIR, "bad.json");
    Bun.write(path, "not json");
    const event = readSentinel(path);
    expect(event).toBeNull();
  });

  test("returns null for missing required fields", () => {
    const path = join(TEST_DIR, "incomplete.json");
    Bun.write(path, JSON.stringify({ task_id: "x" }));
    const event = readSentinel(path);
    expect(event).toBeNull();
  });
});

describe("consumeSentinels", () => {
  test("reads and deletes sentinel files", () => {
    writeSentinel(makeEvent({ task_id: "t1" }), { dir: TEST_DIR });
    writeSentinel(makeEvent({ task_id: "t2" }), { dir: TEST_DIR });

    const events = consumeSentinels(undefined, { dir: TEST_DIR });
    expect(events.length).toBe(2);

    const remaining = readdirSync(TEST_DIR).filter(f => f.endsWith(".json"));
    expect(remaining.length).toBe(0);
  });

  test("filters by task IDs", () => {
    writeSentinel(makeEvent({ task_id: "wanted" }), { dir: TEST_DIR });
    writeSentinel(makeEvent({ task_id: "unwanted" }), { dir: TEST_DIR });

    const events = consumeSentinels(new Set(["wanted"]), { dir: TEST_DIR });
    expect(events.length).toBe(1);
    expect(events[0].task_id).toBe("wanted");

    // unwanted file remains
    const remaining = readdirSync(TEST_DIR).filter(f => f.endsWith(".json"));
    expect(remaining.length).toBe(1);
  });

  test("returns empty for missing directory", () => {
    const events = consumeSentinels(undefined, { dir: "/tmp/nonexistent-dir-xyz" });
    expect(events).toEqual([]);
  });

  test("idempotent — second call returns empty", () => {
    writeSentinel(makeEvent(), { dir: TEST_DIR });

    const first = consumeSentinels(undefined, { dir: TEST_DIR });
    expect(first.length).toBe(1);

    const second = consumeSentinels(undefined, { dir: TEST_DIR });
    expect(second.length).toBe(0);
  });

  test("skips malformed files and removes them", () => {
    writeSentinel(makeEvent({ task_id: "good" }), { dir: TEST_DIR });
    Bun.write(join(TEST_DIR, "bad.json"), "not json");

    const events = consumeSentinels(undefined, { dir: TEST_DIR });
    expect(events.length).toBe(1);
    expect(events[0].task_id).toBe("good");
  });
});

describe("cleanStaleSentinels", () => {
  test("removes old sentinels", () => {
    const old = makeEvent({
      timestamp: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });
    writeSentinel(old, { dir: TEST_DIR });

    const cleaned = cleanStaleSentinels({ dir: TEST_DIR });
    expect(cleaned).toBe(1);
    expect(readdirSync(TEST_DIR).filter(f => f.endsWith(".json")).length).toBe(0);
  });

  test("keeps fresh sentinels", () => {
    writeSentinel(makeEvent(), { dir: TEST_DIR });

    const cleaned = cleanStaleSentinels({ dir: TEST_DIR });
    expect(cleaned).toBe(0);
    expect(readdirSync(TEST_DIR).filter(f => f.endsWith(".json")).length).toBe(1);
  });
});

describe("listSentinels", () => {
  test("lists without consuming", () => {
    writeSentinel(makeEvent({ task_id: "a" }), { dir: TEST_DIR });
    writeSentinel(makeEvent({ task_id: "b" }), { dir: TEST_DIR });

    const events = listSentinels({ dir: TEST_DIR });
    expect(events.length).toBe(2);

    // Files still exist
    const remaining = readdirSync(TEST_DIR).filter(f => f.endsWith(".json"));
    expect(remaining.length).toBe(2);
  });
});

describe("event types", () => {
  test("supports all event types", () => {
    const types: SwarmEvent["event_type"][] = [
      "pattern_match", "task_complete", "task_failed", "health_check",
    ];
    for (const t of types) {
      const path = writeSentinel(makeEvent({ event_type: t, task_id: `type-${t}` }), { dir: TEST_DIR });
      const event = readSentinel(path);
      expect(event!.event_type).toBe(t);
    }
  });

  test("preserves metadata", () => {
    const event = makeEvent({
      metadata: { command: "npm run build", wave: 2, retries: 0 },
    });
    const path = writeSentinel(event, { dir: TEST_DIR });
    const read = readSentinel(path);
    expect(read!.metadata).toEqual({ command: "npm run build", wave: 2, retries: 0 });
  });
});

describe("concurrency safety", () => {
  test("50 rapid writes produce 50 unique files", () => {
    const promises = Array.from({ length: 50 }, (_, i) =>
      writeSentinel(makeEvent({ task_id: `rapid-${i}` }), { dir: TEST_DIR })
    );

    const files = readdirSync(TEST_DIR).filter(f => f.endsWith(".json"));
    expect(files.length).toBe(50);
  });
});
