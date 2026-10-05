import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CAP_REACHED_EXIT_CODE,
  activeExecutionCount,
  inflightCap,
  inflightCapacitySnapshot,
  pullLimit,
} from "./inflight-cap";
import { pickHighestPriority, type IntakeTicket } from "./linear-puller";

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

function executionRecord(
  executionId: string,
  status: string,
  completedAt: string | null = null,
): Record<string, unknown> {
  return {
    execution_id: executionId,
    ticket_id: `linear-${executionId}`,
    identifier: "ZOU-1418",
    status,
    started_at: "2026-08-15T20:00:00Z",
    completed_at: completedAt,
  };
}

function writeExecution(dir: string, executionId: string, status: string, completedAt: string | null = null): void {
  writeFileSync(
    join(dir, `exec-${executionId}.json`),
    JSON.stringify(executionRecord(executionId, status, completedAt)),
  );
}

describe("inflightCap", () => {
  test("defaults to 1 when the flag is unset or empty", () => {
    expect(inflightCap({})).toBe(1);
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "" })).toBe(1);
  });

  test("reads explicit values 1-3", () => {
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "1" })).toBe(1);
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "2" })).toBe(2);
    expect(inflightCap({ FACTORY_INFLIGHT_CAP: "3" })).toBe(3);
  });

  test("fails closed on invalid explicit values", () => {
    for (const bad of ["0", "4", "-1", "2.5", "two", "20"]) {
      expect(() => inflightCap({ FACTORY_INFLIGHT_CAP: bad })).toThrow("FACTORY_INFLIGHT_CAP invalid");
    }
  });
});

describe("pullLimit", () => {
  test("per-cycle batch stays 1 with full headroom", () => {
    expect(pullLimit(0, 1)).toBe(1);
    expect(pullLimit(0, 2)).toBe(1);
    expect(pullLimit(0, 3)).toBe(1);
  });

  test("admits a new pull while a prior execution is live under a raised cap", () => {
    expect(pullLimit(1, 2)).toBe(1);
    expect(pullLimit(2, 3)).toBe(1);
  });

  test("withholds the queue at or above the cap", () => {
    expect(pullLimit(1, 1)).toBe(0);
    expect(pullLimit(2, 2)).toBe(0);
    expect(pullLimit(3, 2)).toBe(0);
  });
});

describe("activeExecutionCount", () => {
  test("counts only executing records and survives torn files", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-test-"));
    writeExecution(dir, "exec-a", "executing");
    writeExecution(dir, "exec-b", "implementation_complete", "2026-08-13T00:00:00Z");
    writeFileSync(join(dir, "exec-c.json"), "{torn");
    writeFileSync(join(dir, "unrelated.txt"), "ignore me");
    expect(activeExecutionCount(dir)).toBe(1);
  });

  test("ignores autopsy and other execution sidecars", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-sidecars-"));
    const record = executionRecord("exec-sidecar", "executing");
    for (const suffix of ["autopsy", "scanner", "receipt"]) {
      writeFileSync(join(dir, `exec-exec-sidecar.${suffix}.json`), JSON.stringify(record));
    }
    expect(activeExecutionCount(dir)).toBe(0);
  });

  test("ignores foreign records while counting a canonical execution exactly once", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-foreign-"));
    writeExecution(dir, "exec-live", "executing");
    writeFileSync(join(dir, "exec-foreign.json"), JSON.stringify({ status: "executing", completed_at: null }));
    writeFileSync(
      join(dir, "exec-exec-live.autopsy.json"),
      JSON.stringify(executionRecord("exec-live", "classified")),
    );
    expect(activeExecutionCount(dir)).toBe(1);
  });

  test("delivery, terminal, held, dry-run, and pool-enqueued records consume no slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-settled-"));
    const statuses = [
      "implementation_complete",
      "verified",
      "pr_ready",
      "ci_green",
      "merged",
      "deployed",
      "accepted",
      "failed",
      "held",
      "dry-run",
      "pool-enqueued",
    ];
    for (const [index, status] of statuses.entries()) {
      writeExecution(dir, `exec-${index}`, status, "2026-08-15T20:05:00Z");
    }
    expect(activeExecutionCount(dir)).toBe(0);
  });

  test("an executing record with a completion timestamp consumes no slot", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-completed-"));
    writeExecution(dir, "exec-completed", "executing", "2026-08-15T20:05:00Z");
    expect(activeExecutionCount(dir)).toBe(0);
  });

  test("missing state dir counts zero", () => {
    expect(activeExecutionCount("/tmp/does-not-exist-inflight-cap")).toBe(0);
  });
});

describe("inflightCapacitySnapshot CLI guard", () => {
  test("reports shared scheduler fields", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-snapshot-"));
    writeExecution(dir, "exec-live", "executing");
    expect(inflightCapacitySnapshot(dir, { FACTORY_INFLIGHT_CAP: "2" })).toEqual({
      active_count: 1,
      cap: 2,
      headroom: 1,
      pull_limit: 1,
      cap_reached: false,
    });
  });

  test("uses a distinct exit status when the cap is reached", () => {
    const dir = mkdtempSync(join(tmpdir(), "inflight-cap-cli-"));
    writeExecution(dir, "exec-live", "executing");
    const result = Bun.spawnSync({
      cmd: [process.execPath, join(import.meta.dir, "inflight-cap.ts"), "guard", "--state-dir", dir],
      env: { ...process.env, FACTORY_INFLIGHT_CAP: "1" },
    });
    expect(result.exitCode).toBe(CAP_REACHED_EXIT_CODE);
    expect(JSON.parse(result.stdout.toString())).toEqual({
      active_count: 1,
      cap: 1,
      headroom: 0,
      pull_limit: 0,
      cap_reached: true,
    });
  });
});

describe("pickHighestPriority limit", () => {
  const pool = [
    ticket("ZOU-3", 1, "2026-08-11T00:03:00Z"),
    ticket("ZOU-1", 2, "2026-08-11T00:01:00Z"),
    ticket("ZOU-2", 1, "2026-08-11T00:02:00Z"),
  ];

  test("default limit preserves the single-ticket batch", () => {
    expect(pickHighestPriority(pool).map((t) => t.identifier)).toEqual(["ZOU-2"]);
  });

  test("limit 0 returns an empty queue", () => {
    expect(pickHighestPriority(pool, 0)).toEqual([]);
  });

  test("limit 2 keeps urgent-first FIFO ordering", () => {
    expect(pickHighestPriority(pool, 2).map((t) => t.identifier)).toEqual(["ZOU-2", "ZOU-3"]);
  });
});
