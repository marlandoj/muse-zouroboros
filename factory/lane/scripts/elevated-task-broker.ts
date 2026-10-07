#!/usr/bin/env bun
/**
 * Governed elevated-task broker (threat-model R1, R4).
 *
 * Coordinates the full life-cycle of elevated requests: structure validation,
 * dangerous-operation detection, five-category policy classification, approval
 * verification, plan consensus gate preflight checks, local in-process execution,
 * and signed Unix-socket handoffs to the isolated privileged helper. All actions
 * are audited in an append-only, hash-chained ledger.
 */

import { join } from "node:path";
import { existsSync, mkdirSync, closeSync, openSync } from "node:fs";
import {
  ELEVATED_TASK_CONTRACT_ID,
  ELEVATED_SCHEMA_VERSION,
  validateElevatedTaskRequest,
  classifyElevatedTask,
  computeBoundArgumentsSha256,
  resolveElevatedMode,
  verifyApproval,
  createAuditRecord,
  policyFor,
  redactSecrets,
  type ElevatedTaskRequest,
  type ElevatedTaskDecision,
  type ElevatedApproval,
  type ElevatedExecutionResult,
  type ElevatedCategory,
} from "./elevated-task-contract";
import { detectDangerousOperation } from "./elevated-task-detector";
import {
  buildExecutionEnv,
  collectSecretValues,
  executeBounded,
  toExecutionResult,
} from "./elevated-task-executor";
import {
  HelperClient,
  createHandoffEnvelope,
} from "./elevated-task-helper";
import { ElevatedAuditStore, type PlanGateAuditSummary } from "./elevated-task-audit";
import { runSwarmPlanGatePreflight } from "../../../packages/zo-swarm-orchestrator/src/plan-gate-preflight.ts";

export interface BrokerConfig {
  /** Root directory for storing audits, dispatched markers, and full logs. */
  state_dir: string;
  /** Extra env keys allowed to be passed down to executed commands. */
  allowed_env_keys: string[];
  /** Unix socket path where the privileged helper listens. */
  helper_socket_path: string;
  /** Cryptographic helper HMAC-SHA256 signature token. */
  helper_token: string;
  /** Path to the workspace root for drift/validation checks. */
  workspace_root?: string;
  /** Process/CC environment dictionary. */
  source_env: Record<string, string | undefined>;
  now?: () => Date;
  emit?: (line: string) => void;
}

export class ElevatedTaskBroker {
  private readonly config: BrokerConfig;
  private readonly auditStore: ElevatedAuditStore;
  private readonly dispatchedDir: string;
  private readonly now: () => Date;

  constructor(config: BrokerConfig) {
    this.config = config;
    this.now = config.now ?? (() => new Date());
    this.auditStore = new ElevatedAuditStore({
      state_dir: config.state_dir,
      secrets: collectSecretValues(config.source_env, [config.helper_token]),
      emit: config.emit,
      now: this.now,
    });
    this.dispatchedDir = join(config.state_dir, "dispatched");
    mkdirSync(this.dispatchedDir, { recursive: true, mode: 0o700 });
  }

  get audit(): ElevatedAuditStore {
    return this.auditStore;
  }

  /**
   * Evaluates and classifies a new task request, running the safety detector,
   * determining policy, generating a unique request ID, and issuing a single-use
   * approval nonce if manual operator approval is required.
   */
  async submitAndClassify(
    request: ElevatedTaskRequest,
    options: { rung_cap?: ElevatedCategory } = {},
  ): Promise<{ decision: ElevatedTaskDecision; nonce: string | null }> {
    const nowTime = this.now();
    const mode = resolveElevatedMode(this.config.source_env);

    // 1. Structure check
    const validation = validateElevatedTaskRequest(request);
    if (!validation.ok) {
      const emptyDetector = { verdict: "clear" as const, minimum_category: null, rule_ids: [] };
      const decision = classifyElevatedTask(request, emptyDetector, {
        mode,
        now: nowTime,
        rung_cap: options.rung_cap,
      });
      await this.auditStore.append("decision", createAuditRecord(request, decision, null, null));
      return { decision, nonce: null };
    }

    // 2. Dangerous actions scanning
    const detectorSummary = detectDangerousOperation({
      argv: request.command.argv,
      cwd: request.command.cwd,
      home: this.config.source_env["HOME"],
      cc_clone_root: this.config.workspace_root,
    });

    // 3. Category & policy routing
    const decision = classifyElevatedTask(request, detectorSummary, {
      mode,
      now: nowTime,
      rung_cap: options.rung_cap,
    });

    let nonce: string | null = null;
    if (decision.policy && decision.policy.execution === "approval") {
      const crypto = require("node:crypto");
      nonce = crypto.randomBytes(16).toString("hex");
    }

    // 4. Record decision to append-only audit trail
    await this.auditStore.append("decision", createAuditRecord(request, decision, null, null));

    return { decision, nonce };
  }

  /**
   * Verifies and executes an approved or auto-executable elevated task request.
   * If the category executes locally and targets the repo, runs in-process with execution bounds.
   * If the category is production or target is full-VPS, hands off to the isolated helper socket.
   */
  async execute(
    request: ElevatedTaskRequest,
    decision: ElevatedTaskDecision,
    approval: ElevatedApproval | null,
    options: {
      second_secret?: string;
      expected_nonce?: string;
      stored_second_secret_hash?: string;
    } = {},
  ): Promise<ElevatedExecutionResult & { full_output_path?: string | null }> {
    const nowTime = this.now();

    // 1. Ensure structural validity
    const validation = validateElevatedTaskRequest(request);
    if (!validation.ok) {
      throw new Error(`invalid request: ${validation.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
    }

    const category = decision.effective_category;
    if (!category) {
      throw new Error("cannot execute unclassified task");
    }

    // 1b. Only executable outcomes in enforce mode may reach the dispatcher. A
    // detector reject/hold or a shadow-mode decision still carries an effective
    // category, so this guard must not rely on the category alone.
    if (decision.outcome !== "auto_execute" && decision.outcome !== "await_approval") {
      const message = `decision outcome ${decision.outcome} is not executable (${decision.reasons.join(",")})`;
      await this.auditStore.append("rejected", createAuditRecord(request, decision, approval, null, message), {
        outcome_code: "decision_not_executable",
      });
      throw new Error(`cannot execute: ${message}`);
    }
    if (!decision.acted) {
      const message = `elevated mode is ${decision.mode}, not enforce`;
      await this.auditStore.append("rejected", createAuditRecord(request, decision, approval, null, message), {
        outcome_code: "mode_not_enforce",
      });
      throw new Error(`cannot execute: ${message}`);
    }

    const policy = decision.policy ?? policyFor(category);

    // 2. Local duplicate/replay protection
    const dispatchedFile = join(this.dispatchedDir, decision.request_id);
    try {
      closeSync(openSync(dispatchedFile, "wx", 0o600));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`replay protection: request ${decision.request_id} has already been executed on this host`);
      }
      throw error;
    }

    // 3. Explicit Approval Escallation Gating
    if (policy.execution === "approval") {
      if (!approval) {
        throw new Error(`policy ${policy.rule_id} requires operator approval`);
      }
      const verifyResult = verifyApproval(request, decision, approval, {
        now: nowTime,
        expected_nonce: options.expected_nonce,
        stored_second_secret_hash: options.stored_second_secret_hash,
        second_secret: options.second_secret,
      });
      if (!verifyResult.ok) {
        throw new Error(`approval verification failed: ${verifyResult.message}`);
      }
    }

    // 4. Plan Consensus Gate Gating
    let planGateSummary: PlanGateAuditSummary | null = null;
    if (policy.plan_gate_mode !== "disabled") {
      try {
        const planGateConfig = {
          mode: policy.plan_gate_mode,
          workspaceRoot: this.config.workspace_root ?? "/opt/zouroboros/repo",
          ledgerPath: join(this.config.state_dir, "plan-gate", "audit.jsonl"),
          audit: true,
          auditContext: {
            executionId: decision.request_id,
            identifier: request.client_request_id,
          },
        };
        const planGateDecision = runSwarmPlanGatePreflight(planGateConfig);
        planGateSummary = {
          mode: planGateDecision.mode,
          action: planGateDecision.action,
          reason: planGateDecision.reason,
          ledger_ref: null,
        };

        if (policy.plan_gate_mode === "enforce" && planGateDecision.action === "hold") {
          const heldRecord = createAuditRecord(request, decision, approval, null, `held by plan gate: ${planGateDecision.reason}`);
          await this.auditStore.append("held", heldRecord, {
            plan_gate: planGateSummary,
            outcome_code: "plan_gate_held",
          });
          throw new Error(`execution held by plan consensus gate: ${planGateDecision.reason}`);
        }
      } catch (error) {
        if (policy.plan_gate_mode === "enforce") {
          const heldRecord = createAuditRecord(request, decision, approval, null, `plan gate error: ${String(error)}`);
          await this.auditStore.append("held", heldRecord, {
            outcome_code: "plan_gate_error",
          });
          throw error;
        }
      }
    }

    // 5. Execution Site Routing (full-VPS targets strictly execute in privileged helper)
    const executeInHelper = policy.executes_in === "helper" || request.target === "full-vps";

    if (!executeInHelper) {
      // ─── Broker local execution ─────────────────────────────────────────────
      const envBuild = buildExecutionEnv({
        requested_keys: request.env_keys,
        allowed_keys: this.config.allowed_env_keys,
        source: this.config.source_env,
      });

      const baseRecord = createAuditRecord(request, decision, approval, null, null);
      await this.auditStore.append("intent", baseRecord, {
        execution_site: "broker",
        plan_gate: planGateSummary,
        note: envBuild.refused.length ? `env refused: ${envBuild.refused.map((e) => `${e.key}(${e.reason})`).join(",")}` : null,
      });

      const outcome = await executeBounded(request.command, decision.request_id, {
        timeout_ms: policy.timeout_ms,
        output_cap_bytes: policy.output_cap_bytes,
        env: envBuild.env,
        secrets: collectSecretValues(this.config.source_env, [this.config.helper_token]),
        now: this.now,
      });

      let fullOutputPath: string | null = null;
      try {
        fullOutputPath = this.auditStore.writeFullOutput(decision.request_id, outcome.full_output).path;
      } catch {}

      const result = toExecutionResult(outcome);
      await this.auditStore.append("effect", createAuditRecord(request, decision, approval, result, outcome.error_message), {
        execution_site: "broker",
        plan_gate: planGateSummary,
        outcome_code: outcome.failure ?? "completed",
      });

      if (outcome.failure && outcome.failure !== "nonzero_exit") {
        throw new Error(`execution failed: ${outcome.error_message}`);
      }

      return { ...result, full_output_path: fullOutputPath };
    } else {
      // ─── Signed Unix-socket handoff to privileged helper ───────────────────
      const envelope = createHandoffEnvelope({
        broker_instance: "cc-broker-v1",
        request,
        decision,
        approval,
        expected_nonce: options.expected_nonce ?? null,
        timeout_ms: policy.timeout_ms,
        output_cap_bytes: policy.output_cap_bytes,
        now: nowTime,
      });

      const client = new HelperClient({
        socket_path: this.config.helper_socket_path,
        token: this.config.helper_token,
      });

      const baseRecord = createAuditRecord(request, decision, approval, null, null);
      await this.auditStore.append("intent", baseRecord, {
        execution_site: "helper",
        plan_gate: planGateSummary,
      });

      const handoffResult = await client.execute(envelope, policy.timeout_ms + 5000);

      if (handoffResult.kind === "unreachable") {
        const heldRecord = createAuditRecord(request, decision, approval, null, `helper unreachable: ${handoffResult.message}`);
        await this.auditStore.append("held", heldRecord, {
          execution_site: "helper",
          plan_gate: planGateSummary,
          outcome_code: "helper_unreachable",
        });
        throw new Error(`helper process is unreachable: ${handoffResult.message}`);
      }

      if (handoffResult.kind === "ambiguous") {
        const heldRecord = createAuditRecord(request, decision, approval, null, `ambiguous handoff: ${handoffResult.message}`);
        await this.auditStore.append("held", heldRecord, {
          execution_site: "helper",
          plan_gate: planGateSummary,
          outcome_code: "handoff_ambiguous",
        });
        throw new Error(`handoff outcome is ambiguous: ${handoffResult.message}`);
      }

      const res = handoffResult.response;
      if (!res.accepted) {
        const resultRecord = createAuditRecord(request, decision, approval, null, `helper refused handoff: ${res.refusal_code} - ${res.refusal_message}`);
        await this.auditStore.append("effect", resultRecord, {
          execution_site: "helper",
          helper_pid: res.helper_pid,
          plan_gate: planGateSummary,
          outcome_code: `refused_${res.refusal_code}`,
        });
        throw new Error(`helper refused task handoff: ${res.refusal_message}`);
      }

      // The helper only knows its own secrets. Scrub the broker's set from the
      // returned text as well before it reaches the audit trail or the caller.
      // The hash still covers the helper's persisted output, which is the audit basis.
      const brokerSecrets = collectSecretValues(this.config.source_env, [this.config.helper_token]);
      const helperResult = res.result
        ? { ...res.result, output: redactSecrets(res.result.output, brokerSecrets) }
        : null;
      const helperError = res.error_message ? redactSecrets(res.error_message, brokerSecrets) : null;

      await this.auditStore.append("effect", createAuditRecord(request, decision, approval, helperResult, helperError), {
        execution_site: "helper",
        helper_pid: res.helper_pid,
        plan_gate: planGateSummary,
        outcome_code: res.failure ?? "completed",
      });

      if (res.failure && res.failure !== "nonzero_exit") {
        throw new Error(`execution failed: ${helperError}`);
      }

      if (!helperResult) {
        throw new Error(`helper accepted execution but returned no result`);
      }

      return { ...helperResult, full_output_path: res.full_output_path };
    }
  }
}
