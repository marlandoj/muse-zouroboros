import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join } from "node:path";
import { rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import {
  ELEVATED_TASK_CONTRACT_ID,
  ELEVATED_SCHEMA_VERSION,
  type ElevatedTaskRequest,
  type ElevatedApproval,
} from "./elevated-task-contract";
import { ElevatedTaskBroker } from "./elevated-task-broker";
import { startElevatedHelper, helperConfigFromEnv } from "./elevated-task-helper";
import { verifyAuditChain } from "./elevated-task-audit";

const TMP_TEST_DIR = join(import.meta.dir, "tmp-broker-test");
const HELPER_SOCKET = join(TMP_TEST_DIR, "helper.sock");
const HELPER_STATE = join(TMP_TEST_DIR, "helper-state");
const BROKER_STATE = join(TMP_TEST_DIR, "broker-state");
const HELPER_TOKEN = "test-helper-secret-token-32-chars-long";

const BASE_ENV = {
  HOME: "/home/zouroboros",
  PATH: process.env.PATH,
  LANG: "en_US.UTF-8",
  CC_ELEVATED_ENABLED: "1",
  CC_ELEVATED_MODE: "enforce",
};

const SAFE_REQUEST: ElevatedTaskRequest = {
  contract_id: ELEVATED_TASK_CONTRACT_ID,
  schema_version: ELEVATED_SCHEMA_VERSION,
  client_request_id: "req-safe-111",
  principal: { kind: "operator", id: "op-1" },
  requested_category: "read-only",
  target: "repo",
  command: {
    argv: ["echo", "hello-world"],
    cwd: import.meta.dir,
    stdin: null,
  },
  env_keys: ["LANG"],
  resources: [],
  reason: "Testing safe local execution",
  submitted_at: new Date().toISOString(),
};

describe("ElevatedTaskBroker & Privileged Helper Integration", () => {
  let runningHelper: any = null;

  beforeAll(() => {
    if (existsSync(TMP_TEST_DIR)) {
      rmSync(TMP_TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TMP_TEST_DIR, { recursive: true });
    mkdirSync(HELPER_STATE, { recursive: true });
    mkdirSync(BROKER_STATE, { recursive: true });

    // Start the privileged helper
    runningHelper = startElevatedHelper({
      socket_path: HELPER_SOCKET,
      token: HELPER_TOKEN,
      categories: ["production", "staging", "open-pr", "branch-write", "read-only"],
      state_dir: HELPER_STATE,
      allowed_env_keys: ["LANG", "PATH", "HOME"],
      max_concurrent: 4,
      socket_mode: 0o700,
      socket_gid: null,
      home: BASE_ENV.HOME,
      source_env: {
        ...BASE_ENV,
        CC_ELEVATED_HELPER_TOKEN: HELPER_TOKEN,
      },
      emit: () => {},
    });
  });

  afterAll(async () => {
    if (runningHelper) {
      await runningHelper.stop();
    }
    if (existsSync(TMP_TEST_DIR)) {
      rmSync(TMP_TEST_DIR, { recursive: true, force: true });
    }
  });

  test("submitAndClassify handles low-tier auto-execute read-only repo target", async () => {
    const broker = new ElevatedTaskBroker({
      state_dir: BROKER_STATE,
      allowed_env_keys: ["LANG"],
      helper_socket_path: HELPER_SOCKET,
      helper_token: HELPER_TOKEN,
      workspace_root: import.meta.dir,
      source_env: { ...BASE_ENV },
      emit: () => {},
    });

    const { decision, nonce } = await broker.submitAndClassify(SAFE_REQUEST);
    expect(decision.outcome).toBe("auto_execute");
    expect(decision.effective_category).toBe("read-only");
    expect(nonce).toBeNull();

    const auditRows = broker.audit.rowsFor(decision.request_id);
    expect(auditRows.length).toBe(1);
    expect(auditRows[0].kind).toBe("decision");
    expect(auditRows[0].record.category).toBe("read-only");
  });

  test("execute runs auto-execute tasks locally (broker site)", async () => {
    const broker = new ElevatedTaskBroker({
      state_dir: BROKER_STATE,
      allowed_env_keys: ["LANG"],
      helper_socket_path: HELPER_SOCKET,
      helper_token: HELPER_TOKEN,
      workspace_root: import.meta.dir,
      source_env: { ...BASE_ENV },
      emit: () => {},
    });

    const req = { ...SAFE_REQUEST, client_request_id: "req-safe-222" };
    const { decision } = await broker.submitAndClassify(req);

    const result = await broker.execute(req, decision, null);
    expect(result.exit_code).toBe(0);
    expect(result.output.trim()).toBe("hello-world");
    expect(result.truncated).toBe(false);

    // Verify local audit trail
    const auditRows = broker.audit.rowsFor(decision.request_id);
    expect(auditRows.some(row => row.kind === "intent")).toBe(true);
    expect(auditRows.some(row => row.kind === "effect")).toBe(true);

    const effectRow = auditRows.find(row => row.kind === "effect")!;
    expect(effectRow.context.execution_site).toBe("broker");
    expect(effectRow.context.outcome_code).toBe("completed");

    // Verify output persistence
    expect(result.full_output_path).not.toBeNull();
    expect(existsSync(result.full_output_path!)).toBe(true);
    expect(readFileSync(result.full_output_path!, "utf8").trim()).toBe("hello-world");
  });

  test("replay protection blocks executing the same request id twice", async () => {
    const broker = new ElevatedTaskBroker({
      state_dir: BROKER_STATE,
      allowed_env_keys: ["LANG"],
      helper_socket_path: HELPER_SOCKET,
      helper_token: HELPER_TOKEN,
      workspace_root: import.meta.dir,
      source_env: { ...BASE_ENV },
      emit: () => {},
    });

    const req = { ...SAFE_REQUEST, client_request_id: "req-safe-333" };
    const { decision } = await broker.submitAndClassify(req);

    await broker.execute(req, decision, null);

    // Re-execution of the same request id must fail immediately
    expect(broker.execute(req, decision, null)).rejects.toThrow("replay protection");
  });

  test("execute routes production / full-vps target requests to the helper", async () => {
    const broker = new ElevatedTaskBroker({
      state_dir: BROKER_STATE,
      allowed_env_keys: ["LANG", "PATH", "HOME"],
      helper_socket_path: HELPER_SOCKET,
      helper_token: HELPER_TOKEN,
      workspace_root: import.meta.dir,
      source_env: {
        ...BASE_ENV,
        CC_ELEVATED_HELPER_TOKEN: HELPER_TOKEN,
      },
      emit: () => {},
    });

    const req: ElevatedTaskRequest = {
      contract_id: ELEVATED_TASK_CONTRACT_ID,
      schema_version: ELEVATED_SCHEMA_VERSION,
      client_request_id: "req-vps-999",
      principal: { kind: "operator", id: "op-1" },
      requested_category: "production",
      target: "full-vps",
      command: {
        argv: ["echo", "vps-priv-helper-output"],
        cwd: import.meta.dir,
        stdin: null,
      },
      env_keys: ["LANG"],
      resources: [],
      reason: "Full VPS target task execution",
      submitted_at: new Date().toISOString(),
    };

    const { decision, nonce } = await broker.submitAndClassify(req);
    expect(decision.effective_category).toBe("production");
    expect(decision.policy?.executes_in).toBe("helper");
    expect(nonce).not.toBeNull();

    // Disable plan gate preflight check for testing purposes to avoid blocking on missing plan artifact.
    // Policies are frozen, so override via a copy rather than mutating the shared table.
    decision.policy = { ...decision.policy!, plan_gate_mode: "disabled" };

    // Create approval
    const approval: ElevatedApproval = {
      contract_id: ELEVATED_TASK_CONTRACT_ID,
      schema_version: ELEVATED_SCHEMA_VERSION,
      request_id: decision.request_id,
      bound_arguments_sha256: decision.bound_arguments_sha256!,
      nonce: nonce!,
      second_secret_hash: "5e884898da28047151d0e56f8dc6292773603d0d6aabbdd62a11ef721d1542d8", // SHA256 of "password"
      approver_fingerprint: "fingerprint-abc-123",
      approved_at: new Date().toISOString(),
    };

    // Run execution with correct second secret
    const result = await broker.execute(req, decision, approval, {
      second_secret: "password",
      expected_nonce: nonce!,
    });

    expect(result.exit_code).toBe(0);
    expect(result.output.trim()).toBe("vps-priv-helper-output");

    // Validate broker audit trail shows helper execution site
    const brokerRows = broker.audit.rowsFor(decision.request_id);
    const intentRow = brokerRows.find(row => row.kind === "intent")!;
    expect(intentRow.context.execution_site).toBe("helper");

    const effectRow = brokerRows.find(row => row.kind === "effect")!;
    expect(effectRow.context.execution_site).toBe("helper");
    expect(effectRow.context.helper_pid).not.toBeNull();

    // Verify both broker and helper audit files are hash-chained properly
    const brokerChain = verifyAuditChain(broker.audit.auditPath);
    expect(brokerChain.ok).toBe(true);

    const helperAuditPath = join(HELPER_STATE, "audit", "elevated-audit.jsonl");
    const helperChain = verifyAuditChain(helperAuditPath);
    expect(helperChain.ok).toBe(true);
  });

  test("execution timeout SIGTERM / SIGKILL is handled and audited correctly", async () => {
    const broker = new ElevatedTaskBroker({
      state_dir: BROKER_STATE,
      allowed_env_keys: ["LANG", "PATH"],
      helper_socket_path: HELPER_SOCKET,
      helper_token: HELPER_TOKEN,
      workspace_root: import.meta.dir,
      source_env: { ...BASE_ENV },
      emit: () => {},
    });

    const req: ElevatedTaskRequest = {
      contract_id: ELEVATED_TASK_CONTRACT_ID,
      schema_version: ELEVATED_SCHEMA_VERSION,
      client_request_id: "req-timeout-abc",
      principal: { kind: "operator", id: "op-1" },
      requested_category: "read-only",
      target: "repo",
      command: {
        argv: ["sleep", "10"],
        cwd: import.meta.dir,
        stdin: null,
      },
      env_keys: [],
      resources: [],
      reason: "Sleep command that will time out",
      submitted_at: new Date().toISOString(),
    };

    const { decision } = await broker.submitAndClassify(req);

    // Override policy timeout to 200ms to force rapid timeout
    decision.policy = {
      ...decision.policy!,
      timeout_ms: 200,
    };

    expect(broker.execute(req, decision, null)).rejects.toThrow("command exceeded");

    // Check that audit row captures "timed_out" failure
    const brokerRows = broker.audit.rowsFor(decision.request_id);
    const effectRow = brokerRows.find(row => row.kind === "effect")!;
    expect(effectRow.context.outcome_code).toBe("timed_out");
    expect(effectRow.record.exit_code).toBeNull();
  });

  test("output truncation and original content hashing work correctly", async () => {
    const broker = new ElevatedTaskBroker({
      state_dir: BROKER_STATE,
      allowed_env_keys: ["LANG", "PATH"],
      helper_socket_path: HELPER_SOCKET,
      helper_token: HELPER_TOKEN,
      workspace_root: import.meta.dir,
      source_env: { ...BASE_ENV },
      emit: () => {},
    });

    const req: ElevatedTaskRequest = {
      contract_id: ELEVATED_TASK_CONTRACT_ID,
      schema_version: ELEVATED_SCHEMA_VERSION,
      client_request_id: "req-truncate-xyz",
      principal: { kind: "operator", id: "op-1" },
      requested_category: "read-only",
      target: "repo",
      command: {
        argv: ["echo", "A".repeat(1000)],
        cwd: import.meta.dir,
        stdin: null,
      },
      env_keys: [],
      resources: [],
      reason: "Echoing a long string to trigger mock output limit",
      submitted_at: new Date().toISOString(),
    };

    const { decision } = await broker.submitAndClassify(req);

    // Inject low output cap into policy
    decision.policy = {
      ...decision.policy!,
      output_cap_bytes: 10,
    };

    const result = await broker.execute(req, decision, null);
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(10);
    expect(result.output_bytes).toBe(1001); // 1000 A's + \n

    // Verify output_sha256 covers the ORIGINAL untruncated output ("A".repeat(1000) + "\n")
    const originalText = "A".repeat(1000) + "\n";
    const crypto = require("node:crypto");
    const expectedSha = crypto.createHash("sha256").update(originalText).digest("hex");
    expect(result.output_sha256).toBe(expectedSha);
  });

  test("broker redacts process-start secrets in both local and helper execution outputs", async () => {
    const broker = new ElevatedTaskBroker({
      state_dir: BROKER_STATE,
      allowed_env_keys: ["LANG", "PATH"],
      helper_socket_path: HELPER_SOCKET,
      helper_token: HELPER_TOKEN,
      workspace_root: import.meta.dir,
      source_env: {
        ...BASE_ENV,
        SUPER_SECRET_TOKEN: "supersecret12345",
      },
      emit: () => {},
    });

    const req: ElevatedTaskRequest = {
      contract_id: ELEVATED_TASK_CONTRACT_ID,
      schema_version: ELEVATED_SCHEMA_VERSION,
      client_request_id: "req-redact-token",
      principal: { kind: "operator", id: "op-1" },
      requested_category: "read-only",
      target: "repo",
      command: {
        argv: ["echo", "Authorization: Bearer supersecret12345 is my bearer token"],
        cwd: import.meta.dir,
        stdin: null,
      },
      env_keys: [],
      resources: [],
      reason: "Printing out a secret to verify redaction",
      submitted_at: new Date().toISOString(),
    };

    const { decision } = await broker.submitAndClassify(req);
    const result = await broker.execute(req, decision, null);

    expect(result.output).not.toContain("supersecret12345");
    expect(result.output).toContain("[REDACTED_SECRET]");
  });
});
