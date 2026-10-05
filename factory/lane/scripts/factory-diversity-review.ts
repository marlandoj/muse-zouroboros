import { createHash } from "node:crypto";
import {
  defaultCostCeiling,
  parseSeedContract,
  personaAssociationFingerprint,
  type Campaign,
  type SeedPersonaAssociation,
  type TaskPersonaAssignment,
  type WorkItem,
} from "./pool-queue";
import {
  preparePersonaOrchestration,
  resolvePersonaOrchestrationMode,
  runPersonaReviews,
  type PersonaOrchestrationRecord,
  type PersonaOrchestratorDeps,
  type PersonaReviewGateResult,
} from "./persona-orchestrator";

export type DiversityReviewTerminalState = "pass" | "pass_with_dissent" | "hold" | "shadow" | "no_review";

export interface FactoryDiversityReviewResult extends PersonaReviewGateResult {
  strategy: "diversity-of-thought";
  terminal_state: DiversityReviewTerminalState;
  dissent_count: number;
}

export interface PreparedFactoryDiversityReview {
  source: "seed" | "factory-default";
  campaign: Campaign;
  item: WorkItem;
  record: PersonaOrchestrationRecord;
  run(input: {
    implementation_summary: string;
    deterministic_pass: boolean;
    deterministic_summary: string;
  }): Promise<FactoryDiversityReviewResult>;
}

export function failedFactoryDiversityReview(reason: string): FactoryDiversityReviewResult {
  const mode = resolvePersonaOrchestrationMode();
  return {
    strategy: "diversity-of-thought",
    terminal_state: mode === "off" ? "no_review" : mode === "shadow" ? "shadow" : "hold",
    dissent_count: 0,
    mode,
    pass: mode !== "enforce",
    required_count: mode === "off" ? 0 : 1,
    invoked_count: 0,
    reviews: [],
    summary: `diversity review preflight failed: ${reason}`,
    new_cost_usd: 0,
  };
}

const FALLBACK_TEMPLATE = "factory-diversity-review@1.0.0";

function stableSha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultReviewerNames(input: {
  title: string;
  description: string;
  risk_tier: string | null;
}): Array<{ role_id: string; persona_name: string; scopes: string[] }> {
  const text = `${input.title}\n${input.description}`.toLowerCase();
  const selected = [
    { role_id: "zouroboros-review", persona_name: "Zouroboros Engineer", scopes: ["factory", "architecture", "governance"] },
    { role_id: "reality-check", persona_name: "Testing Reality Checker", scopes: ["verification", "tests", "production-reality"] },
  ];
  if (/\b(ai|agent|embedding|inference|llm|model|prompt|rag|retrieval)\b/.test(text)) {
    selected.push({ role_id: "ai-review", persona_name: "AI Engineer", scopes: ["ai-systems", "evals", "model-limitations"] });
  }
  if (input.risk_tier?.toLowerCase() === "high" || /\b(auth|credential|privacy|secret|security|token|vulnerability)\b/.test(text)) {
    selected.push({ role_id: "security-review", persona_name: "Security Engineer", scopes: ["security", "privacy", "abuse-resistance"] });
  }
  return selected;
}

function fallbackAssociation(input: {
  title: string;
  description: string;
  risk_tier: string | null;
}): { association: SeedPersonaAssociation; assignments: TaskPersonaAssignment[] } {
  const reviewers = defaultReviewerNames(input);
  const lineage = stableSha256(JSON.stringify(reviewers));
  const declared: Omit<SeedPersonaAssociation, "content_fingerprint"> = {
    template_reference: FALLBACK_TEMPLATE,
    version: "1.0.0",
    sha256: lineage,
    declared_capabilities: [...new Set(reviewers.flatMap((reviewer) => reviewer.scopes))].sort(),
    selector_values: { platform: "factory" },
    fleet: reviewers.map((reviewer) => ({
      role_id: reviewer.role_id,
      persona_name: reviewer.persona_name,
      required: true,
      phases: ["review"],
      required_scopes: reviewer.scopes,
      invocation_cap: 1,
    })),
    omitted_roles: [],
  };
  return {
    association: { ...declared, content_fingerprint: personaAssociationFingerprint(declared) },
    assignments: reviewers.map((reviewer) => ({ role_id: reviewer.role_id, authority: "review", owned_paths: [] })),
  };
}

/**
 * ZOU-1573: the factory-default reviewer panel, exported so the pool path can
 * populate `persona_association` / `persona_assignments` for campaigns whose
 * intake never declared one. High risk tiers mandate diversity review; without
 * this context the review gate terminates `no_review` after a full build.
 */
export function factoryDefaultPersonaContext(input: {
  title: string;
  description: string;
  risk_tier: string | null;
}): { association: SeedPersonaAssociation; assignments: TaskPersonaAssignment[] } {
  return fallbackAssociation(input);
}

function seedReviewContext(seedPath: string | null): {
  association: SeedPersonaAssociation;
  assignments: TaskPersonaAssignment[];
  description: string;
} | null {
  if (!seedPath) return null;
  const contract = parseSeedContract(seedPath);
  if (!contract.persona_association) return null;
  const assignments = new Map<string, TaskPersonaAssignment>();
  for (const task of contract.tasks) {
    for (const assignment of task.persona_assignments ?? []) {
      if (assignment.authority === "review" && !assignments.has(assignment.role_id)) {
        assignments.set(assignment.role_id, { ...assignment, owned_paths: [...assignment.owned_paths] });
      }
    }
  }
  if (assignments.size === 0) return null;
  return {
    association: contract.persona_association,
    assignments: [...assignments.values()],
    description: contract.tasks.map((task) => `${task.name}: ${task.description}`).join("\n"),
  };
}

function terminalState(result: PersonaReviewGateResult): DiversityReviewTerminalState {
  if (result.mode === "shadow") return "shadow";
  if (result.reviews.length === 0) return "no_review";
  if (!result.pass) return "hold";
  return result.reviews.some((review) => review.verdict === "fail") ? "pass_with_dissent" : "pass";
}

export async function prepareFactoryDiversityReview(input: {
  execution_id: string;
  ticket_id: string;
  identifier: string;
  title: string;
  description: string;
  seed_path: string | null;
  risk_tier: string | null;
  target_repository: string;
  implementer_model_name: string;
  implementer_vendor?: string;
  remaining_cost_usd?: number;
  deps?: PersonaOrchestratorDeps;
}): Promise<PreparedFactoryDiversityReview | null> {
  if ((input.deps?.mode ?? resolvePersonaOrchestrationMode()) === "off") return null;
  const seed = seedReviewContext(input.seed_path);
  const fallback = seed ? null : fallbackAssociation(input);
  const association = seed?.association ?? fallback!.association;
  const assignments = seed?.assignments ?? fallback!.assignments;
  const taskId = `diversity-${input.execution_id}`;
  const campaign: Campaign = {
    campaign_id: `diversity-${input.execution_id}`,
    ticket_id: input.ticket_id,
    identifier: input.identifier,
    seed_path: input.seed_path,
    tasks: [taskId],
    cost_ceiling_usd: input.remaining_cost_usd ?? defaultCostCeiling(),
    cost_spent_usd: 0,
    state: "active",
    created_at: new Date().toISOString(),
    execution_id: input.execution_id,
    risk_tier: input.risk_tier,
    target_repository: input.target_repository,
    persona_association: association,
  };
  const item: WorkItem = {
    campaign_id: campaign.campaign_id,
    task_id: taskId,
    name: input.title,
    description: seed?.description || input.description,
    deps: [],
    state: "ready",
    attempts: 0,
    park_reason: null,
    created_at: campaign.created_at,
    updated_at: campaign.created_at,
    persona_assignments: assignments,
  };
  const preparation = await preparePersonaOrchestration({
    campaign,
    item,
    model_name: input.implementer_model_name,
    model_vendor: input.implementer_vendor,
    main_transport_supports_persona: false,
    remaining_cost_usd: campaign.cost_ceiling_usd,
    deps: input.deps,
  });
  if (!preparation.record) throw new Error("diversity review produced no persona orchestration record");
  const record = preparation.record;
  return {
    source: seed ? "seed" : "factory-default",
    campaign,
    item,
    record,
    run: async (reviewInput) => {
      const result = await runPersonaReviews({
        campaign,
        item,
        record,
        implementation_summary: reviewInput.implementation_summary,
        deterministic_pass: reviewInput.deterministic_pass,
        deterministic_summary: reviewInput.deterministic_summary,
        target_repo: input.target_repository,
        implementer_model_name: input.implementer_model_name,
        implementer_vendor: input.implementer_vendor,
        remaining_cost_usd: campaign.cost_ceiling_usd - campaign.cost_spent_usd,
        deps: input.deps,
      });
      campaign.cost_spent_usd += result.new_cost_usd;
      return {
        ...result,
        strategy: "diversity-of-thought",
        terminal_state: terminalState(result),
        dissent_count: result.reviews.filter((review) => review.verdict === "fail").length,
      };
    },
  };
}
