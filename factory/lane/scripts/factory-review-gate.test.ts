import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFactoryReviewGate } from "./factory-review-gate";
import type { ExecutionPolicy } from "./model-policy";
import { enqueueDirect, loadCampaigns, loadQueue } from "./pool-queue";
import { buildWorkerPrompt, dispatchWorker, loadAssignments, mockComplete, readResult, reviewWorkerImplementation } from "./pool-worker";
import type { PersonaOrchestrationRecord } from "./persona-orchestrator";
import { compileValidationContract } from "./validation-contract";
import { createValidatorAuthority, createValidatorVerdict } from "./validator-authority";


/**
 * Injected so the suite can never resolve the *live* persona directory. Left to the
 * default caller, this test reaches api.zo.computer whenever FACTORY_PERSONA_ROUTING_MODE
 * is set in the ambient environment — which is how it timed out inside the conveyor
 * preflight while passing standalone.
 */
const PERSONA_DIRECTORY = [
  "Zouroboros Engineer",
  "Testing Reality Checker",
  "AI Engineer",
  "Security Engineer",
].map((name, index) => `id='persona-${index}' name='${name}' prompt='not persisted' model='persona-default' scopes=['all'] updated_at=None`);

const reasoning: ExecutionPolicy = {
  tier: "Reasoning",
  pin_proposers: ["oc:a", "hf:b", "openrouter:c"],
  pin_aggregator: "hf:agg",
  model_chain: ["byok:first"],
  review_level: "consensus",
};

function input(stateDir: string, policy: ExecutionPolicy | null = reasoning) {
  return {
    execution_id: "exec-review-1",
    identifier: "ZOU-599",
    implementation_summary: "implemented scoped policy handoff",
    ticket_context: "acceptance criteria",
    workdir: "/home/workspace/Projects/zouroboros-software-factory",
    policy,
    risk_tier: "medium",
    state_dir: stateDir,
  };
}

function reviewEvidence(verdict: "pass" | "fail", required = true): PersonaOrchestrationRecord["invocations"][number] {
  return {
    required,
    status: "invoked",
    verdict,
    distinct_model: true,
    vendor_diverse: true,
  } as PersonaOrchestrationRecord["invocations"][number];
}

function specialistReview(pass = true) {
  return async () => ({
    mode: "enforce" as const,
    pass,
    required_count: 1,
    invoked_count: 1,
    reviews: [reviewEvidence(pass ? "pass" : "fail")],
    summary: pass ? "required specialist review passed" : "required specialist review failed",
    new_cost_usd: 0,
  });
}

const firstPassDigest = (character: string): string => `sha256:${character.repeat(64)}`;

function firstPassVerdict(verdict: "pass" | "fail" | "flaky" | "held") {
  const contract = compileValidationContract({
    execution_id: "exec-review-1",
    ticket: "ZOU-599",
    candidate_cycle_id: "exec-review-1:0",
    compiled_at: "2026-08-28T15:09:01Z",
    seed_digest: firstPassDigest("a"),
    criteria: [{ id: "AC-1", behavior: "Review exact behavior", evidence: [{ kind: "command", locator: "bun test" }] }],
    environment: {
      repository: "repo",
      base_commit_digest: firstPassDigest("b"),
      harness: "validator-runtime",
      validator_version: "v1",
      required_env_names: [],
    },
  });
  if (!contract.ok) throw new Error(contract.errors.join("; "));
  const executor = { id: "builder", harness: "codex", model: "gpt-5.6" };
  const validator = { id: "validator", harness: "validator-runtime", model: "deterministic-v1" };
  const authority = createValidatorAuthority({
    executor,
    validator,
    candidate_worktree: "/work/candidate",
    validator_worktree: "/work/validator",
    environment_digest: firstPassDigest("c"),
    fresh_context: true,
    filesystem_read_only: true,
    detached_head: true,
  });
  if (!authority.ok) throw new Error(authority.errors.join("; "));
  const result = createValidatorVerdict({
    contract: contract.contract,
    authority: authority.authority,
    execution_id: contract.contract.execution_id,
    candidate_cycle_id: contract.contract.candidate_cycle_id,
    candidate_commit_digest: firstPassDigest("d"),
    validation_contract_digest: contract.contract.contract_digest,
    validator_environment_digest: authority.authority.environment_digest,
    evidence_digest: firstPassDigest("e"),
    validator,
    verdict,
    defect_classes: verdict === "flaky" ? ["flaky_test"] : verdict === "pass" ? [] : ["behavioral_regression"],
    reasons: verdict === "pass" ? [] : ["validation did not pass"],
    decided_at: "2026-08-28T16:00:00Z",
  });
  if (!result.ok) throw new Error(result.errors.join("; "));
  return result.verdict;
}

describe("factory review gate", () => {
  test("required first-pass validation blocks enforce unless the exact verdict passes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      for (const verdict of ["fail", "flaky", "held"] as const) {
        const result = await runFactoryReviewGate({
          ...input(dir, null),
          first_pass_required: true,
          first_pass_validation: firstPassVerdict(verdict),
        }, {
          mode: "enforce",
          deterministic: () => ({ pass: true, summary: "clean" }),
        });
        expect(result.pass).toBe(false);
        expect(result.blocking).toBe(true);
        expect(result.advance_to_verified).toBe(false);
        expect(result.first_pass_validation?.verdict).toBe(verdict);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shadow records a failed first-pass verdict without changing incumbent authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate({
        ...input(dir, null),
        first_pass_required: true,
        first_pass_validation: firstPassVerdict("fail"),
      }, {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
      });
      expect(result.pass).toBe(true);
      expect(result.blocking).toBe(false);
      expect(result.advance_to_verified).toBe(false);
      expect(result.first_pass_validation?.verdict).toBe("fail");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("specialist implement paths narrow the worker prompt boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-prompt-"));
    const prior = process.env.SF003_POOL_STATE_DIR;
    process.env.SF003_POOL_STATE_DIR = dir;
    try {
      enqueueDirect({
        campaign_id: "campaign-persona-prompt",
        ticket_id: "ticket-persona-prompt",
        identifier: "ZOU-1282",
        name: "persona prompt",
        description: "verify specialist boundary",
      });
      const campaign = loadCampaigns()["campaign-persona-prompt"];
      const item = loadQueue()[0];
      const assignment = {
        assignment_id: "asg-persona-prompt",
        campaign_id: campaign.campaign_id,
        task_id: item.task_id,
        model: "byok:test",
        attempt: 0,
        started_at: "2026-08-10T00:00:00.000Z",
        heartbeat_path: join(dir, "heartbeat"),
        result_path: join(dir, "result.json"),
        timeout_min: 30,
        completed_at: null,
        outcome: null,
        mock: true,
        execution_policy: null,
      };
      const prompt = buildWorkerPrompt(campaign, item, assignment, {
        shadow_phase: "dry-run",
        persona_implement_owned_paths: ["src/render/shader.ts"],
      });
      expect(prompt).toContain("Specialist implementation boundary");
      expect(prompt).toContain("- src/render/shader.ts");
      expect(prompt).toContain("broader task-owned file list does not expand");
    } finally {
      if (prior === undefined) delete process.env.SF003_POOL_STATE_DIR;
      else process.env.SF003_POOL_STATE_DIR = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("required persona critics run after deterministic review and substantiate only a passing gate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    const order: string[] = [];
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "enforce",
        deterministic: () => { order.push("deterministic"); return { pass: true, summary: "clean" }; },
        persona_review: async (deterministic) => {
          order.push(`persona:${deterministic.pass}`);
          return {
            mode: "enforce",
            pass: true,
            required_count: 1,
            invoked_count: 1,
            reviews: [reviewEvidence("pass")],
            summary: "required critic passed",
            new_cost_usd: 0.01,
          };
        },
      });
      expect(order).toEqual(["deterministic", "persona:true"]);
      expect(result.pass).toBe(true);
      expect(result.substantiated).toBe(true);
      expect(result.advance_to_verified).toBe(true);
      expect(result.outcome_verifier).toEqual({
        id: "factory-review-gate:exec-review-1",
        harness: "factory-review-gate",
        model: "persona-attested/deterministic-review-v1",
      });
      expect(result.persona_reviews?.required_count).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("missing or failing required persona review blocks enforce", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
        persona_review: async () => ({
          mode: "enforce",
          pass: false,
          required_count: 1,
          invoked_count: 0,
          reviews: [],
          summary: "required critic missing",
          new_cost_usd: 0,
        }),
      });
      expect(result.pass).toBe(false);
      expect(result.blocking).toBe(true);
      expect(result.advance_to_verified).toBe(false);
      expect(result.outcome_verifier).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shadow persona evidence never changes deterministic authority", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
        persona_review: async () => ({
          mode: "shadow",
          pass: false,
          required_count: 1,
          invoked_count: 0,
          reviews: [],
          summary: "would invoke",
          new_cost_usd: 0,
        }),
      });
      expect(result.pass).toBe(true);
      expect(result.blocking).toBe(false);
      expect(result.advance_to_verified).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("legacy consensus receives no promotion credit even when it passed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let consensusCalls = 0;
      const result = await runFactoryReviewGate({
        ...input(dir, null),
        prior_verification: { kind: "consensus", status: "passed", reference: "cg-pipeline" },
      }, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        consensus: async () => { consensusCalls++; return { pass: true, summary: "unused", consensus_id: "x", confidence: 1 }; },
      });
      expect(result.review_level).toBe("deterministic");
      expect(result.substantiated).toBe(false);
      expect(result.substantiation).toContain("legacy Model Consensus does not confer implementation or promotion credit");
      expect(result.advance_to_verified).toBe(false);
      expect(consensusCalls).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("enforce will not promote a clean diff that nothing substantive reviewed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate(input(dir, null), {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        consensus: async () => ({ pass: true, summary: "unused", consensus_id: "x", confidence: 1 }),
      });
      // The work is not rejected — it simply is not promoted on a whitespace
      // check alone. Missing substantive review fails closed.
      expect(result.pass).toBe(true);
      expect(result.blocking).toBe(false);
      expect(result.substantiated).toBe(false);
      expect(result.advance_to_verified).toBe(false);
      expect(result.substantiation).toContain("required pre-promotion persona diversity review is absent or did not pass");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an absent or failed prior consensus does not substantiate", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      for (const status of ["absent", "needs-review", "failed"]) {
        const result = await runFactoryReviewGate({
          ...input(dir, null),
          prior_verification: { kind: "consensus", status, reference: null },
        }, {
          mode: "enforce",
          deterministic: () => ({ pass: true, summary: "clean" }),
        });
        expect(result.substantiated).toBe(false);
        expect(result.advance_to_verified).toBe(false);
        expect(result.substantiation).toContain("substantive persona diversity review is still required");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an operator approval does not bypass required promotion personas", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate({
        ...input(dir, null),
        prior_verification: { kind: "operator", status: "passed", reference: "marlandoj" },
      }, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
      });
      expect(result.substantiated).toBe(false);
      expect(result.substantiation).toContain("does not replace substantive implementation review");
      expect(result.advance_to_verified).toBe(false);
      expect(result.blocking).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shadow never promotes even when fully substantiated", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      const result = await runFactoryReviewGate({
        ...input(dir, null),
        prior_verification: { kind: "consensus", status: "passed", reference: "cg-1" },
      }, {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
      });
      expect(result.substantiated).toBe(false);
      expect(result.advance_to_verified).toBe(false);
      expect(result.blocking).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("Reasoning work uses persona diversity and never invokes legacy consensus", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let consensusCalls = 0;
      const result = await runFactoryReviewGate(input(dir), {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        model_review_authorized: true,
        consensus: async () => { consensusCalls++; return { pass: true, summary: "unused", consensus_id: "cg-1", confidence: 0.9 }; },
        persona_review: async () => ({
          mode: "enforce",
          pass: false,
          required_count: 2,
          invoked_count: 2,
          reviews: [reviewEvidence("fail")],
          summary: "required persona dissented",
          new_cost_usd: 0.02,
        }),
      });
      expect(consensusCalls).toBe(0);
      expect(result.pass).toBe(false);
      expect(result.blocking).toBe(true);
      expect(result.advance_to_verified).toBe(false);
      expect(result.review_strategy).toBe("diversity-of-thought");
      expect(result.diversity_terminal_state).toBe("hold");
      expect(result.dissent_count).toBe(1);
      expect(JSON.parse(readFileSync(join(dir, "review-exec-review-1.json"), "utf8")).consensus).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("shadow records persona dissent without advancing or blocking", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let consensusCalls = 0;
      const result = await runFactoryReviewGate(input(dir), {
        mode: "shadow",
        deterministic: () => ({ pass: true, summary: "clean" }),
        model_review_authorized: true,
        consensus: async () => { consensusCalls++; return { pass: false, summary: "unused", consensus_id: null, confidence: null }; },
        persona_review: async () => ({
          mode: "shadow",
          pass: true,
          required_count: 2,
          invoked_count: 0,
          reviews: [reviewEvidence("fail")],
          summary: "would invoke persona reviewers",
          new_cost_usd: 0,
        }),
      });
      expect(consensusCalls).toBe(0);
      expect(result.pass).toBe(true);
      expect(result.blocking).toBe(false);
      expect(result.advance_to_verified).toBe(false);
      expect(result.diversity_terminal_state).toBe("shadow");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("high risk requires a passing persona diversity review", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let calls = 0;
      const high = { ...input(dir, null), risk_tier: "high" };
      const result = await runFactoryReviewGate(high, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        consensus: async () => { calls++; return { pass: true, summary: "unused", consensus_id: "cg-2", confidence: 0.95 }; },
        persona_review: async () => ({
          mode: "enforce",
          pass: true,
          required_count: 2,
          invoked_count: 2,
          reviews: [reviewEvidence("pass"), reviewEvidence("pass")],
          summary: "required persona reviews passed",
          new_cost_usd: 0.02,
        }),
      });
      expect(calls).toBe(0);
      expect(result.review_level).toBe("diversity");
      expect(result.advance_to_verified).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("high risk fails closed when persona diversity evidence is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-gate-"));
    try {
      let calls = 0;
      const high = { ...input(dir, null), risk_tier: "high" };
      const result = await runFactoryReviewGate(high, {
        mode: "enforce",
        deterministic: () => ({ pass: true, summary: "clean" }),
        consensus: async () => { calls++; return { pass: true, summary: "passed", consensus_id: "cg-unexpected", confidence: 0.95 }; },
      });
      expect(calls).toBe(0);
      expect(result.review_level).toBe("diversity");
      expect(result.pass).toBe(false);
      expect(result.blocking).toBe(true);
      expect(result.advance_to_verified).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("serialized pool policy selects the worker chain and reaches the same review resolver", async () => {
    const dir = mkdtempSync(join(tmpdir(), "review-pool-"));
    const prior = process.env.SF003_POOL_STATE_DIR;
    process.env.SF003_POOL_STATE_DIR = dir;
    try {
      enqueueDirect({
        campaign_id: "campaign-policy",
        ticket_id: "ticket-1",
        identifier: "ZOU-599",
        name: "policy parity",
        description: "verify pool policy",
        execution_policy: reasoning,
        risk_tier: "high",
      });
      const campaign = loadCampaigns()["campaign-policy"];
      const item = loadQueue()[0];
      const assignment = await dispatchWorker(campaign, item, {
        mock: true,
        persona_deps: { mode: "shadow", list_personas: async () => PERSONA_DIRECTORY },
      });
      expect(assignment.model).toBe("byok:first");
      expect(assignment.execution_policy).toEqual(reasoning);
      const personaRecord: PersonaOrchestrationRecord = {
        version: 1,
        campaign_id: "campaign-policy",
        task_id: item.task_id,
        mode: "enforce",
        association: {
          template_reference: "game@1.0.0",
          version: "1.0.0",
          sha256: "a".repeat(64),
          content_fingerprint: "b".repeat(64),
        },
        directory: { snapshot_hash: "c".repeat(64), captured_at: "2026-08-10T00:00:00.000Z" },
        invocations: [{
          role_id: "reality-check",
          phase: "review",
          required: true,
          status: "not_invoked",
          selector: "Testing Reality Checker",
          persona_id: "reality-id",
          persona_name: "Testing Reality Checker",
          scopes: ["verification"],
          owned_paths: [],
          association_version: "1.0.0",
          association_sha256: "a".repeat(64),
          directory_snapshot_hash: "c".repeat(64),
          model_name: "byok:463350ac-4a49-4ceb-8653-042ecffa513f",
          resolved_model_name: null,
          harness: "zo-ask",
          invocation_key: null,
          requested_at: null,
          completed_at: null,
          prompt_sha256: null,
          result_sha256: null,
          artifact_ref: null,
          artifact_sha256: null,
          result_ref: null,
          cost_usd: null,
          reused: false,
          verdict: null,
          reason: null,
        }],
        omitted_roles: [],
        blocked_reason: null,
        total_cost_usd: 0,
        created_at: "2026-08-10T00:00:00.000Z",
        updated_at: "2026-08-10T00:00:00.000Z",
      };
      assignment.persona_orchestration = personaRecord;
      assignment.resolved_model = "byok:7c082f03-a53a-4978-8a67-e0bb06c25d51";
      mockComplete(assignment, "success", "pool implementation complete");
      let consensusCalls = 0;
      const review = await reviewWorkerImplementation(
        campaign,
        item,
        assignment,
        { shadow_phase: "dry-run", ticket_description: "policy ticket" },
        {
          mode: "enforce",
          deterministic: () => ({ pass: true, summary: "clean" }),
          consensus: async () => { consensusCalls++; return { pass: true, summary: "unused", consensus_id: "cg-pool", confidence: 0.97 }; },
        },
        {
          mode: "enforce",
          artifact_dir: dir,
          now: () => "2026-08-21T12:00:00.000Z",
          list_personas: async () => PERSONA_DIRECTORY,
          invoke_persona: async (request) => ({
            output: JSON.stringify({ verdict: "pass", summary: "production reality verified" }),
            model_name: request.model_name,
            cost_usd: 0.01,
          }),
        },
      );
      expect(consensusCalls).toBe(0);
      expect(review?.advance_to_verified).toBe(true);
      expect(loadAssignments()[0].review?.review_strategy).toBe("diversity-of-thought");
      expect(loadAssignments()[0].review?.consensus).toBeNull();
      expect(readResult(assignment)?.persona_orchestration).toEqual(personaRecord);
    } finally {
      if (prior === undefined) delete process.env.SF003_POOL_STATE_DIR;
      else process.env.SF003_POOL_STATE_DIR = prior;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
