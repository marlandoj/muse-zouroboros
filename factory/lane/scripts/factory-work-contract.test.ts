import { describe, expect, test } from "bun:test";
import { admitHeldHermesWork, assertLegacyLinearTicket } from "./factory-work-contract";
import { validateTickets } from "./ticket-contract";

async function work(taskId = "task-1") {
  const bytes = new TextEncoder().encode(`hermes\0software-factory\0${taskId}`);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return {
    schema: "factory-work/v1",
    factory_work_id: `fw_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`,
    source: "hermes",
    external_references: { hermes_board: "software-factory", hermes_task_id: taskId },
    title: " Build queue ",
    description: "## Acceptance Criteria\nNo effects",
    source_status: "ready",
    dispatch_eligible: false,
  };
}

describe("held Hermes work admission", () => {
  test("preserves stable identity but cannot grant execution", async () => {
    const item = await work();
    const [held] = await admitHeldHermesWork([item]);
    expect(held.factory_work_id).toBe(item.factory_work_id);
    expect(held.title).toBe("Build queue");
    expect(held.dispatch_eligible).toBe(false);
    expect(held.admission).toBe("held_untrusted_snapshot");
    expect(() => assertLegacyLinearTicket(held)).toThrow("LINEAR_TICKET_REQUIRED");
  });

  test("rejects forged IDs, dispatch flags, extra Linear identity, and duplicates", async () => {
    const item = await work();
    await expect(admitHeldHermesWork([{ ...item, factory_work_id: `fw_${"0".repeat(64)}` }])).rejects.toThrow("FACTORY_WORK_IDENTITY");
    await expect(admitHeldHermesWork([{ ...item, dispatch_eligible: true }])).rejects.toThrow("FACTORY_WORK_AUTHORITY");
    await expect(admitHeldHermesWork([{ ...item, linear_id: "issue" }])).rejects.toThrow("FACTORY_WORK_SHAPE");
    await expect(admitHeldHermesWork([item, item])).rejects.toThrow("FACTORY_WORK_DUPLICATE");
  });

  test("accepts the pinned scheduled status only as held work", async () => {
    const item = { ...await work(), source_status: "scheduled" };
    const [held] = await admitHeldHermesWork([item]);
    expect(held.source_status).toBe("scheduled");
    expect(held.dispatch_eligible).toBe(false);
  });

  test("retains valid historical Linear ticket shape on its original route", () => {
    expect(() => assertLegacyLinearTicket({ linear_id: "immutable-issue", identifier: "ZOU-1", title: "Title", description: "Body" })).not.toThrow();
    expect(() => assertLegacyLinearTicket({ linear_id: "immutable-issue", identifier: "ZOU-1", title: "Title", description: "Body", source: "hermes" })).toThrow("LINEAR_TICKET_REQUIRED");
  });

  test("effectful contract validation rejects Hermes before a Linear triage write", async () => {
    const item = await work();
    await expect(validateTickets([item as never])).rejects.toThrow("LINEAR_TICKET_REQUIRED");
  });

  test("a mixed batch is rejected before its earlier Linear item can comment", async () => {
    const item = await work();
    const priorFetch = globalThis.fetch;
    const priorKey = process.env.LINEAR_API_KEY;
    let calls = 0;
    globalThis.fetch = (async () => { calls++; throw new Error("network must stay closed"); }) as unknown as typeof fetch;
    process.env.LINEAR_API_KEY = "synthetic-test-only";
    try {
      await expect(validateTickets([
        { linear_id: "issue-1", identifier: "ZOU-1", title: "Missing fields", description: "" } as never,
        item as never,
      ])).rejects.toThrow("LINEAR_TICKET_REQUIRED");
      expect(calls).toBe(0);
    } finally {
      globalThis.fetch = priorFetch;
      if (priorKey === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = priorKey;
    }
  });
});
