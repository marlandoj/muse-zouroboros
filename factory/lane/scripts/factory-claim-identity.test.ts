import { describe, expect, test } from "bun:test";
import { factoryClaimStorageKeyV2, heldHermesClaimSubject } from "./factory-claim-identity";
import { ticketClaimKey } from "./ticket-claim";
import { admitHeldHermesWork, type HeldFactoryWork } from "./factory-work-contract";

const hermes = {
  schema: "factory-claim-subject/v2" as const,
  provider: "hermes",
  work_id: `fw_${"a".repeat(64)}`,
};

describe("factory claim subject v2 namespace", () => {
  test("has a stable independent key and leaves historical Linear v1 keys intact", () => {
    const key = factoryClaimStorageKeyV2(hermes);
    expect(key).toBe("fc2_f36a2d368d02fa9044665c680e91d1879bf0ca648d2bfc58c52f6d21c5dbb591");
    expect(key).toMatch(/^fc2_[0-9a-f]{64}$/);
    expect(ticketClaimKey("ZOU-123")).toBe("08559515b4d6b6614d4a793ed3023dcf34f1d3a4f5ec9ac595107078f95facdc");
    expect(key).not.toBe(ticketClaimKey(hermes.work_id));
  });

  test("separates providers and work identities even with identical content", () => {
    const key = factoryClaimStorageKeyV2(hermes);
    expect(factoryClaimStorageKeyV2({ ...hermes, provider: "future-provider" })).not.toBe(key);
    expect(factoryClaimStorageKeyV2({ ...hermes, work_id: `fw_${"b".repeat(64)}` })).not.toBe(key);
  });

  test("rejects ambiguous, path-like, and authority-bearing subjects", () => {
    for (const subject of [
      { ...hermes, provider: "Hermes" },
      { ...hermes, provider: "linear", work_id: "ZOU-123" },
      { ...hermes, provider: "hermes/../linear" },
      { ...hermes, work_id: `${hermes.work_id} ` },
      { ...hermes, work_id: "../ticket-claims" },
      { ...hermes, schema: "ticket-claim-owner/v1" },
      { ...hermes, dispatch_eligible: true },
      null,
    ]) {
      expect(() => factoryClaimStorageKeyV2(subject)).toThrow("FACTORY_CLAIM_SUBJECT");
    }
  });
});

describe("held Hermes work identity bridge", () => {
  // Golden ID from hermes_work_intake.project_tasks for task-1 on software-factory.
  const work = {
    schema: "factory-work/v1", source: "hermes",
    factory_work_id: "fw_827ce197981d1904313d3b67adb6f60cfb616694938a714e509b0a81d4549a64",
    external_references: { hermes_board: "software-factory", hermes_task_id: "task-1" },
    title: "Task one", description: "Synthetic work", source_status: "ready",
    dispatch_eligible: false,
  };

  test("binds validated held work to the isolated v2 subject", async () => {
    const [held] = await admitHeldHermesWork([work]);
    const subject = heldHermesClaimSubject(held!);
    expect(subject).toEqual({ schema: "factory-claim-subject/v2", provider: "hermes",
      work_id: work.factory_work_id });
    expect(factoryClaimStorageKeyV2(subject)).toMatch(/^fc2_[0-9a-f]{64}$/);
    expect(factoryClaimStorageKeyV2(subject)).not.toBe(ticketClaimKey("task-1"));
  });

  test("rejects forged identity, board, source, content and admission fields", async () => {
    const [held] = await admitHeldHermesWork([work]);
    const invalid = [
      { ...held, factory_work_id: `fw_${"0".repeat(64)}` },
      { ...held, external_references: { ...held!.external_references, hermes_task_id: "task-2" } },
      { ...held, external_references: { ...held!.external_references, hermes_board: "other" } },
      { ...held, source: "linear" },
      { ...held, dispatch_eligible: true },
      { ...held, admission: "admitted" },
      { ...held, title: " " },
      { ...held, title: " Task one " },
      { ...held, description: "x".repeat(65_537) },
      { ...held, description: "🙂".repeat(20_000) },
      { ...held, source_status: "claimable" },
      { ...held, reader_admission_proof: { opaque_sha256: "0".repeat(64) } },
    ];
    for (const candidate of invalid) expect(() => heldHermesClaimSubject(candidate as HeldFactoryWork)).toThrow();
  });
});
