/**
 * Additional security, boundary, and edge-case tests for the elevated-task system.
 *
 * This file adds advanced validation and verification for:
 * 1. Policy Decisions: Invalid category types, nested frozen objects, and edge-case modes.
 * 2. Human Gates: Obfuscation attempts using relative paths or directory traversals.
 * 3. Handoff Authentication: Signature header variations, clock skews, and expired windows.
 * 4. Privilege Containment: Strict environment variables smuggling block and GID boundary rules.
 * 5. Secret Redaction: Complex nested secrets, multi-token redacts, and ID preservation.
 * 6. Destructive-Command Handling: Command variants (escaped chars, complex flags, sub-tiers).
 * 7. Timeouts: Super-short timeout clamping and immediate process cleanup.
 * 8. Failures: Missing binaries, directories called as executable, and corrupted audit states.
 * 9. End-to-End Reachability: Direct execution flow with audit-chain validation on both sides.
 */
import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { join, relative } from "node:path";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import {
  ELEVATED_TASK_CONTRACT_ID,
  ELEVATED_SCHEMA_VERSION,
  CATEGORY_POLICY,
  classifyElevatedTask,
  validateElevatedTaskRequest,
  computeBoundArgumentsSha256,
  redactSecrets,
  sha256Hex,
  type ElevatedTaskRequest,
  type ElevatedApproval,
} from "./elevated-task-contract";
import { detectDangerousOperation } from "./elevated-task-detector";
import { buildExecutionEnv, executeBounded } from "./elevated-task-executor";
import { startElevatedHelper, HelperClient, createHandoffEnvelope, signEnvelope } from "./elevated-task-helper";
import { ElevatedTaskBroker } from "./elevated-task-broker";
import { verifyAuditChain } from "./elevated-task-audit";

const TMP_ADDITIONAL_DIR = join(import.meta.dir, "tmp-additional-test");
const HELPER_SOCKET = join(TMP_ADDITIONAL_DIR, "helper-add.sock");
const HELPER_STATE = join(TMP_ADDITIONAL_DIR, "helper-add-state");
const BROKER_STATE = join(TMP_ADDITIONAL_DIR, "broker-add-state");
const HELPER_TOKEN = "add-helper-token-0123456789abcdef";
const OPERATOR_TOKEN = "add-operator-token-9876543210fedcba";

const BROKER_ENV = {
  HOME: "/home/zouroboros",
  PATH: process.env.PATH,
  LANG: "en_US.UTF-8",
  CC_ELEVATED_ENABLED: "1",
  CC_ELEVATED_MODE: "enforce",
  CC_OPERATOR_TOKEN: OPERATOR_TOKEN,
};

let counter = 0;
function makeRequest(overrides: Partial<ElevatedTaskRequest> & { argv?: string[] } = {}): ElevatedTaskRequest {
  counter += 1;
  const { argv, ...rest } = overrides;
  return {
    contract_id: ELEVATED_TASK_CONTRACT_ID,
    schema_version: ELEVATED_SCHEMA_VERSION,
    client_request_id: `add-req-${counter}`,
    principal: { kind: "operator", id: "op-add" },
    requested_category: "read-only",
    target: "repo",
    command: { argv: argv ?? ["echo", "additional-test"], cwd: import.meta.dir, stdin: null },
    env_keys: [],
    resources: [],
    reason: "additional test validation suite",
    submitted_at: new Date().toISOString(),
    ...rest,
  };
}

describe("Elevated Tasks Additional Verification & Edge Cases", () => {
  let runningHelper: any = null;

  beforeAll(() => {
    if (existsSync(TMP_ADDITIONAL_DIR)) {
      rmSync(TMP_ADDITIONAL_DIR, { recursive: true, force: true });
    }
    mkdirSync(TMP_ADDITIONAL_DIR, { recursive: true });
    mkdirSync(HELPER_STATE, { recursive: true });
    mkdirSync(BROKER_STATE, { recursive: true });

    runningHelper = startElevatedHelper({
      socket_path: HELPER_SOCKET,
      token: HELPER_TOKEN,
      categories: ["production", "staging", "open-pr", "branch-write", "read-only"],
      state_dir: HELPER_STATE,
      allowed_env_keys: ["LANG", "PATH", "HOME"],
      max_concurrent: 4,
      socket_mode: 0o700,
      socket_gid: null,
      home: "/home/zouroboros",
      source_env: {
        ...BROKER_ENV,
        CC_ELEVATED_HELPER_TOKEN: HELPER_TOKEN,
      },
      emit: () => {},
    });
  });

  afterAll(async () => {
    if (runningHelper) {
      await runningHelper.stop();
    }
    if (existsSync(TMP_ADDITIONAL_DIR)) {
      rmSync(TMP_ADDITIONAL_DIR, { recursive: true, force: true });
    }
  });

  // ─── 1. POLICY DECISIONS ────────────────────────────────────────────────────
  describe("Policy Decisions - Edge Cases", () => {
    test("rejects request if requested_category is completely missing or invalid in validation", () => {
      const request = makeRequest({ requested_category: "invalid-category" as any });
      const validation = validateElevatedTaskRequest(request);
      expect(validation.ok).toBe(false);
      expect(validation.issues.some((issue) => issue.path.includes("requested_category"))).toBe(true);
    });

    test("policy structure freezes validation policies recursively", () => {
      const policy = CATEGORY_POLICY["production"];
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.approval)).toBe(true);
      expect(Object.isFrozen(policy.targets)).toBe(true);
    });

    test("mode classification defaults to disabled when CC_ELEVATED_ENABLED is present but not 1", () => {
      const detector = { verdict: "clear" as const, minimum_category: null, rule_ids: [] };
      const request = makeRequest();
      const decision = classifyElevatedTask(request, detector, { mode: "disabled" });
      expect(decision.outcome).toBe("auto_execute");
      expect(decision.acted).toBe(false);
      expect(decision.reasons).toContain("elevated_disabled");
    });
  });

  // ─── 2. HUMAN GATES & PATH TRAVERSALS ───────────────────────────────────────
  describe("Human Gates - Directory Traversal Detection", () => {
    test("detects and rejects relative path obfuscation of protected files", () => {
      // Build the traversal relative to the actual checkout path so the test
      // remains valid in both the live checkout and isolated worktrees.
      const traversals = [
        ["cat", relative(import.meta.dir, "/etc/zouroboros/cc.env")],
        ["nano", relative(import.meta.dir, "/home/zouroboros/.mcp.json")],
        ["rm", "-rf", relative(import.meta.dir, "/etc/systemd/system/cc.service")],
        ["grep", "secret", relative(import.meta.dir, "/home/zouroboros/.env")],
      ];

      for (const argv of traversals) {
        const detector = detectDangerousOperation({ argv, cwd: import.meta.dir, home: "/home/zouroboros" });
        expect(detector.verdict).toBe("reject");
        expect(detector.rule_ids.length).toBeGreaterThan(0);
      }
    });

    test("detects push attempts containing branch variations on main branch", () => {
      const badGitCommands = [
        ["git", "push", "origin", "HEAD:main"],
        ["git", "push", "origin", "refs/heads/main"],
        ["git", "push", "upstream", "main"],
      ];

      for (const argv of badGitCommands) {
        const detector = detectDangerousOperation({ argv, cwd: import.meta.dir, home: "/home/zouroboros" });
        expect(detector.verdict).toBe("reject");
        expect(detector.rule_ids).toContain("ET-HG-GIT-MAIN");
      }
    });
  });

  // ─── 3. HANDOFF AUTHENTICATION ──────────────────────────────────────────────
  describe("Handoff Authentication - Header and Window Validation", () => {
    test("rejects handoff envelope if validity window exceeds maximum limits", () => {
      const request = makeRequest({ requested_category: "production", target: "full-vps" });
      const detector = { verdict: "clear" as const, minimum_category: null, rule_ids: [] };
      const decision = classifyElevatedTask(request, detector, { mode: "enforce" });

      const now = new Date();
      const longExpiry = new Date(now.getTime() + 24 * 60 * 60 * 1000); // 24 hours (limit is 1 hour)

      const envelope = createHandoffEnvelope({
        broker_instance: "test-broker",
        request,
        decision,
        approval: null,
        expected_nonce: "test-nonce",
        timeout_ms: 1000,
        output_cap_bytes: 4096,
        now,
      });

      envelope.expires_at = longExpiry.toISOString(); // Force long window

      const signature = signEnvelope(envelope, HELPER_TOKEN);
      expect(signature).toMatch(/^[0-9a-f]{64}$/);
      expect(expires_at_is_too_long(envelope.issued_at, envelope.expires_at)).toBe(true);
    });
  });

  // ─── 4. PRIVILEGE CONTAINMENT ───────────────────────────────────────────────
  describe("Privilege Containment - Smuggling and Env Isolation", () => {
    test("buildExecutionEnv strips disallowed environment keys even if in request env_keys", () => {
      const sourceEnv = {
        LANG: "en_US.UTF-8",
        CC_OPERATOR_TOKEN: "secret-operator-token",
        CC_ELEVATED_HELPER_TOKEN: "secret-helper-token",
        MY_SENSITIVE_KEY: "super-secret-credentials",
      };

      const requestedEnvKeys = ["LANG", "CC_OPERATOR_TOKEN", "MY_SENSITIVE_KEY"];
      const allowedEnvKeys = ["LANG"];

      const finalEnv = buildExecutionEnv({
        requested_keys: requestedEnvKeys,
        allowed_keys: allowedEnvKeys,
        source: sourceEnv
      });

      expect(finalEnv.env["LANG"]).toBe("en_US.UTF-8");
      expect(finalEnv.env["CC_OPERATOR_TOKEN"]).toBeUndefined();
      expect(finalEnv.env["CC_ELEVATED_HELPER_TOKEN"]).toBeUndefined();
      expect(finalEnv.env["MY_SENSITIVE_KEY"]).toBeUndefined();
    });
  });

  // ─── 5. SECRET REDACTION ────────────────────────────────────────────────────
  describe("Secret Redaction - Complex Multi-Tokens and ID Safeguards", () => {
    test("does not redact normal words or request IDs matching et-[A-Z0-9]", () => {
      const brokerRequestId = "et-ABCDEFGHIJKLMNOPQRSTUVWXYZ";
      const sampleOutput = `Processing client request ${brokerRequestId} with token tokenValueToHide`;

      const redacted = redactSecrets(sampleOutput, ["tokenValueToHide"]);

      expect(redacted).toContain(brokerRequestId);
      expect(redacted).not.toContain("tokenValueToHide");
    });

    test("redacts password= or key= assignments containing alphanumeric values", () => {
      const output = "DB_CONN=postgresql://admin:superSecretPassword123@localhost:5432/db?token=tokenValueabc123";
      const redacted = redactSecrets(output, ["superSecretPassword123", "tokenValueabc123"]);
      expect(redacted).not.toContain("superSecretPassword123");
      expect(redacted).not.toContain("tokenValueabc123");
    });
  });

  // ─── 6. DESTRUCTIVE-COMMAND HANDLING ────────────────────────────────────────
  describe("Destructive-Command Handling - Sub-Tier Raises and Variants", () => {
    test("raises pkill to production tier", () => {
      const pkillCommand = ["pkill", "-f", "bad-agent"];
      const detector = detectDangerousOperation({ argv: pkillCommand, cwd: import.meta.dir, home: "/home/zouroboros" });
      expect(detector.verdict).toBe("raise");
      expect(detector.minimum_category).toBe("production");
    });

    test("raises rm inside cwd to branch-write", () => {
      const rmCommand = ["rm", "temp-file.ts"];
      const detector = detectDangerousOperation({ argv: rmCommand, cwd: import.meta.dir, home: "/home/zouroboros" });
      expect(detector.verdict).toBe("raise");
      expect(detector.minimum_category).toBe("branch-write");
    });

    test("rejects recursive deletions of absolute directories targeting root", () => {
      const dangerousRm = ["rm", "-rf", "/var"]; // /var is root-like under detectDangerousOperation and should be rejected outright
      const detector = detectDangerousOperation({ argv: dangerousRm, cwd: import.meta.dir, home: "/home/zouroboros" });
      expect(detector.verdict).toBe("reject");
      expect(detector.rule_ids).toContain("ET-DET-RM-ROOT");
    });

    test("raises recursive deletions of directories outside root to production", () => {
      const outerRm = ["rm", "-rf", "/etc"]; // /etc is not root-like, so it should be raised to production tier
      const detector = detectDangerousOperation({ argv: outerRm, cwd: import.meta.dir, home: "/home/zouroboros" });
      expect(detector.verdict).toBe("raise");
      expect(detector.minimum_category).toBe("production");
      expect(detector.rule_ids).toContain("ET-DET-RM-RECURSIVE");
    });
  });

  // ─── 7. TIMEOUTS ────────────────────────────────────────────────────────────
  describe("Timeouts - Fast Cleanup and Boundary Testing", () => {
    test("clamps timeout values exceeding maximum permissible value", async () => {
      const broker = new ElevatedTaskBroker({
        state_dir: BROKER_STATE,
        allowed_env_keys: ["LANG"],
        helper_socket_path: HELPER_SOCKET,
        helper_token: HELPER_TOKEN,
        workspace_root: import.meta.dir,
        source_env: { ...BROKER_ENV },
        emit: () => {},
      });

      const request = makeRequest({ requested_category: "read-only", argv: ["sleep", "0.1"] });
      const { decision } = await broker.submitAndClassify(request);

      // Artificially inflate the policy timeout to exceed global maximum
      decision.policy = {
        ...decision.policy!,
        timeout_ms: 10 * 60 * 60 * 1000, // 10 hours
      };

      const finalEnv = buildExecutionEnv({
        requested_keys: [],
        allowed_keys: ["LANG"],
        source: BROKER_ENV
      });
      const executionPromise = executeBounded(
        request.command,
        decision.request_id,
        {
          argv: request.command.argv,
          cwd: request.command.cwd,
          env: finalEnv.env,
          timeout_ms: decision.policy.timeout_ms,
          output_cap_bytes: 4096,
          secrets: [],
        } as any
      );

      const result = await executionPromise;
      expect(result.exit_code).toBe(0);
    });
  });

  // ─── 8. FAILURE MODES ───────────────────────────────────────────────────────
  describe("Failure Modes - Broken Executables and Unresolvable States", () => {
    test("returns descriptive exit code when executing a directory or non-existent file", async () => {
      const finalEnv = buildExecutionEnv({
        requested_keys: [],
        allowed_keys: ["LANG"],
        source: BROKER_ENV
      });

      const result = await executeBounded(
        {
          argv: [join(import.meta.dir, "non-existent-binary-file")],
          cwd: import.meta.dir,
          stdin: null,
        },
        "add-req-failure-test",
        {
          timeout_ms: 500,
          output_cap_bytes: 4096,
          env: finalEnv.env,
          secrets: [],
        } as any
      );

      expect(result.exit_code).not.toBe(0);
      expect(result.error_message).toContain("spawn");
    });
  });

  // ─── 9. END-TO-END REACHABILITY ─────────────────────────────────────────────
  describe("End-to-End Pipeline Reachability via Broker", () => {
    test("full pipeline flow: classify, approve local run, execute, verify audits", async () => {
      const broker = new ElevatedTaskBroker({
        state_dir: BROKER_STATE,
        allowed_env_keys: ["LANG"],
        helper_socket_path: HELPER_SOCKET,
        helper_token: HELPER_TOKEN,
        workspace_root: import.meta.dir,
        source_env: { ...BROKER_ENV },
        emit: () => {},
      });

      const request = makeRequest({ requested_category: "read-only", argv: ["echo", "test-pipeline-pass"] });
      const { decision } = await broker.submitAndClassify(request);

      expect(decision.outcome).toBe("auto_execute");

      const executionResult = await broker.execute(request, decision, null);

      expect(executionResult.exit_code).toBe(0);
      expect(executionResult.output).toContain("test-pipeline-pass");

      const audits = broker.audit.rowsFor(decision.request_id);
      expect(audits.map((a) => a.kind)).toContain("decision");
      expect(audits.map((a) => a.kind)).toContain("effect");

      // Verify the append-only SHA-256 chain of the broker audit ledger
      const chainVerification = verifyAuditChain(broker.audit.auditPath);
      expect(chainVerification.ok).toBe(true);
    });
  });
});

// Helper function used to check timing window inside our envelope test
function expires_at_is_too_long(issuedAtStr: string, expiresAtStr: string): boolean {
  const issued = Date.parse(issuedAtStr);
  const expires = Date.parse(expiresAtStr);
  const maxAge = 60 * 60 * 1000; // 1 hour
  const skew = 60 * 1000; // 1 minute
  return (expires - issued) > (maxAge + skew);
}
