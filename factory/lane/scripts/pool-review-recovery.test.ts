import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecutionPolicy } from "./model-policy";
import { enqueueDirect, loadCampaigns, loadQueue } from "./pool-queue";
import {
  dispatchWorker,
  ensureDiversityPersonaContext,
  loadAssignments,
  mockComplete,
  readResult,
  isNonSubstantiveReview,
  remediateReviewAssignment,
  reReviewAssignment,
  reviewWorkerImplementation,
  saveAssignment,
} from "./pool-worker";
import type { PersonaCallRequest, PersonaOrchestratorDeps } from "./persona-orchestrator";

const reasoning: ExecutionPolicy = {
  tier: "Reasoning",
  pin_proposers: ["oc:a", "hf:b", "openrouter:c"],
  pin_aggregator: "hf:agg",
  model_chain: ["byok:0a635de6-5e45-4a8a-8e73-f1d25f31fd96"],
  review_level: "deterministic",
};

function persona(id: string, name: string): string {
  return `id='${id}' name='${name}' prompt='not persisted' model='persona-default' scopes=['all'] updated_at=None`;
}

function directory(): string[] {
  return [
    persona("zouro-id", "Zouroboros Engineer"),
    persona("reality-id", "Testing Reality Checker"),
    persona("ai-id", "AI Engineer"),
    persona("security-id", "Security Engineer"),
  ];
}

function personaDeps(
  artifactDir: string,
  calls: PersonaCallRequest[],
  verdict: "pass" | "fail" = "pass",
): PersonaOrchestratorDeps {
  return {
    mode: "enforce",
    artifact_dir: artifactDir,
    now: () => "2026-08-30T12:00:00.000Z",
    list_personas: async () => directory(),
    invoke_persona: async (request) => {
      calls.push(request);
      return {
        output: JSON.stringify({ verdict, summary: `${request.persona_id} ${verdict}` }),
        model_name: request.model_name,
        cost_usd: 0.01,
      };
    },
  };
}

function blockedPersonaDeps(artifactDir: string, calls: PersonaCallRequest[]): PersonaOrchestratorDeps {
  return {
    mode: "enforce",
    artifact_dir: artifactDir,
    now: () => "2026-08-30T12:00:00.000Z",
    list_personas: async () => directory(),
    invoke_persona: async (request) => {
      calls.push(request);
      throw new Error('/zo/ask returned 400: {"error":"BYOK model config not found for this workspace."}');
    },
  };
}

function withPoolState<T>(run: (dir: string) => Promise<T> | T): Promise<T> | T {
  const dir = mkdtempSync(join(tmpdir(), "pool-review-recovery-"));
  const prior = process.env.SF003_POOL_STATE_DIR;
  process.env.SF003_POOL_STATE_DIR = dir;
  const restore = () => {
    if (prior === undefined) delete process.env.SF003_POOL_STATE_DIR;
    else process.env.SF003_POOL_STATE_DIR = prior;
    rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = run(dir);
    if (result instanceof Promise) {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function seedCampaign(id: string, riskTier: string) {
  enqueueDirect({
    campaign_id: id,
    ticket_id: `linear-${id}`,
    identifier: "ZOU-1573",
    name: "HV-000 vertical slice",
    description: "Implement the free anonymous video pipeline",
    execution_policy: reasoning,
    risk_tier: riskTier,
  });
  const campaign = loadCampaigns()[id];
  const item = loadQueue().find((i) => i.campaign_id === id)!;
  return { campaign, item };
}

describe("ZOU-1573 diversity persona context", () => {
  test("synthesizes and persists the factory-default panel for high-tier campaigns", () => {
    return withPoolState(() => {
      const { campaign, item } = seedCampaign("campaign-high", "high");
      expect(campaign.persona_association ?? null).toBeNull();
      const changed = ensureDiversityPersonaContext(campaign, item);
      expect(changed).toBe(true);
      expect(campaign.persona_association).not.toBeNull();
      expect(item.persona_assignments?.length).toBeGreaterThan(0);
      const persisted = loadCampaigns()["campaign-high"];
      expect(persisted.persona_association).toEqual(campaign.persona_association);
      const persistedItem = loadQueue().find((i) => i.campaign_id === "campaign-high")!;
      expect(persistedItem.persona_assignments).toEqual(item.persona_assignments);
    });
  });

  test("no-op for tiers that do not mandate diversity review", () => {
    return withPoolState(() => {
      const { campaign, item } = seedCampaign("campaign-low", "low");
      expect(ensureDiversityPersonaContext(campaign, item)).toBe(false);
      expect(campaign.persona_association ?? null).toBeNull();
      expect(loadCampaigns()["campaign-low"].persona_association ?? null).toBeNull();
    });
  });

  test("review self-heals missing orchestration and supplies the mandated review", () => {
    return withPoolState(async (dir) => {
      const { campaign, item } = seedCampaign("campaign-heal", "high");
      const assignment = await dispatchWorker(campaign, item, {
        mock: true,
        persona_deps: { mode: "off" },
      });
      expect(assignment.persona_orchestration).toBeUndefined();
      mockComplete(assignment, "success", "pool implementation complete");
      const calls: PersonaCallRequest[] = [];
      const review = await reviewWorkerImplementation(
        campaign,
        item,
        assignment,
        { shadow_phase: "dry-run", ticket_description: "hv ticket" },
        { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
        personaDeps(dir, calls),
      );
      expect(review?.pass).toBe(true);
      expect(review?.diversity_terminal_state).toBe("pass");
      expect(review?.advance_to_verified).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      expect(readResult(assignment)?.outcome).toBe("success");
    });
  });

  test("blocked reviews record the review-gate blockage in failure.detail", async () => {
    const priorCascade = process.env.FACTORY_CODING_CASCADE;
    process.env.FACTORY_CODING_CASCADE = "shadow";
    try {
      await runBlockedDetailCase();
    } finally {
      if (priorCascade === undefined) delete process.env.FACTORY_CODING_CASCADE;
      else process.env.FACTORY_CODING_CASCADE = priorCascade;
    }
  });

  function runBlockedDetailCase() {
    return withPoolState(async (dir) => {
      const { campaign, item } = seedCampaign("campaign-detail", "high");
      const assignment = await dispatchWorker(campaign, item, {
        mock: true,
        persona_deps: { mode: "off" },
      });
      mockComplete(assignment, "success", "pool implementation complete");
      const review = await reviewWorkerImplementation(
        campaign,
        item,
        assignment,
        { shadow_phase: "dry-run", ticket_description: "hv ticket" },
        { mode: "enforce", deterministic: () => ({ pass: true, summary: "git diff --check passed" }) },
        { mode: "off" },
      );
      expect(review?.pass).toBe(false);
      expect(review?.blocking).toBe(true);
      expect(review?.diversity_terminal_state).toBe("no_review");
      const saved = loadAssignments().find((a) => a.assignment_id === assignment.assignment_id)!;
      expect(saved.failure?.kind).toBe("governance");
      expect(saved.failure?.detail.startsWith("factory review blocked (no_review)")).toBe(true);
      expect(saved.failure?.detail).toContain("git diff --check passed");
    });
  }

  test("re-review recovers a no_review deadlock without rebuilding", async () => {
    const priorCascade = process.env.FACTORY_CODING_CASCADE;
    process.env.FACTORY_CODING_CASCADE = "off";
    try {
      await withPoolState(async (dir) => {
        const { campaign, item } = seedCampaign("campaign-rereview", "high");
        const assignment = await dispatchWorker(campaign, item, {
          mock: true,
          persona_deps: { mode: "off" },
        });
        mockComplete(assignment, "success", "pool implementation complete");
        const blocked = await reviewWorkerImplementation(
          campaign,
          item,
          assignment,
          { shadow_phase: "dry-run", ticket_description: "hv ticket" },
          { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
          { mode: "off" },
        );
        expect(blocked?.diversity_terminal_state).toBe("no_review");
        expect(blocked?.blocking).toBe(true);
        expect(readResult(assignment)?.outcome).toBe("failure");

        const calls: PersonaCallRequest[] = [];
        const recovered = await reReviewAssignment(assignment.assignment_id, {
          workdir: dir,
          review_deps: { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
          persona_deps: personaDeps(dir, calls),
        });
        expect(recovered.pass).toBe(true);
        expect(recovered.blocking).toBe(false);
        expect(recovered.diversity_terminal_state).toBe("pass");
        expect(recovered.advance_to_verified).toBe(true);
        expect(calls.length).toBeGreaterThan(0);
        const saved = loadAssignments().find((a) => a.assignment_id === assignment.assignment_id)!;
        expect(saved.outcome).toBe("success");
        expect(saved.failure).toBeUndefined();
        expect(readResult(assignment)?.outcome).toBe("success");
      });
    } finally {
      if (priorCascade === undefined) delete process.env.FACTORY_CODING_CASCADE;
      else process.env.FACTORY_CODING_CASCADE = priorCascade;
    }
  });
});

describe("ZOU-1573 re-review of a non-substantive hold", () => {
  function withCascadeOff(run: () => Promise<void>): () => Promise<void> {
    return async () => {
      const prior = process.env.FACTORY_CODING_CASCADE;
      process.env.FACTORY_CODING_CASCADE = "off";
      try {
        await run();
      } finally {
        if (prior === undefined) delete process.env.FACTORY_CODING_CASCADE;
        else process.env.FACTORY_CODING_CASCADE = prior;
      }
    };
  }

  test("recovers a hold whose required reviews were all blocked before invocation", withCascadeOff(async () => {
    await withPoolState(async (dir) => {
      const { campaign, item } = seedCampaign("campaign-blocked-hold", "high");
      const assignment = await dispatchWorker(campaign, item, { mock: true, persona_deps: { mode: "off" } });
      mockComplete(assignment, "success", "pool implementation complete");
      const blockedCalls: PersonaCallRequest[] = [];
      const held = await reviewWorkerImplementation(
        campaign, item, assignment,
        { shadow_phase: "dry-run", ticket_description: "hv ticket" },
        { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
        blockedPersonaDeps(dir, blockedCalls),
      );
      expect(held?.diversity_terminal_state).toBe("hold");
      expect(held?.persona_reviews?.invoked_count).toBe(0);
      expect(isNonSubstantiveReview(held!)).toBe(true);

      const calls: PersonaCallRequest[] = [];
      const recovered = await reReviewAssignment(assignment.assignment_id, {
        workdir: dir,
        review_deps: { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
        persona_deps: personaDeps(dir, calls),
      });
      expect(recovered.diversity_terminal_state).toBe("pass");
      expect(recovered.advance_to_verified).toBe(true);
      expect(calls.length).toBeGreaterThan(0);
      expect(loadAssignments().find((a) => a.assignment_id === assignment.assignment_id)!.outcome).toBe("success");
    });
  }));

  test("refuses a hold carrying a real reviewer verdict", withCascadeOff(async () => {
    await withPoolState(async (dir) => {
      const { campaign, item } = seedCampaign("campaign-real-hold", "high");
      const assignment = await dispatchWorker(campaign, item, { mock: true, persona_deps: { mode: "off" } });
      mockComplete(assignment, "success", "pool implementation complete");
      const failCalls: PersonaCallRequest[] = [];
      const held = await reviewWorkerImplementation(
        campaign, item, assignment,
        { shadow_phase: "dry-run", ticket_description: "hv ticket" },
        { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
        personaDeps(dir, failCalls, "fail"),
      );
      expect(held?.diversity_terminal_state).toBe("hold");
      expect(held?.persona_reviews?.invoked_count).toBeGreaterThan(0);
      expect(isNonSubstantiveReview(held!)).toBe(false);
      await expect(reReviewAssignment(assignment.assignment_id, { workdir: dir }))
        .rejects.toThrow("non-substantive blocked hold");
    });
  }));
});

describe("ZOU-1574 review remediation lineage", () => {
  function initArtifact(root: string): { workdir: string; priorCommit: string } {
    const workdir = join(root, "artifact");
    mkdirSync(workdir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: workdir });
    execFileSync("git", ["config", "user.email", "factory-test@example.invalid"], { cwd: workdir });
    execFileSync("git", ["config", "user.name", "Factory Test"], { cwd: workdir });
    writeFileSync(join(workdir, "artifact.md"), "initial\n");
    execFileSync("git", ["add", "artifact.md"], { cwd: workdir });
    execFileSync("git", ["commit", "-qm", "initial artifact"], { cwd: workdir });
    const priorCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workdir, encoding: "utf8" }).trim();
    return { workdir, priorCommit };
  }

  test("preserves a substantive hold and reviews only a clean descendant commit", async () => {
    const priorCascade = process.env.FACTORY_CODING_CASCADE;
    process.env.FACTORY_CODING_CASCADE = "off";
    try {
      await withPoolState(async (dir) => {
        const { workdir, priorCommit } = initArtifact(dir);
        const { campaign, item } = seedCampaign("campaign-remediation", "high");
        const assignment = await dispatchWorker(campaign, item, { mock: true, persona_deps: { mode: "off" } });
        mockComplete(assignment, "success", `pool implementation complete at commit ${priorCommit.slice(0, 7)}`);
        const failCalls: PersonaCallRequest[] = [];
        const held = await reviewWorkerImplementation(
          campaign, item, assignment,
          { shadow_phase: "dry-run", ticket_description: "hv ticket", target_repo: workdir },
          { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
          personaDeps(dir, failCalls, "fail"),
        );
        expect(held?.diversity_terminal_state).toBe("hold");
        expect(held?.artifact_commit).toBe(priorCommit);
        const legacy = loadAssignments().find((candidate) => candidate.assignment_id === assignment.assignment_id)!;
        delete legacy.review?.artifact_commit;
        saveAssignment(legacy);
        const authority = { operator: "factory-test", note: "review findings were remediated in a committed descendant" };
        await expect(remediateReviewAssignment(assignment.assignment_id, { workdir, ...authority }))
          .rejects.toThrow("--prior-commit is required");
        await expect(remediateReviewAssignment(assignment.assignment_id, { workdir, prior_commit: priorCommit, ...authority }))
          .rejects.toThrow("already-reviewed commit");

        writeFileSync(join(workdir, "artifact.md"), "initial\nremediated\n");
        execFileSync("git", ["add", "artifact.md"], { cwd: workdir });
        execFileSync("git", ["commit", "-qm", "remediate findings"], { cwd: workdir });
        const remediatedCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: workdir, encoding: "utf8" }).trim();
        const passCalls: PersonaCallRequest[] = [];
        const recovered = await remediateReviewAssignment(assignment.assignment_id, {
          workdir,
          prior_commit: priorCommit,
          ...authority,
          review_deps: { mode: "enforce", deterministic: () => ({ pass: true, summary: "clean" }) },
          persona_deps: personaDeps(dir, passCalls, "pass"),
          now: () => "2026-08-30T13:00:00.000Z",
        });
        expect(recovered.advance_to_verified).toBe(true);
        expect(recovered.artifact_commit).toBe(remediatedCommit);
        const lineage = join(dir, "review-remediations", `${assignment.assignment_id}-${remediatedCommit}.json`);
        expect(existsSync(lineage)).toBe(true);
        const recorded = JSON.parse(readFileSync(lineage, "utf8"));
        expect(recorded.prior_artifact_commit).toBe(priorCommit);
        expect(recorded.remediated_artifact_commit).toBe(remediatedCommit);
        expect(recorded.prior_review.diversity_terminal_state).toBe("hold");
        expect(recorded.prior_review_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(recorded.operator).toBe("factory-test");
      });
    } finally {
      if (priorCascade === undefined) delete process.env.FACTORY_CODING_CASCADE;
      else process.env.FACTORY_CODING_CASCADE = priorCascade;
    }
  });
});
