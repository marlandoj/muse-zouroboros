import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireTicketClaim,
  reconcileExpiredTicketClaims,
  ticketClaimKey,
  ticketClaimLeaseMs,
} from "./ticket-claim";

const roots: string[] = [];

function sandbox(): string {
  const root = mkdtempSync(join(tmpdir(), "factory-ticket-claim-"));
  roots.push(root);
  return root;
}

function writeTerminalExecution(root: string, ticketId: string, executionId: string, state = "failed"): string {
  const path = join(root, `exec-${executionId}.json`);
  writeFileSync(path, JSON.stringify({
    execution_id: executionId,
    ticket_id: ticketId,
    state,
    status: state,
    started_at: "2026-08-01T00:00:00.000Z",
    completed_at: state === "executing" ? null : "2026-08-01T00:04:00.000Z",
  }));
  return path;
}

function writeOpenCycle(root: string, cycleId = "cycle-claim"): void {
  writeFileSync(join(root, "lane-utilization.jsonl.current-cycle"), `${cycleId}\n`);
  writeFileSync(join(root, "lane-utilization.jsonl"), `${JSON.stringify({
    cycle_id: cycleId,
    phase: "open",
    ts: "2026-08-01T00:00:00.000Z",
  })}\n`);
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("atomic ticket claim", () => {
  test("uses only the immutable Linear ticket_id as the claim key", () => {
    expect(ticketClaimKey("linear-uuid")).toBe(ticketClaimKey("linear-uuid"));
    expect(ticketClaimKey("linear-uuid")).not.toBe(ticketClaimKey("ZOU-924"));
  });

  test("concurrency one acquires and preserves the configured bounded lease", () => {
    const root = sandbox();
    const nowMs = Date.parse("2026-08-01T00:00:00.000Z");
    const result = acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-one" },
      { stateDir: root, nowMs, leaseMs: 10 * 60_000 },
    );
    expect(result.status).toBe("acquired");
    if (result.status !== "acquired") throw new Error("expected ticket claim acquisition");
    expect(result.record.ticket_id).toBe("linear-uuid");
    expect(result.record.execution_id).toBe("exec-one");
    expect(Date.parse(result.record.lease_expires_at) - nowMs).toBe(10 * 60_000);
  });

  test("contention skips the second cycle and never replaces the owner", () => {
    const root = sandbox();
    const first = acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-one" }, { stateDir: root });
    const second = acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-two" }, { stateDir: root });
    expect(first.status).toBe("acquired");
    expect(second.status).toBe("contended");
    if (second.status !== "contended") throw new Error("expected ticket claim contention");
    expect(second.record.execution_id).toBe("exec-one");
  });

  test("production conveyor and reaper wire the claim lifecycle", () => {
    const conveyor = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
    const claimIndex = conveyor.indexOf("const claim = acquireTicketClaim(");
    const classifyIndex = conveyor.indexOf("const verdict = classifyDispatch(", claimIndex);
    expect(claimIndex).toBeGreaterThan(0);
    expect(classifyIndex).toBeGreaterThan(claimIndex);

    const reaper = readFileSync(join(import.meta.dir, "reap-stale-execs.ts"), "utf8");
    expect(reaper).toContain("const claims = reconcileExpiredTicketClaims({");
  });

  test("corrupt and unreadable claim stores fail closed", () => {
    const corruptRoot = sandbox();
    const claimDir = join(corruptRoot, "ticket-claims", ticketClaimKey("linear-uuid"));
    mkdirSync(claimDir, { recursive: true });
    writeFileSync(join(claimDir, "owner.json"), "not-json");
    expect(acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-two" }, { stateDir: corruptRoot }).status).toBe("unavailable");

    const blockedRoot = sandbox();
    writeFileSync(join(blockedRoot, "ticket-claims"), "not-a-directory");
    expect(acquireTicketClaim({ ticket_id: "other-uuid", execution_id: "exec-three" }, { stateDir: blockedRoot }).status).toBe("unavailable");
  });

  test("expired claims remain contended until the existing reaper reconciles them", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    expect(acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-old" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    ).status).toBe("acquired");
    const expired = acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-new" },
      { stateDir: root, nowMs: start + 6 * 60_000, leaseMs: 5 * 60_000 },
    );
    expect(expired.status).toBe("contended");
    if (expired.status !== "contended") throw new Error("expected expired claim contention");
    expect(expired.reason).toContain("reaper");

    const dryRun = reconcileExpiredTicketClaims({ stateDir: root, nowMs: start + 6 * 60_000, dryRun: true });
    expect(dryRun.planned).toEqual(["linear-uuid"]);
    expect(acquireTicketClaim({ ticket_id: "linear-uuid", execution_id: "exec-new" }, { stateDir: root }).status).toBe("contended");

    const reconciled = reconcileExpiredTicketClaims({ stateDir: root, nowMs: start + 6 * 60_000 });
    expect(reconciled.reclaimed).toEqual(["linear-uuid"]);
    expect(acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-new" },
      { stateDir: root, nowMs: start + 6 * 60_000, leaseMs: 5 * 60_000 },
    ).status).toBe("acquired");
  });

  test("reaper preserves an expired claim while its execution is live", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    acquireTicketClaim(
      { ticket_id: "linear-uuid", execution_id: "exec-live" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    );
    const result = reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 6 * 60_000,
      executionAlive: (claim) => claim.execution_id === "exec-live",
    });
    expect(result.reclaimed).toEqual([]);
    expect(result.kept).toBe(1);
  });

  test("shadow preserves incumbent deletion while recording missing terminal proof", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    acquireTicketClaim(
      { ticket_id: "linear-shadow", execution_id: "exec-shadow" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    );
    const result = reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 6 * 60_000,
      mutationEvidenceMode: "shadow",
    });
    expect(result.reclaimed).toEqual(["linear-shadow"]);
    expect(result.would_reject).toHaveLength(1);
    expect(result.would_reject[0]?.reason).toMatch(/execution record|ENOENT/);
    expect(result.evidence_receipts).toEqual([]);
  });

  test("enforce refuses expiry or process death without matching terminal proof", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const acquired = acquireTicketClaim(
      { ticket_id: "linear-enforce", execution_id: "exec-enforce" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    );
    if (acquired.status !== "acquired") throw new Error("expected claim");
    const result = reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 6 * 60_000,
      mutationEvidenceMode: "enforce",
      executionAlive: () => false,
    });
    expect(result.reclaimed).toEqual([]);
    expect(result.failed).toBe(1);
    expect(existsSync(acquired.claim_path)).toBe(true);
  });

  test("enforce blocks reconciliation when the write-once receipt store is corrupt", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const acquired = acquireTicketClaim(
      { ticket_id: "linear-corrupt-evidence", execution_id: "exec-corrupt-evidence" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    );
    if (acquired.status !== "acquired") throw new Error("expected claim");
    writeTerminalExecution(root, "linear-corrupt-evidence", "exec-corrupt-evidence");
    writeOpenCycle(root);
    const evidenceRoot = join(root, "state-mutation-evidence");
    mkdirSync(evidenceRoot, { mode: 0o700 });
    writeFileSync(join(evidenceRoot, `${"a".repeat(64)}.json`), "not-json", { mode: 0o600 });

    const result = reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 6 * 60_000,
      mutationEvidenceMode: "enforce",
    });
    expect(result.reclaimed).toEqual([]);
    expect(result.failed).toBeGreaterThan(0);
    expect(result.would_reject[0]?.reason).toMatch(/receipt recovery failed/);
    expect(existsSync(acquired.claim_path)).toBe(true);
  });

  test("enforce releases only the exact owner with durable prepared and committed receipts", () => {
    const root = sandbox();
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const acquired = acquireTicketClaim(
      { ticket_id: "linear-proven", execution_id: "exec-proven" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    );
    if (acquired.status !== "acquired") throw new Error("expected claim");
    writeTerminalExecution(root, "linear-proven", "exec-proven");
    writeOpenCycle(root);
    const result = reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 6 * 60_000,
      mutationEvidenceMode: "enforce",
      executionAlive: () => false,
    });
    expect(result.reclaimed).toEqual(["linear-proven"]);
    expect(result.failed).toBe(0);
    expect(result.evidence_receipts).toHaveLength(2);
    expect(existsSync(acquired.claim_path)).toBe(false);
    const receipts = result.evidence_receipts.map((path) => JSON.parse(readFileSync(path, "utf8")));
    expect(receipts.map((receipt) => receipt.claim_release.stage).sort()).toEqual(["committed", "prepared"]);
    const prepared = receipts.find((receipt) => receipt.claim_release.stage === "prepared");
    const committed = receipts.find((receipt) => receipt.claim_release.stage === "committed");
    expect(committed.claim_release.prepared_receipt_id).toBe(prepared.receipt_id);
  });

  test("enforce rejects owner descendants and mismatched terminal identity", () => {
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    {
      const root = sandbox();
      const acquired = acquireTicketClaim(
        { ticket_id: "linear-extra", execution_id: "exec-extra" },
        { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
      );
      if (acquired.status !== "acquired") throw new Error("expected claim");
      writeFileSync(join(acquired.claim_path, "unexpected"), "x");
      writeTerminalExecution(root, "linear-extra", "exec-extra");
      const result = reconcileExpiredTicketClaims({ stateDir: root, nowMs: start + 6 * 60_000, mutationEvidenceMode: "enforce" });
      expect(result.failed).toBe(1);
      expect(existsSync(acquired.claim_path)).toBe(true);
    }
    {
      const root = sandbox();
      const acquired = acquireTicketClaim(
        { ticket_id: "linear-owner", execution_id: "exec-owner" },
        { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
      );
      if (acquired.status !== "acquired") throw new Error("expected claim");
      writeTerminalExecution(root, "other-ticket", "exec-owner");
      const result = reconcileExpiredTicketClaims({ stateDir: root, nowMs: start + 6 * 60_000, mutationEvidenceMode: "enforce" });
      expect(result.failed).toBe(1);
      expect(result.would_reject[0]?.reason).toMatch(/identity/);
      expect(existsSync(acquired.claim_path)).toBe(true);
    }
  });

  test("recovers idempotently after prepared and post-removal crash windows", () => {
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    for (const stage of ["prepared", "claim-removed"] as const) {
      const root = sandbox();
      const ticketId = `linear-crash-${stage}`;
      const executionId = `exec-crash-${stage}`;
      const acquired = acquireTicketClaim(
        { ticket_id: ticketId, execution_id: executionId },
        { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
      );
      if (acquired.status !== "acquired") throw new Error("expected claim");
      writeTerminalExecution(root, ticketId, executionId);
      writeOpenCycle(root);
      const interrupted = reconcileExpiredTicketClaims({
        stateDir: root,
        nowMs: start + 6 * 60_000,
        mutationEvidenceMode: "enforce",
        interruptAfterStage: stage,
      });
      expect(interrupted.failed).toBe(1);
      expect(interrupted.evidence_receipts).toHaveLength(1);
      expect(existsSync(acquired.claim_path)).toBe(stage === "prepared");

      const recovered = reconcileExpiredTicketClaims({
        stateDir: root,
        nowMs: start + 7 * 60_000,
        mutationEvidenceMode: "enforce",
      });
      expect(recovered.recovered).toEqual([ticketId]);
      expect(recovered.reclaimed).toEqual([ticketId]);
      expect(recovered.failed).toBe(0);
      expect(existsSync(acquired.claim_path)).toBe(false);
      const evidenceFiles = readdirSync(join(root, "state-mutation-evidence")).filter((name) => name.endsWith(".json"));
      expect(evidenceFiles).toHaveLength(2);
      const idempotent = reconcileExpiredTicketClaims({
        stateDir: root,
        nowMs: start + 8 * 60_000,
        mutationEvidenceMode: "enforce",
      });
      expect(idempotent.recovered).toEqual([]);
      expect(readdirSync(join(root, "state-mutation-evidence")).filter((name) => name.endsWith(".json"))).toHaveLength(2);
    }
  });

  test("prepared recovery fails closed when owner or terminal evidence changes", () => {
    const start = Date.parse("2026-08-01T00:00:00.000Z");
    const root = sandbox();
    const acquired = acquireTicketClaim(
      { ticket_id: "linear-drift", execution_id: "exec-drift" },
      { stateDir: root, nowMs: start, leaseMs: 5 * 60_000 },
    );
    if (acquired.status !== "acquired") throw new Error("expected claim");
    const executionPath = writeTerminalExecution(root, "linear-drift", "exec-drift");
    writeOpenCycle(root);
    reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 6 * 60_000,
      mutationEvidenceMode: "enforce",
      interruptAfterStage: "prepared",
    });
    writeFileSync(executionPath, `${readFileSync(executionPath, "utf8")}\n`);
    const recovered = reconcileExpiredTicketClaims({
      stateDir: root,
      nowMs: start + 7 * 60_000,
      mutationEvidenceMode: "enforce",
    });
    expect(recovered.recovered).toEqual([]);
    expect(recovered.failed).toBeGreaterThan(0);
    expect(existsSync(acquired.claim_path)).toBe(true);
  });

  test("lease configuration rejects unbounded or malformed values", () => {
    expect(ticketClaimLeaseMs("5")).toBe(5 * 60_000);
    expect(ticketClaimLeaseMs("120")).toBe(120 * 60_000);
    expect(() => ticketClaimLeaseMs("4")).toThrow("between 5 and 120");
    expect(() => ticketClaimLeaseMs("121")).toThrow("between 5 and 120");
    expect(() => ticketClaimLeaseMs("invalid")).toThrow("between 5 and 120");
  });

  test("two concurrent cycles create exactly one dispatch and one PR side effect", async () => {
    const root = sandbox();
    const dispatchPath = join(root, "dispatches.txt");
    const prPath = join(root, "prs.txt");
    const worker = join(import.meta.dir, "ticket-claim-worker.ts");
    const spawn = (executionId: string) => Bun.spawn([
      "bun", worker, root, "linear-uuid", executionId, dispatchPath, prPath,
    ], { stdout: "pipe", stderr: "pipe" });
    const first = spawn("exec-cycle-a");
    const second = spawn("exec-cycle-b");
    expect(await Promise.all([first.exited, second.exited])).toEqual([0, 0]);
    const lines = (path: string) => readFileSync(path, "utf8").trim().split("\n").filter(Boolean);
    expect(lines(dispatchPath)).toHaveLength(1);
    expect(lines(prPath)).toHaveLength(1);
    expect(lines(dispatchPath)).toEqual(lines(prPath));
  });
});
