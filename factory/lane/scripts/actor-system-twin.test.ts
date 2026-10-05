import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeActorTwinPorts,
  actorSha256,
  createActorSystemMachine,
  loadActorSystemContract,
  parseActorSystemManifest,
  startActorSystemTwin,
  type ActorAuthority,
  type ActorSystemManifest,
} from "./actor-system-twin.ts";

const planningManifest = "/home/workspace/Projects/zouroboros-evidence-substrate/plans/zou-1057-reviewed-synthetic-cohort-2026-08-20.json";
const root = mkdtempSync(join(tmpdir(), "zou-1057-c1-"));
const fixture = join(root, "cohort.json");
let manifest: ActorSystemManifest;
let manifestHash: string;

beforeAll(() => {
  const bytes = readFileSync(planningManifest);
  writeFileSync(fixture, bytes);
  manifest = parseActorSystemManifest(JSON.parse(bytes.toString("utf8")));
  manifestHash = createHash("sha256").update(bytes).digest("hex");
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function authority(contractId: string, overrides: Partial<ActorAuthority> = {}): ActorAuthority {
  const contract = manifest.contracts.find((entry) => entry.id === contractId)!;
  return {
    kind: "approved_manifest",
    manifestHash,
    contractHash: actorSha256(contract),
    reviewHash: "a".repeat(64),
    ...overrides,
  };
}

function loaded(contractId: string) {
  return loadActorSystemContract(fixture, contractId, authority(contractId));
}

describe("actor-system manifest authority", () => {
  test("loads the exact reviewed four-kind cohort", () => {
    expect(manifest.contracts).toHaveLength(20);
    expect(new Set(manifest.contracts.map((contract) => contract.actorKind))).toEqual(new Set(["user", "tool", "api", "system"]));
    expect(manifest.replicateSeeds).toEqual([1057001, 1057002, 1057003]);
  });

  test("rejects unknown fields, duplicate ids, and unregistered contracts", () => {
    expect(() => parseActorSystemManifest({ ...manifest, extra: true })).toThrow("unknown keys");
    expect(() => parseActorSystemManifest({ ...manifest, contracts: [manifest.contracts[0], manifest.contracts[0]] })).toThrow("duplicate contract ids");
    expect(() => parseActorSystemManifest({ ...manifest, contracts: [{ ...manifest.contracts[0], fault: "unbounded_retry" }] })).toThrow("fault is unsupported");
    expect(() => loadActorSystemContract(fixture, "unknown", authority("tool-success"))).toThrow("not approved");
  });

  test("fails closed on manifest, contract, or review authority drift", () => {
    expect(() => loadActorSystemContract(fixture, "tool-success", authority("tool-success", { manifestHash: "b".repeat(64) }))).toThrow("manifest hash mismatch");
    expect(() => loadActorSystemContract(fixture, "tool-success", authority("tool-success", { contractHash: "b".repeat(64) }))).toThrow("contract hash mismatch");
    expect(() => loadActorSystemContract(fixture, "tool-success", authority("tool-success", { reviewHash: "missing" }))).toThrow("authority hashes");
  });
});

describe("deterministic actor-system machine", () => {
  test("all 20 contracts reach their reviewed terminal with bounded attempts", () => {
    for (const contract of manifest.contracts) {
      const machine = createActorSystemMachine(loaded(contract.id), 1057001);
      const response = machine.handle({ requestId: `request-${contract.id}`, approval: contract.approval === "required_allow" ? "allow" : "deny" });
      expect(response.terminal).toBe(contract.expectedTerminal);
      expect(response.attempts).toBeLessThanOrEqual(2);
      expect(response.stateVersion).toBe(response.committed ? 2 : 1);
    }
  });

  test("same inputs are byte-identical and registered seed variation is bounded", () => {
    const first = createActorSystemMachine(loaded("user-delayed-response"), 1057001);
    const second = createActorSystemMachine(loaded("user-delayed-response"), 1057001);
    const third = createActorSystemMachine(loaded("user-delayed-response"), 1057002);
    first.handle({ requestId: "request-1" });
    second.handle({ requestId: "request-1" });
    third.handle({ requestId: "request-1" });
    expect(first.transcript()).toEqual(second.transcript());
    expect(third.transcript().sha256).not.toBe(first.transcript().sha256);
    expect(third.transcript().entries[0].response.delayMs).toBeWithin(5, 50);
    expect(() => createActorSystemMachine(loaded("tool-success"), 99)).toThrow("not registered");
  });

  test("duplicate requests are idempotent and do not append or recommit", () => {
    const machine = createActorSystemMachine(loaded("user-duplicate-submit"), 1057001);
    const first = machine.handle({ requestId: "duplicate" });
    const replay = machine.handle({ requestId: "duplicate" });
    expect(first.idempotentReplay).toBe(false);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.responseId).toBe(first.responseId);
    expect(machine.transcript().entries).toHaveLength(1);
    expect(machine.state().version).toBe(2);
  });

  test("partial and cancellation faults compensate without committing", () => {
    for (const id of ["api-partial-response", "system-partial-commit", "tool-cancel-during-run"]) {
      const machine = createActorSystemMachine(loaded(id), 1057001);
      const response = machine.handle({ requestId: id });
      expect(response.compensated).toBe(true);
      expect(response.committed).toBe(false);
    }
  });

  test("approval boundaries deny missing allow and bypass attempts", () => {
    const allow = createActorSystemMachine(loaded("user-approval-allow"), 1057001);
    expect(() => allow.handle({ requestId: "allow-missing" })).toThrow("approval allow");
    const bypass = createActorSystemMachine(loaded("system-approval-bypass"), 1057001);
    expect(() => bypass.handle({ requestId: "bypass", approval: "allow" })).toThrow("bypass is denied");
  });

  test("undeclared request fields, invalid approvals, and credential-shaped ids fail closed", () => {
    const machine = createActorSystemMachine(loaded("tool-success"), 1057001);
    expect(() => machine.handle({ requestId: "request-ok", payload: "raw" } as any)).toThrow("unknown keys");
    expect(() => machine.handle({ requestId: "request-ok", approval: "maybe" } as any)).toThrow("approval is invalid");
    expect(() => machine.handle({ requestId: "ghp_1234567890" })).toThrow("requestId is invalid");
    expect(machine.transcript().entries).toHaveLength(0);
  });

  test("interrupted operation resumes once and exposes clean terminal state", () => {
    const machine = createActorSystemMachine(loaded("system-interrupted-resume-cleanup"), 1057003);
    const response = machine.handle({ requestId: "resume" });
    expect(response.resumed).toBe(true);
    expect(response.terminal).toBe("completed");
    expect(machine.state().status).toBe("completed");
  });
});

describe("loopback wrapper", () => {
  test("serves deterministic requests on loopback and stops", async () => {
    const twin = startActorSystemTwin(loaded("tool-transient-retry"), 1057001);
    try {
      expect(twin.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/actor$/);
      const response = await fetch(twin.url, { method: "POST", body: JSON.stringify({ requestId: "network-request" }) });
      expect(response.status).toBe(200);
      expect((await response.json() as any).attempts).toBe(2);
      expect(twin.transcript().entries).toHaveLength(1);
    } finally {
      twin.stop();
    }
    expect(activeActorTwinPorts()).toEqual([]);
  });
});
