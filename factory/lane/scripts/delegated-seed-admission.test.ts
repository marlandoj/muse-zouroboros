import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSeedContract, projectDelegationExecutionFields, verifyDelegatedSeedAdmission } from "./pool-queue";

const directories: string[] = [];

function temporaryDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "delegated-seed-admission-"));
  directories.push(path);
  return path;
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("delegated seed admission", () => {
  test("legacy seeds retain absent-field behavior and partial blocks fail closed", () => {
    const root = temporaryDirectory();
    const seedPath = join(root, "seed.yaml");
    writeFileSync(seedPath, "tasks:\n  - id: T1\n    name: task\n    deps: []\n");
    expect(parseSeedContract(seedPath)).toMatchObject({ delegation: null, delegation_remote_action: null });
    writeFileSync(seedPath, [
      "delegation:",
      `  mandate_path: ${join(root, "mandate.json")}`,
      "tasks:",
      "  - id: T1",
      "    name: task",
      "    deps: []",
    ].join("\n"));
    expect(() => parseSeedContract(seedPath)).toThrow("delegation is incomplete");
    const complete = [
      "delegation:",
      `  mandate_path: ${join(root, "mandate.json")}`,
      `  activation_receipt_path: ${join(root, "activation.json")}`,
      `  receipt_path: ${join(root, "l1-receipt.json")}`,
      `  action_payload_path: ${join(root, "l1-action.json")}`,
      `  evidence_path: ${join(root, "l1-evidence.json")}`,
      "tasks:",
      "  - id: T1",
      "    name: task",
      "    deps: []",
    ].join("\n");
    writeFileSync(seedPath, complete);
    expect(() => parseSeedContract(seedPath)).toThrow("complete L1 and L2");
  });

  test("the production pool admission helper blocks before pool state mutation", async () => {
    const root = temporaryDirectory();
    const repository = join(root, "repo");
    const state = join(root, "state");
    const seedPath = join(root, "seed.yaml");
    Bun.spawnSync(["git", "init", repository]);
    writeFileSync(seedPath, "tasks:\n  - id: T1\n    name: task\n    deps: []\n");
    process.env.FACTORY_STATE_MODE = "test";
    process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
    process.env.FACTORY_STATE_DIR = state;
    expect(() => verifyDelegatedSeedAdmission({
      delegation: {
        mandate_path: join(root, "missing-mandate.json"),
        activation_receipt_path: join(root, "missing-activation.json"),
        receipt_path: join(root, "missing-receipt.json"),
        action_payload_path: join(root, "missing-action.json"),
        evidence_path: join(root, "missing-evidence.json"),
      },
      seedPath,
      ticket: "ZOU-307",
      expectedRepository: "marlandoj/zouroboros-workspace",
      keyPath: join(root, "missing-key"),
      auditLogPath: join(root, "audit.jsonl"),
    })).toThrow("delegated seed admission blocked");
    expect(existsSync(join(state, "pool", "campaigns.json"))).toBe(false);
    expect(existsSync(join(state, "pool", "queue.json"))).toBe(false);
  });

  test("complete L2 metadata survives the production seed-to-execution projection", () => {
    const root = temporaryDirectory();
    const seedPath = join(root, "seed.yaml");
    const block = (name: string, prefix: string) => [
      `${name}:`,
      `  mandate_path: ${join(root, `${prefix}-mandate.json`)}`,
      `  activation_receipt_path: ${join(root, `${prefix}-activation.json`)}`,
      `  receipt_path: ${join(root, `${prefix}-receipt.json`)}`,
      `  action_payload_path: ${join(root, `${prefix}-action.json`)}`,
      `  evidence_path: ${join(root, `${prefix}-evidence.json`)}`,
    ].join("\n");
    writeFileSync(seedPath, [block("delegation", "l1"), block("delegation_remote_action", "l2"), "tasks:", "  - id: T1", "    name: task", "    deps: []"].join("\n"));
    const contract = parseSeedContract(seedPath);
    const admission = {
      receipt_sha256: "a".repeat(64),
      seed_sha256: "b".repeat(64),
      action_payload_sha256: "c".repeat(64),
      evidence_sha256: "d".repeat(64),
      mandate_sha256: "e".repeat(64),
      risk_lane: "L1_local_reversible" as const,
    };
    expect(projectDelegationExecutionFields(contract, admission)).toEqual({
      project_delegation: { paths: contract.delegation, l1_admission: admission },
      project_delegation_remote_action: contract.delegation_remote_action,
    });
  });
});
