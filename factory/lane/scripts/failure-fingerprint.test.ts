import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeFailurePark,
  createFailureFingerprint,
  deliverFailureNotification,
  loadFailureStreak,
  notificationLedgerPath,
  recordFailureCycle,
  recordFailureSuccess,
  releaseFailurePark,
} from "./failure-fingerprint";
import { processHolds } from "./hold-notify";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
  const root = mkdtempSync(join(tmpdir(), "failure-fingerprint-"));
  roots.push(root);
  return root;
}

function failure(cycle_id: string, error_signature = "Request exec-abcdef123 timed out on retry 1 at 2026-07-13T04:00:00Z") {
  return {
    ticket_identifier: "ZOU-572",
    failing_stage: "dispatch",
    error_class: "transport",
    error_signature,
    cycle_id,
  };
}

describe("failure fingerprint", () => {
  test("normalizes volatile identifiers, timestamps, and retry counters", () => {
    const a = createFailureFingerprint(failure("cycle-1"));
    const b = createFailureFingerprint({
      ...failure("cycle-2", "Request exec-zyx987654 timed out on retry 9 at 2026-07-13T05:22:11Z"),
    });
    expect(a.digest).toBe(b.digest);
    expect(a.normalized_signature).toContain("<generated-id>");
    expect(a.normalized_signature).toContain("retry <n>");
  });

  test("second equivalent failure parks and third cycle is a parked no-op", () => {
    const dir = stateDir();
    const first = recordFailureCycle(failure("cycle-1"), { state_dir: dir });
    const second = recordFailureCycle(failure("cycle-2"), { state_dir: dir });
    const third = recordFailureCycle(failure("cycle-3"), { state_dir: dir });
    expect(first.action).toBe("retry");
    expect(first.should_dispatch).toBe(true);
    expect(second.action).toBe("park_and_notify");
    expect(second.should_dispatch).toBe(false);
    expect(second.should_notify).toBe(true);
    expect(activeFailurePark("ZOU-572", dir)?.parked_cycle_id).toBe("cycle-2");
    expect(third.action).toBe("parked_noop");
    expect(third.should_dispatch).toBe(false);
    expect(third.should_notify).toBe(false);
  });

  test("operator release clears a park without recording false success", () => {
    const dir = stateDir();
    recordFailureCycle(failure("cycle-1"), { state_dir: dir });
    recordFailureCycle(failure("cycle-2"), { state_dir: dir });
    const released = releaseFailurePark("ZOU-572", "release-1", "operator", { state_dir: dir });
    expect(released.current_fingerprint).toBeNull();
    expect(released.consecutive_failures).toBe(0);
    expect(released.parked_at).toBeNull();
    expect(released.last_success_at).toBeNull();
    expect(activeFailurePark("ZOU-572", dir)).toBeNull();
  });

  test("replaying a cycle is idempotent and never increments the streak", () => {
    const dir = stateDir();
    recordFailureCycle(failure("cycle-1"), { state_dir: dir });
    const duplicate = recordFailureCycle(failure("cycle-1"), { state_dir: dir });
    expect(duplicate.action).toBe("duplicate_cycle");
    expect(duplicate.record.consecutive_failures).toBe(1);
  });

  test("changed fingerprint and success each reset the streak", () => {
    const dir = stateDir();
    recordFailureCycle(failure("cycle-1"), { state_dir: dir });
    const changed = recordFailureCycle(failure("cycle-2", "permission denied writing seed"), { state_dir: dir });
    expect(changed.fingerprint_changed).toBe(true);
    expect(changed.record.consecutive_failures).toBe(1);
    const reset = recordFailureSuccess("ZOU-572", "cycle-3", { state_dir: dir });
    expect(reset.consecutive_failures).toBe(0);
    expect(reset.current_fingerprint).toBeNull();
  });

  test("notification is delivered once and every attempt is durably audited", () => {
    const dir = stateDir();
    recordFailureCycle(failure("cycle-1"), { state_dir: dir });
    const parked = recordFailureCycle(failure("cycle-2"), { state_dir: dir });
    const sent: string[] = [];
    const delivered = deliverFailureNotification(parked, (message) => sent.push(message), {
      state_dir: dir,
      now: () => "2026-07-13T04:30:00.000Z",
      attempt_id: () => "attempt-1",
    });
    const duplicate = deliverFailureNotification(parked, (message) => sent.push(message), { state_dir: dir });
    expect(delivered.status).toBe("delivered");
    expect(duplicate.status).toBe("skipped");
    expect(sent).toHaveLength(1);
    const ledger = readFileSync(notificationLedgerPath(dir), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(ledger.map((row) => row.status)).toEqual(["started", "delivered"]);
    expect(loadFailureStreak("ZOU-572", dir)?.notification_delivered_at).not.toBeNull();
  });

  test("failed delivery remains auditable", () => {
    const dir = stateDir();
    recordFailureCycle(failure("cycle-1"), { state_dir: dir });
    const parked = recordFailureCycle(failure("cycle-2"), { state_dir: dir });
    const result = deliverFailureNotification(parked, () => {
      throw new Error("sender unavailable");
    }, { state_dir: dir, attempt_id: () => "attempt-fail" });
    expect(result.status).toBe("failed");
    expect(result.attempt?.error).toBe("sender unavailable");
  });

  test("hold notification delivery is injectable, idempotent, and audited", () => {
    const dir = stateDir();
    writeFileSync(join(dir, "hold-exec-1.json"), JSON.stringify({
      execution_id: "exec-1",
      tier: "high",
      held_at: "2026-07-13T04:00:00.000Z",
      notified: "none",
      released_by: null,
      released_at: null,
    }));
    writeFileSync(join(dir, "exec-exec-1.json"), JSON.stringify({
      execution_id: "exec-1",
      identifier: "ZOU-572",
      risk: { score: 0.9 },
    }));
    const sent: string[] = [];
    const prior = process.env.SF002_ENFORCE;
    process.env.SF002_ENFORCE = "1";
    try {
      const first = processHolds({ state_dir: dir, sms_sender: (text) => sent.push(text), now: () => "2026-07-13T04:31:00.000Z" });
      const second = processHolds({ state_dir: dir, sms_sender: (text) => sent.push(text) });
      expect(first.sms).toHaveLength(1);
      expect(second.holds_found).toBe(0);
      expect(sent).toHaveLength(1);
      const audit = readFileSync(join(dir, "hold-notification-attempts.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(audit).toHaveLength(1);
      expect(audit[0].status).toBe("delivered");
    } finally {
      if (prior === undefined) delete process.env.SF002_ENFORCE;
      else process.env.SF002_ENFORCE = prior;
    }
  });
});
