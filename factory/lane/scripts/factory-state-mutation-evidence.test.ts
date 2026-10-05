import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FACTORY_STATE_MUTATION_EVIDENCE_ROOT,
  FACTORY_STATE_MUTATION_PAYLOAD_MAX_BYTES,
  assertFactoryStateMutationMayProceed,
  createFactoryStateMutationReceipt,
  deriveFactoryStateMutationTransitions,
  factoryStateMutationPayloadSha256,
  mutationReceiptPath,
  parseTicketClaimOwnerPayload,
  readFactoryStateMutationReceipt,
  recordFactoryStateAtomicReplacement,
  resolveFactoryStateMutationCycle,
  validateFactoryStateClaimTerminalProof,
  validateFactoryStateMutationReceipt,
  writeFactoryStateMutationReceipt,
  type FactoryStateMutationCycleBinding,
  type TicketClaimOwnerEvidence,
} from "./factory-state-mutation-evidence";

const roots: string[] = [];
const NOW = "2026-08-13T14:54:16.000Z";

function root(): string {
  const path = mkdtempSync(join(tmpdir(), "factory-state-mutation-evidence-"));
  roots.push(path);
  return path;
}

function scheduledBinding(base: string): FactoryStateMutationCycleBinding {
  const sentinel = join(base, "lane-utilization.jsonl.current-cycle");
  const laneLog = join(base, "lane-utilization.jsonl");
  writeFileSync(sentinel, "cycle-1\n");
  writeFileSync(laneLog, `${JSON.stringify({ cycle_id: "cycle-1", phase: "open", ts: NOW })}\n`);
  return resolveFactoryStateMutationCycle({
    producerId: "lane-utilization",
    requestedCycleId: "cycle-1",
    sentinelPath: sentinel,
    laneLogPath: laneLog,
  });
}

function owner(): TicketClaimOwnerEvidence {
  return {
    schema_version: 1,
    ticket_id: "linear-uuid",
    execution_id: "exec-one",
    claimed_at: "2026-08-13T13:00:00.000Z",
    lease_expires_at: "2026-08-13T14:00:00.000Z",
    pid: 1234,
  };
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("factory state mutation evidence", () => {
  test("binds only an explicit current cycle with one unmatched open row", () => {
    const base = root();
    const binding = scheduledBinding(base);
    expect(binding.scope).toBe("scheduled-cycle");
    expect(binding.cycle_id).toBe("cycle-1");
    expect(binding.reason).toBeNull();

    writeFileSync(join(base, "lane-utilization.jsonl"), [
      JSON.stringify({ cycle_id: "cycle-1", phase: "open", ts: NOW }),
      JSON.stringify({ cycle_id: "cycle-1", phase: "outcome", ts: NOW }),
      "",
    ].join("\n"));
    const closed = resolveFactoryStateMutationCycle({
      producerId: "lane-utilization",
      requestedCycleId: "cycle-1",
      sentinelPath: join(base, "lane-utilization.jsonl.current-cycle"),
      laneLogPath: join(base, "lane-utilization.jsonl"),
    });
    expect(closed.scope).toBe("background");
    expect(() => assertFactoryStateMutationMayProceed("enforce", closed)).toThrow(/unbound/);
    expect(() => assertFactoryStateMutationMayProceed("shadow", closed)).not.toThrow();
  });

  test("separates missing and stale cycle context into background scope", () => {
    const base = root();
    const missing = resolveFactoryStateMutationCycle({ producerId: "slo-state" });
    expect(missing).toMatchObject({ scope: "background", cycle_id: "background:slo-state" });
    expect(missing.reason).toMatch(/no explicit/);
    expect(() => assertFactoryStateMutationMayProceed("enforce", missing)).toThrow(/unbound/);

    scheduledBinding(base);
    const stale = resolveFactoryStateMutationCycle({
      producerId: "slo-state",
      requestedCycleId: "cycle-2",
      sentinelPath: join(base, "lane-utilization.jsonl.current-cycle"),
      laneLogPath: join(base, "lane-utilization.jsonl"),
    });
    expect(stale.scope).toBe("background");
    expect(stale.reason).toMatch(/sentinel/);
  });

  test("derives typed lane and JSON-pointer transitions and preserves product identity", () => {
    expect(deriveFactoryStateMutationTransitions("lane-current-cycle/v1", "cycle-1\n", "cycle-2\n"))
      .toEqual(["$cycle_id"]);

    const before = JSON.stringify({
      schema_version: 1,
      ticket_id: "linear-uuid",
      identifier: "ZOU-1",
      preflight: {
        phase: "pre_dispatch",
        mode: "shadow",
        applicability: "required",
        decision: "hold",
        acted: false,
        reason_code: "missing_context",
        archetype: "feature",
        evidence: {
          repo_path: "/repo",
          path: null,
          source: "none",
          sha256: null,
          valid: false,
          reason: "missing",
          ticket_source_hash: "a".repeat(64),
        },
        comment_posted: false,
        evaluated_at: "2026-08-13T13:00:00.000Z",
      },
      updated_at: "2026-08-13T13:00:00.000Z",
    });
    const after = JSON.stringify({
      schema_version: 1,
      ticket_id: "linear-uuid",
      identifier: "ZOU-1",
      preflight: {
        phase: "pre_dispatch",
        mode: "shadow",
        applicability: "required",
        decision: "pass",
        acted: false,
        reason_code: "context_valid",
        archetype: "feature",
        evidence: {
          repo_path: "/repo",
          path: "PRODUCT.md",
          source: "root",
          sha256: "b".repeat(64),
          valid: true,
          reason: "valid",
          ticket_source_hash: "a".repeat(64),
        },
        comment_posted: false,
        evaluated_at: "2026-08-13T14:00:00.000Z",
      },
      updated_at: "2026-08-13T14:00:00.000Z",
    });
    expect(deriveFactoryStateMutationTransitions("product-gate/v1", before, after)).toEqual([
      "/preflight/decision",
      "/preflight/evaluated_at",
      "/preflight/evidence/path",
      "/preflight/evidence/reason",
      "/preflight/evidence/sha256",
      "/preflight/evidence/source",
      "/preflight/evidence/valid",
      "/preflight/reason_code",
      "/updated_at",
    ]);
    expect(() => deriveFactoryStateMutationTransitions(
      "product-gate/v1",
      before,
      after.replace('"ZOU-1"', '"ZOU-2"'),
    )).toThrow(/invariant/);
    expect(() => deriveFactoryStateMutationTransitions(
      "product-gate/v1",
      before,
      after.replace('"decision":"pass"', '"decision":"pass","unknown":true'),
    )).toThrow();
  });

  test("validates the production SLO state shape and rejects schema or type drift", () => {
    const before = JSON.stringify({
      version: 1,
      evaluated_at: "2026-08-13T13:00:00.000Z",
      evaluations: {},
      reviewed: {},
      breach_meta: {},
      transitions: [],
    });
    const after = JSON.stringify({
      version: 1,
      evaluated_at: "2026-08-13T14:00:00.000Z",
      evaluations: {
        cycle_time: {
          id: "cycle_time",
          status: "ok",
          value: 1,
          threshold: 2,
          denominator: 3,
          min_samples: 1,
          window_days: 7,
        },
      },
      reviewed: {},
      breach_meta: {},
      transitions: [{ slo: "cycle_time", from: null, to: "ok", at: "2026-08-13T14:00:00.000Z", by: "factory-slo", note: "" }],
    });
    expect(deriveFactoryStateMutationTransitions("slo-state/v1", before, after)).toEqual([
      "/evaluated_at",
      "/evaluations/cycle_time",
      "/transitions/0",
    ]);
    expect(() => deriveFactoryStateMutationTransitions("slo-state/v1", before, after.replace('"version":1', '"version":2')))
      .toThrow(/version/);
    expect(() => deriveFactoryStateMutationTransitions("slo-state/v1", before, after.replace('"reviewed":{}', '"reviewed":[]')))
      .toThrow(/object/);
  });

  test("creates deterministic content-addressed receipts and refuses unlisted transitions", () => {
    const base = root();
    const input = {
      action: "atomic-replace" as const,
      binding: scheduledBinding(base),
      target_path: "lane-utilization.jsonl.current-cycle",
      target_schema: "lane-current-cycle/v1" as const,
      before_payload: "cycle-1\n",
      after_payload: "cycle-2\n",
      allowed_transitions: ["$cycle_id"],
      recorded_at: NOW,
    };
    const first = createFactoryStateMutationReceipt(input);
    const second = createFactoryStateMutationReceipt(input);
    expect(first).toEqual(second);
    expect(first.receipt_id).toBe(`mutation:${first.content_hash}`);
    expect(first.before_sha256).toBe(factoryStateMutationPayloadSha256("cycle-1\n"));
    expect(validateFactoryStateMutationReceipt(first)).toEqual([]);
    expect(() => createFactoryStateMutationReceipt({ ...input, allowed_transitions: ["/updated_at"] })).toThrow(/not allowed/);
  });

  test("keeps off mode inert, writes shadow evidence, and fails closed in enforce", () => {
    const base = root();
    const binding = scheduledBinding(base);
    const common = {
      stateDir: base,
      producerId: "lane-utilization",
      requestedCycleId: "cycle-1",
      sentinelPath: binding.sentinel_path!,
      laneLogPath: binding.lane_log_path!,
      targetPath: "lane-utilization.jsonl.current-cycle",
      targetSchema: "lane-current-cycle/v1" as const,
      beforePayload: "cycle-0\n",
      afterPayload: "cycle-1\n",
      recordedAt: NOW,
    };
    const off = recordFactoryStateAtomicReplacement({ ...common, mode: "off" });
    expect(off).toMatchObject({ receipt: null, receipt_path: null, would_reject: false });
    expect(() => readFileSync(join(base, "state-mutation-evidence"), "utf8")).toThrow();

    const shadow = recordFactoryStateAtomicReplacement({ ...common, mode: "shadow" });
    expect(shadow.binding?.scope).toBe("scheduled-cycle");
    expect(shadow.receipt_path).not.toBeNull();
    expect(shadow.would_reject).toBe(false);

    writeFileSync(binding.sentinel_path!, "other-cycle\n");
    expect(() => recordFactoryStateAtomicReplacement({ ...common, mode: "enforce" })).toThrow(/unbound/);
  });

  test("bounds payloads and receipt serialization", () => {
    const base = root();
    expect(() => createFactoryStateMutationReceipt({
      action: "atomic-replace",
      binding: scheduledBinding(base),
      target_path: "lane-utilization.jsonl.current-cycle",
      target_schema: "lane-current-cycle/v1",
      before_payload: `${"x".repeat(FACTORY_STATE_MUTATION_PAYLOAD_MAX_BYTES)}\n`,
      after_payload: "cycle-2\n",
      allowed_transitions: ["$cycle_id"],
      recorded_at: NOW,
    })).toThrow(/exceeds/);
  });

  test("writes once, reads back, and detects tampering", () => {
    const base = root();
    const receipt = createFactoryStateMutationReceipt({
      action: "atomic-replace",
      binding: scheduledBinding(base),
      target_path: "lane-utilization.jsonl.current-cycle",
      target_schema: "lane-current-cycle/v1",
      before_payload: "cycle-1\n",
      after_payload: "cycle-2\n",
      allowed_transitions: ["$cycle_id"],
      recorded_at: NOW,
    });
    const path = writeFactoryStateMutationReceipt(receipt, { stateDir: base });
    expect(path).toBe(mutationReceiptPath(base, receipt));
    expect(writeFactoryStateMutationReceipt(receipt, { stateDir: base })).toBe(path);
    expect(readFactoryStateMutationReceipt(path)).toEqual(receipt);
    chmodSync(path, 0o600);
    writeFileSync(path, readFileSync(path, "utf8").replace("cycle-2", "cycle-3"));
    expect(() => readFactoryStateMutationReceipt(path)).toThrow(/invalid mutation receipt/);
    expect(() => writeFactoryStateMutationReceipt(receipt, { stateDir: base })).toThrow(/write-once/);
  });

  test("refuses a symlinked evidence root", () => {
    const base = root();
    const outside = root();
    mkdirSync(join(outside, "receipts"));
    symlinkSync(join(outside, "receipts"), join(base, FACTORY_STATE_MUTATION_EVIDENCE_ROOT));
    const receipt = createFactoryStateMutationReceipt({
      action: "atomic-replace",
      binding: scheduledBinding(base),
      target_path: "lane-utilization.jsonl.current-cycle",
      target_schema: "lane-current-cycle/v1",
      before_payload: "cycle-1\n",
      after_payload: "cycle-2\n",
      allowed_transitions: ["$cycle_id"],
      recorded_at: NOW,
    });
    expect(() => writeFactoryStateMutationReceipt(receipt, { stateDir: base })).toThrow(/real 0700 directory/);
  });

  test("binds claim ownership to an exact terminal execution record", () => {
    const base = root();
    const claimOwner = owner();
    const ownerPayload = `${JSON.stringify(claimOwner, null, 2)}\n`;
    expect(parseTicketClaimOwnerPayload(ownerPayload)).toEqual(claimOwner);
    const executionPath = join(base, "exec-exec-one.json");
    writeFileSync(executionPath, JSON.stringify({
      execution_id: "exec-one",
      ticket_id: "linear-uuid",
      state: "failed",
      status: "failed",
      started_at: "2026-08-13T13:00:00.000Z",
      completed_at: "2026-08-13T13:30:00.000Z",
    }));
    const terminal = validateFactoryStateClaimTerminalProof(claimOwner, executionPath);
    expect(terminal.lifecycle_state).toBe("failed");
    expect(terminal.execution_record_sha256).toMatch(/^[a-f0-9]{64}$/);

    const claimKey = factoryStateMutationPayloadSha256(claimOwner.ticket_id);
    const claimPath = join(base, "ticket-claims", claimKey);
    const prepared = createFactoryStateMutationReceipt({
      action: "claim-release",
      binding: resolveFactoryStateMutationCycle({ producerId: "ticket-claim-reaper" }),
      target_path: claimPath,
      target_schema: "ticket-claim-owner/v1",
      before_payload: ownerPayload,
      after_payload: "",
      allowed_transitions: ["$claim_removed"],
      recorded_at: NOW,
      claim_release: {
        stage: "prepared",
        claim_key: claimKey,
        claim_directory_path: claimPath,
        owner_path: join(claimPath, "owner.json"),
        owner_sha256: factoryStateMutationPayloadSha256(ownerPayload),
        owner: claimOwner,
        terminal,
      },
    });
    expect(validateFactoryStateMutationReceipt(prepared)).toEqual([]);
    const committed = createFactoryStateMutationReceipt({
      action: "claim-release",
      binding: prepared.binding,
      target_path: claimPath,
      target_schema: "ticket-claim-owner/v1",
      before_payload: ownerPayload,
      after_payload: "",
      allowed_transitions: ["$claim_removed"],
      recorded_at: "2026-08-13T14:54:17.000Z",
      claim_release: {
        ...prepared.claim_release!,
        stage: "committed",
        prepared_receipt_id: prepared.receipt_id,
      },
    });
    expect(committed.claim_release?.prepared_receipt_id).toBe(prepared.receipt_id);
  });

  test("rejects nonterminal and mismatched execution records", () => {
    const base = root();
    const claimOwner = owner();
    const path = join(base, "exec.json");
    writeFileSync(path, JSON.stringify({
      execution_id: "exec-one",
      ticket_id: "linear-uuid",
      state: "executing",
      status: "executing",
      started_at: "2026-08-13T13:00:00.000Z",
    }));
    expect(() => validateFactoryStateClaimTerminalProof(claimOwner, path)).toThrow(/not terminal/);
    writeFileSync(path, JSON.stringify({
      execution_id: "exec-other",
      ticket_id: "linear-uuid",
      state: "failed",
      status: "failed",
      started_at: "2026-08-13T13:00:00.000Z",
    }));
    expect(() => validateFactoryStateClaimTerminalProof(claimOwner, path)).toThrow(/identity/);
  });
});
