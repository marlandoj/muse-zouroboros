import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  advanceReviewToVerified,
  diversityReviewComment,
  loadManualReviewRecord,
  manualReviewComment,
  recoverExecution,
  requestDiversityReview,
  requestManualReview,
  recoveryConsensusOptions,
  type ReviewRecoveryExecution,
  type ReviewRecoveryTicket,
} from "./factory-review-recovery";
import type { FactoryConsensusRecord } from "./factory-consensus";
import { createExecutionLifecycle, transitionExecutionLifecycle } from "./execution-lifecycle";
import { acknowledgeNotification, processHolds } from "./hold-notify";

const directories: string[] = [];
const timestamp = "2026-07-24T18:00:00.000Z";

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function stateDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "factory-review-"));
  directories.push(directory);
  return directory;
}

function heldExecution(): ReviewRecoveryExecution {
  let lifecycle = createExecutionLifecycle("verified", timestamp);
  lifecycle = transitionExecutionLifecycle(lifecycle, "implementation_complete", {
    kind: "implementation",
    reference: "commit:test",
    recorded_at: timestamp,
  }, { now: timestamp });
  lifecycle = transitionExecutionLifecycle(lifecycle, "held", {
    kind: "consensus-manual-review",
    reference: "consensus:test",
    recorded_at: timestamp,
  }, { now: timestamp });
  return {
    ...lifecycle,
    execution_id: "exec-review",
    ticket_id: "ticket-review",
    identifier: "ZOU-REVIEW",
    started_at: timestamp,
    branch_name: "factory/review",
    stage: "manual-review-required",
    status: "held",
    error: "responsive quorum unavailable",
  };
}

const ticket: ReviewRecoveryTicket = {
  linear_id: "ticket-review",
  identifier: "ZOU-REVIEW",
  description: "review recovery test",
};

const consensus: FactoryConsensusRecord = {
  status: "needs-review",
  gate_status: "escalate",
  gate_id: "cg-review",
  trace_id: "factory:exec-review",
  lineup: null,
  serving_providers: [],
  chain_attempts: [],
  dissent: null,
  reason_code: "vendor_unavailable",
  reason: "responsive quorum unavailable",
  attempts: [
    {
      attempt: 1,
      status: "needs-review",
      gate_status: "escalate",
      gate_id: "cg-review",
      reason_code: "vendor_unavailable",
      reason: "responsive quorum unavailable",
    },
  ],
};

describe("factory manual-review recovery", () => {
  test("keeps normal retries chunked and bounds explicit unchunked recovery", () => {
    expect(recoveryConsensusOptions(false)).toBeUndefined();
    expect(recoveryConsensusOptions(true)).toEqual({
      maxVendorAttempts: 2,
      maxChunkBytes: 512 * 1024,
      maxChunks: 1,
      maxGateCalls: 1,
      maxTotalGateCalls: 2,
    });
  });

  test("writes one durable request and makes Linear escalation idempotent", async () => {
    const stateDir = stateDirectory();
    let syncCalls = 0;
    const options = {
      state_dir: stateDir,
      now: () => timestamp,
      linear_sync: async () => {
        syncCalls++;
        return { comment: "created" as const, state: "updated" as const };
      },
    };
    const first = await requestManualReview(heldExecution(), ticket, consensus, options);
    const second = await requestManualReview(heldExecution(), ticket, consensus, options);

    expect(syncCalls).toBe(1);
    expect(first.status).toBe("requested");
    expect(second).toEqual(first);
    expect(loadManualReviewRecord("exec-review", stateDir)).toMatchObject({
      status: "requested",
      linear_comment: "created",
      linear_state: "updated",
    });
  });

  test("records the escalation error before failing closed", async () => {
    const stateDir = stateDirectory();
    await expect(requestManualReview(heldExecution(), ticket, consensus, {
      state_dir: stateDir,
      linear_sync: async () => {
        throw new Error("Linear unavailable");
      },
    })).rejects.toThrow("Linear unavailable");
    expect(loadManualReviewRecord("exec-review", stateDir)).toMatchObject({
      status: "pending",
      last_error: "Linear unavailable",
    });
  });

  test("writes an idempotent Diversity of Thought review request without model-consensus evidence", async () => {
    const stateDir = stateDirectory();
    let syncCalls = 0;
    const review = { terminal_state: "hold", dissent_count: 1, summary: "required reality checker dissented" };
    const options = {
      state_dir: stateDir,
      now: () => timestamp,
      linear_sync: async () => {
        syncCalls++;
        return { comment: "created" as const, state: "updated" as const };
      },
    };
    const first = await requestDiversityReview(heldExecution(), ticket, review, options);
    const second = await requestDiversityReview(heldExecution(), ticket, review, options);

    expect(syncCalls).toBe(1);
    expect(second).toEqual(first);
    expect(loadManualReviewRecord("exec-review", stateDir)).toMatchObject({
      status: "requested",
      review_strategy: "diversity-of-thought",
      consensus_status: "not_applicable",
      reason_code: "persona_dissent",
      attempts: [],
    });
    const body = diversityReviewComment(heldExecution(), review);
    expect(body).toContain("Diversity of Thought review required");
    expect(body).toContain("factory-review-recovery.ts approve exec-review");
    expect(body).not.toContain("Retry consensus");
  });

  test("manual-review comment exposes retry and approval actions", () => {
    const body = manualReviewComment(heldExecution(), consensus);
    expect(body).toContain("FACTORY_MODEL_REVIEW=operator bun Projects/zouroboros-software-factory/scripts/factory-review-recovery.ts retry exec-review");
    expect(body).toContain("factory-review-recovery.ts approve exec-review");
    expect(body).toContain("durable hold");
  });

  test("consensus retry fails before state or network access without exact operator authorization", async () => {
    const prior = process.env.FACTORY_MODEL_REVIEW;
    process.env.FACTORY_MODEL_REVIEW = "off";
    try {
      await expect(recoverExecution({
        command: "retry",
        executionId: "missing",
        by: "operator@example.com",
        note: "retry",
      })).rejects.toThrow("consensus retry requires FACTORY_MODEL_REVIEW=operator");
    } finally {
      if (prior === undefined) delete process.env.FACTORY_MODEL_REVIEW;
      else process.env.FACTORY_MODEL_REVIEW = prior;
    }
  });

  test("a reviewed hold advances through contiguous evidence to verified", () => {
    const execution = advanceReviewToVerified(
      heldExecution(),
      "operator@example.com",
      "reviewed tests and diff",
      "manual-approval",
      timestamp,
    );
    expect(execution).toMatchObject({
      state: "verified",
      stage: "verified",
      status: "verified",
      target_reached: true,
    });
    expect(execution.evidence.verified?.[0]).toMatchObject({
      kind: "manual-approval",
      reference: "operator@example.com",
    });
  });

  test("the production conveyor routes persona dissent to a durable diversity hold", () => {
    const source = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
    expect(source).toContain("await prepareFactoryDiversityReview({");
    expect(source).toContain("await requestDiversityReview(");
    expect(source).toContain('reason: "diversity_of_thought_review"');
    expect(source).toContain('notified: "none"');
    expect(source).toContain('exec.stage = "diversity-review-held"');
    expect(source).not.toContain("await gateCompletedExecution(exec");
  });

  test("approval persists a shipping request before resolving the Linear hold", () => {
    const source = readFileSync(join(import.meta.dir, "factory-review-recovery.ts"), "utf8");
    const queueIndex = source.indexOf("queueShippingRequest(execution as ShippingExecution");
    const linearIndex = source.indexOf("await syncLinearResolution(ticket, execution");
    const resolvedIndex = source.indexOf("markResolved(execution.execution_id");
    expect(queueIndex).toBeGreaterThan(0);
    expect(linearIndex).toBeGreaterThan(queueIndex);
    expect(resolvedIndex).toBeGreaterThan(linearIndex);
  });

  test("manual-review SMS remains retryable until delivery is acknowledged", () => {
    const stateDir = stateDirectory();
    writeFileSync(join(stateDir, "hold-exec-review.json"), JSON.stringify({
      execution_id: "exec-review",
      tier: "review",
      held_at: timestamp,
      notified: "none",
      released_by: null,
      released_at: null,
      reason: "consensus_manual_review",
    }));
    writeFileSync(join(stateDir, "exec-exec-review.json"), JSON.stringify(heldExecution()));
    const priorNotify = process.env.FACTORY_HOLD_NOTIFY_ENFORCE;
    const priorApproval = process.env.SF002_ENFORCE;
    process.env.FACTORY_HOLD_NOTIFY_ENFORCE = "1";
    process.env.SF002_ENFORCE = "0";

    try {
      const first = processHolds({ state_dir: stateDir, now: () => timestamp });
      const second = processHolds({ state_dir: stateDir, now: () => timestamp });
      expect(first.sms).toHaveLength(1);
      expect(first.sms[0]?.text).toContain("Manual review required: ZOU-REVIEW");
      expect(second.sms).toHaveLength(1);
      expect(JSON.parse(readFileSync(join(stateDir, "hold-exec-review.json"), "utf8")).notified).toBe("none");

      acknowledgeNotification("exec-review", "sms", { state_dir: stateDir, now: () => timestamp });
      expect(processHolds({ state_dir: stateDir }).holds_found).toBe(0);
      expect(JSON.parse(readFileSync(join(stateDir, "hold-exec-review.json"), "utf8")).notified).toBe("sms");

      const audit = readFileSync(join(stateDir, "hold-notification-attempts.jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(audit.map((row) => row.status)).toEqual(["queued", "queued", "delivered"]);
    } finally {
      if (priorNotify === undefined) delete process.env.FACTORY_HOLD_NOTIFY_ENFORCE;
      else process.env.FACTORY_HOLD_NOTIFY_ENFORCE = priorNotify;
      if (priorApproval === undefined) delete process.env.SF002_ENFORCE;
      else process.env.SF002_ENFORCE = priorApproval;
    }
  });

  test("diversity-review SMS directs the operator to evidence-bearing approval, not generic release", () => {
    const stateDir = stateDirectory();
    writeFileSync(join(stateDir, "hold-exec-review.json"), JSON.stringify({
      execution_id: "exec-review",
      tier: "high",
      held_at: timestamp,
      notified: "none",
      released_by: null,
      released_at: null,
      reason: "diversity_of_thought_review",
    }));
    writeFileSync(join(stateDir, "exec-exec-review.json"), JSON.stringify(heldExecution()));
    const priorNotify = process.env.FACTORY_HOLD_NOTIFY_ENFORCE;
    const priorApproval = process.env.SF002_ENFORCE;
    process.env.FACTORY_HOLD_NOTIFY_ENFORCE = "1";
    process.env.SF002_ENFORCE = "0";
    try {
      const payload = processHolds({ state_dir: stateDir, now: () => timestamp });
      expect(payload.sms).toHaveLength(1);
      expect(payload.sms[0]?.text).toContain("Diversity review required: ZOU-REVIEW");
      expect(payload.sms[0]?.text).toContain("factory-review-recovery.ts approve exec-review");
      expect(payload.sms[0]?.text).not.toContain("hold-notify.ts release");
    } finally {
      if (priorNotify === undefined) delete process.env.FACTORY_HOLD_NOTIFY_ENFORCE;
      else process.env.FACTORY_HOLD_NOTIFY_ENFORCE = priorNotify;
      if (priorApproval === undefined) delete process.env.SF002_ENFORCE;
      else process.env.SF002_ENFORCE = priorApproval;
    }
  });
});
