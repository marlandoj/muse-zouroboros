import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PersonaInvocationEvidence, PersonaOrchestrationRecord } from "./persona-orchestrator";
import type { Assignment } from "./pool-worker";
import type { Campaign, SeedPersonaAssociation, WorkItem } from "./pool-queue";
import {
  assessPersonaShadowQualification,
  persistPersonaShadowQualification,
  readPersonaShadowQualificationLedger,
  readPersonaShadowQualificationStatus,
} from "./persona-shadow-qualification";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function association(reference: string): SeedPersonaAssociation {
  return {
    template_reference: reference,
    version: "1.0.0",
    sha256: "a".repeat(64),
    content_fingerprint: "b".repeat(64),
    declared_capabilities: ["mobile"],
    selector_values: {},
    fleet: [{
      role_id: "specialist",
      persona_name: "Mobile App Builder",
      required: true,
      phases: ["review"],
      required_scopes: ["all"],
      invocation_cap: 1,
    }],
    omitted_roles: [],
  };
}

function campaign(id: string, reference: string): Campaign {
  return {
    campaign_id: id,
    ticket_id: id,
    identifier: id,
    seed_path: `/seeds/${id}.yaml`,
    tasks: [],
    cost_ceiling_usd: 5,
    cost_spent_usd: 0,
    state: "complete",
    created_at: "2026-08-09T00:00:00.000Z",
    persona_association: association(reference),
  };
}

function item(campaignId: string, taskId: string): WorkItem {
  return {
    campaign_id: campaignId,
    task_id: taskId,
    name: taskId,
    description: taskId,
    deps: [],
    state: "done",
    attempts: 1,
    park_reason: null,
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T01:00:00.000Z",
    persona_assignments: [{ role_id: "specialist", authority: "review", owned_paths: [] }],
    owned_files: [],
  };
}

function invocation(status: PersonaInvocationEvidence["status"] = "would_invoke"): PersonaInvocationEvidence {
  return {
    role_id: "specialist",
    phase: "review",
    required: true,
    status,
    selector: "Mobile App Builder",
    persona_id: "persona-mobile",
    persona_name: "Mobile App Builder",
    scopes: ["all"],
    owned_paths: [],
    association_version: "1.0.0",
    association_sha256: "a".repeat(64),
    directory_snapshot_hash: "c".repeat(64),
    model_name: "review-model",
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
  };
}

function record(campaignId: string, taskId: string, reference: string, status: PersonaInvocationEvidence["status"] = "would_invoke"): PersonaOrchestrationRecord {
  return {
    version: 1,
    campaign_id: campaignId,
    task_id: taskId,
    mode: "shadow",
    association: {
      template_reference: reference,
      version: "1.0.0",
      sha256: "a".repeat(64),
      content_fingerprint: "b".repeat(64),
    },
    directory: { snapshot_hash: "c".repeat(64), captured_at: "2026-08-09T00:00:00.000Z" },
    invocations: [invocation(status)],
    omitted_roles: [],
    blocked_reason: null,
    total_cost_usd: 0,
    created_at: "2026-08-09T00:00:00.000Z",
    updated_at: "2026-08-09T01:00:00.000Z",
  };
}

function assignment(campaignId: string, taskId: string, reference: string, status: PersonaInvocationEvidence["status"] = "would_invoke"): Assignment {
  return {
    assignment_id: `asg-${campaignId}-${taskId}`,
    campaign_id: campaignId,
    task_id: taskId,
    model: "implementer",
    attempt: 1,
    started_at: "2026-08-09T00:00:00.000Z",
    heartbeat_path: "/tmp/heartbeat",
    result_path: "/tmp/result",
    timeout_min: 30,
    completed_at: "2026-08-09T01:00:00.000Z",
    outcome: "success",
    mock: false,
    persona_orchestration: record(campaignId, taskId, reference, status),
  };
}

describe("persona shadow qualification", () => {
  test("distinguishes zero traffic from a dormant but configured feature", () => {
    const snapshot = assessPersonaShadowQualification({ mode: "shadow", campaigns: {}, queue: [], assignments: [], now: "2026-08-12T00:00:00.000Z" });
    expect(snapshot.state).toBe("collecting");
    expect(snapshot.reasons).toContain("no_campaign_traffic");
    expect(snapshot.reasons).toContain("qualified_task_threshold_not_met");
    expect(snapshot.safety).toMatchObject({ zero_persona_calls: true, zero_persona_spend: true });
  });

  test("requires five distinct tasks, two template categories, 48 hours, and zero calls or spend", () => {
    const campaigns = {
      mobile: campaign("mobile", "web-app@1.0.0"),
      api: campaign("api", "api-service@1.0.0"),
    };
    const queue = [
      item("mobile", "T1"), item("mobile", "T2"), item("mobile", "T3"),
      item("api", "T1"), item("api", "T2"),
    ];
    const assignments = queue.map((entry) => assignment(
      entry.campaign_id,
      entry.task_id,
      campaigns[entry.campaign_id as keyof typeof campaigns].persona_association!.template_reference,
    ));
    const snapshot = assessPersonaShadowQualification({
      mode: "shadow",
      campaigns,
      queue,
      assignments,
      now: "2026-08-12T00:00:00.000Z",
    });
    expect(snapshot.state).toBe("ready");
    expect(snapshot.ready_for_enforcement_review).toBe(true);
    expect(snapshot.reasons).toEqual([]);
    expect(snapshot.traffic.qualified_distinct_tasks).toBe(5);
    expect(snapshot.traffic.qualified_template_categories).toEqual(["api-service", "web-app"]);
    expect(snapshot.traffic.observation_window_hours).toBe(72);
  });

  test("blocks readiness when any shadow receipt records a real persona call", () => {
    const c = campaign("mobile", "web-app@1.0.0");
    const i = item("mobile", "T1");
    const a = assignment("mobile", "T1", "web-app@1.0.0", "invoked");
    a.persona_orchestration!.invocations[0] = {
      ...a.persona_orchestration!.invocations[0],
      requested_at: "2026-08-09T00:00:00.000Z",
      completed_at: "2026-08-09T00:00:01.000Z",
      resolved_model_name: "review-model",
      result_ref: "/tmp/result",
      result_sha256: `sha256:${"d".repeat(64)}`,
      artifact_ref: "/tmp/artifact",
      artifact_sha256: `sha256:${"e".repeat(64)}`,
      verdict: "pass",
      cost_usd: 0.01,
    };
    a.persona_orchestration!.total_cost_usd = 0.01;
    const snapshot = assessPersonaShadowQualification({
      mode: "shadow",
      campaigns: { mobile: c },
      queue: [i],
      assignments: [a],
      now: "2026-08-12T00:00:00.000Z",
    });
    expect(snapshot.state).toBe("blocked");
    expect(snapshot.reasons).toContain("unsafe_shadow_receipts");
    expect(snapshot.safety.zero_persona_calls).toBe(false);
    expect(snapshot.safety.zero_persona_spend).toBe(false);
  });

  test("does not reuse a stale receipt when the latest task attempt has no persona evidence", () => {
    const c = campaign("mobile", "web-app@1.0.0");
    const i = item("mobile", "T1");
    const prior = assignment("mobile", "T1", "web-app@1.0.0");
    const latest: Assignment = {
      ...prior,
      assignment_id: "asg-mobile-T1-retry",
      attempt: 2,
      started_at: "2026-08-10T00:00:00.000Z",
      completed_at: null,
      persona_orchestration: undefined,
    };
    const snapshot = assessPersonaShadowQualification({
      mode: "shadow",
      campaigns: { mobile: c },
      queue: [i],
      assignments: [prior, latest],
      now: "2026-08-12T00:00:00.000Z",
    });
    expect(snapshot.traffic.persona_receipts).toBe(0);
    expect(snapshot.reasons).toContain("no_persona_receipts");
  });

  test("persists an atomic latest status and validates the append-only hash chain", () => {
    const root = mkdtempSync(join(tmpdir(), "persona-shadow-qualification-"));
    roots.push(root);
    const ledger = join(root, "observations.jsonl");
    const status = join(root, "status.json");
    const snapshot = assessPersonaShadowQualification({ mode: "shadow", campaigns: {}, queue: [], assignments: [], now: "2026-08-12T00:00:00.000Z" });
    const first = persistPersonaShadowQualification(snapshot, "test-cycle-1", { ledger, status });
    const second = persistPersonaShadowQualification({ ...snapshot, observed_at: "2026-08-12T00:30:00.000Z" }, "test-cycle-2", { ledger, status });
    expect(second.sequence).toBe(2);
    expect(second.previous_hash).toBe(first.observation_hash);
    expect(readPersonaShadowQualificationLedger(ledger)).toHaveLength(2);
    expect(readPersonaShadowQualificationStatus(status, ledger).observation_hash).toBe(second.observation_hash);
    writeFileSync(status, `${JSON.stringify(first)}\n`);
    expect(() => readPersonaShadowQualificationStatus(status, ledger)).toThrow("does not match");
    writeFileSync(status, `${JSON.stringify(second)}\n`);
    const tampered = readFileSync(ledger, "utf8").replace("test-cycle-1", "tampered-cycle");
    writeFileSync(ledger, tampered);
    expect(() => readPersonaShadowQualificationLedger(ledger)).toThrow("hash is invalid");
  });
});
