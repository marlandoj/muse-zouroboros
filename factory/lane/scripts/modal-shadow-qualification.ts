import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_ROUTING_POLICY,
  type ProviderAdapter,
  type RoutingDecision,
} from "../../../packages/core/src/compute";
import { createComputeDispatcher } from "../../../packages/swarm/src/compute/dispatcher";
import type { ComputeIntent, Task } from "../../../packages/swarm/src/types";
import { executionLaneForTicket } from "./execution-lane";

interface ExpectedDecision {
  action: RoutingDecision["action"];
  provider: RoutingDecision["provider"];
  holdReason?: RoutingDecision["holdReason"];
}

interface QualificationFixture {
  id: string;
  workloadClass: string;
  title: string;
  description: string;
  intent: ComputeIntent;
  expected: ExpectedDecision;
}

export interface ShadowDecisionRow {
  fixtureId: string;
  surface: "factory" | "swarm";
  workloadClass: string;
  action: RoutingDecision["action"] | "missing";
  provider: RoutingDecision["provider"] | "missing";
  holdReason: RoutingDecision["holdReason"] | null;
  expected: ExpectedDecision;
  agreement: boolean;
  noDispatch: boolean;
}

export interface ShadowQualificationReport {
  schemaVersion: 1;
  generatedAt: string;
  fixtureCount: number;
  decisionCount: number;
  workloadClasses: string[];
  agreementCount: number;
  agreementRate: number;
  adapterCalls: number;
  providerSpendUsd: 0;
  noDispatch: boolean;
  passed: boolean;
  rows: ShadowDecisionRow[];
}

const FACTORY_ENV = {
  SF003_POOL: "1",
  SF_HETZNER_EXECUTOR: "1",
  FACTORY_COMPUTE_ROUTER: "shadow",
  FACTORY_COMPUTE_ENVIRONMENT: "qualification",
  FACTORY_COMPUTE_ENVIRONMENT_ENABLED: "1",
  FACTORY_COMPUTE_LOCAL: "1",
  FACTORY_COMPUTE_MODAL: "1",
  FACTORY_COMPUTE_HETZNER: "1",
  FACTORY_COMPUTE_WORKLOADS: "deterministic-verification,embedding-batch,gpu-compute,agent-session",
  FACTORY_COMPUTE_LOCAL_MAX_USD: "1",
  FACTORY_COMPUTE_MODAL_MAX_USD: "1",
  FACTORY_COMPUTE_HETZNER_MAX_USD: "1",
  FACTORY_COMPUTE_ESTIMATE_USD: "0.1",
  FACTORY_COMPUTE_APPROVAL_ID: "shadow-qualification-2026-08-11",
};

const SWARM_POLICY = {
  ...DEFAULT_ROUTING_POLICY,
  policyVersion: "swarm-shadow-qualification-v1",
  enabled: true,
  mode: "shadow" as const,
  environment: "qualification",
  environmentEnabled: { qualification: true },
  providerEnabled: { local: true, modal: true, hetzner: true },
  workloadClassEnabled: {
    "deterministic-verification": true,
    "embedding-batch": true,
    "gpu-compute": true,
    "agent-session": true,
  },
  maxCostUsdByProvider: { local: 1, modal: 1, hetzner: 1 },
};

function intent(overrides: Partial<ComputeIntent>): ComputeIntent {
  return {
    nodeKind: "verification",
    provider: "modal",
    workloadClass: "deterministic-verification",
    environment: "qualification",
    approvalId: "shadow-qualification-2026-08-11",
    classification: "public",
    costEstimateUsd: 0.1,
    canonicalWrites: false,
    externalMutations: false,
    idempotent: true,
    inputManifest: [],
    outputLimits: { maxArtifacts: 2, maxBytes: 1024 },
    callback: { callbackId: "shadow-callback", nonce: "shadow-nonce", expiresAt: "2026-08-12T00:00:00Z" },
    cleanup: { required: true, deadlineAt: "2026-08-12T00:10:00Z" },
    idempotencyKey: "shadow-idempotency",
    maxRuntimeMs: 60_000,
    maxAttempts: 1,
    maxCostUsd: 1,
    ...overrides,
  };
}

function fixtures(): QualificationFixture[] {
  const templates: Omit<QualificationFixture, "id">[] = [
    {
      workloadClass: "deterministic-verification",
      title: "Public deterministic fixture verification",
      description: "Run public fixture test shards with Modal batch compute.",
      intent: intent({}),
      expected: { action: "shadow", provider: "modal" },
    },
    {
      workloadClass: "embedding-batch",
      title: "Public embedding batch",
      description: "Generate embeddings for an open-source public corpus in batch shards.",
      intent: intent({ nodeKind: "compute", workloadClass: "embedding-batch" }),
      expected: { action: "shadow", provider: "modal" },
    },
    {
      workloadClass: "deterministic-verification",
      title: "Internal local verification",
      description: "Run a test on internal source code in the existing local environment.",
      intent: intent({ provider: "local", classification: "internal", costEstimateUsd: 0 }),
      expected: { action: "shadow", provider: "local" },
    },
    {
      workloadClass: "gpu-compute",
      title: "Sensitive GPU evaluation",
      description: "Run a GPU evaluation over credential-bearing internal records.",
      intent: intent({ workloadClass: "gpu-compute", classification: "sensitive" }),
      expected: { action: "hold", provider: "hold", holdReason: "sensitive_data" },
    },
    {
      workloadClass: "agent-session",
      title: "Canonical change",
      description: "Commit and merge a GitHub change and update Linear.",
      intent: intent({
        provider: "local",
        workloadClass: "agent-session",
        classification: "internal",
        canonicalWrites: true,
        externalMutations: true,
        idempotent: false,
        costEstimateUsd: 0,
      }),
      expected: { action: "hold", provider: "hold", holdReason: "unauthorized_mutation" },
    },
    {
      workloadClass: "deterministic-verification",
      title: "Bounded Hetzner verification",
      description: "Hetzner is to be used for a long-running verification benchmark.",
      intent: intent({ provider: "hetzner", classification: "internal" }),
      expected: { action: "shadow", provider: "hetzner" },
    },
  ];
  return templates.flatMap((template, templateIndex) =>
    Array.from({ length: 10 }, (_, sampleIndex) => ({
      ...template,
      id: `wc-${templateIndex + 1}-${String(sampleIndex + 1).padStart(2, "0")}`,
      title: `${template.title} ${sampleIndex + 1}`,
      intent: {
        ...template.intent,
        callback: template.intent.callback
          ? { ...template.intent.callback, callbackId: `${template.intent.callback.callbackId}-${templateIndex + 1}-${sampleIndex + 1}` }
          : undefined,
        idempotencyKey: `${template.intent.idempotencyKey}-${templateIndex + 1}-${sampleIndex + 1}`,
      },
    })),
  );
}

function row(
  fixture: QualificationFixture,
  surface: ShadowDecisionRow["surface"],
  decision: RoutingDecision | undefined,
  noDispatch: boolean,
): ShadowDecisionRow {
  const agreement = Boolean(
    decision
    && decision.action === fixture.expected.action
    && decision.provider === fixture.expected.provider
    && (fixture.expected.holdReason === undefined || decision.holdReason === fixture.expected.holdReason),
  );
  return {
    fixtureId: fixture.id,
    surface,
    workloadClass: fixture.workloadClass,
    action: decision?.action ?? "missing",
    provider: decision?.provider ?? "missing",
    holdReason: decision?.holdReason ?? null,
    expected: fixture.expected,
    agreement,
    noDispatch,
  };
}

export async function runShadowQualification(now = new Date("2026-08-11T17:30:00Z")): Promise<ShadowQualificationReport> {
  let adapterCalls = 0;
  const blockedAdapter = (provider: "local" | "modal" | "hetzner"): ProviderAdapter => ({
    provider,
    async execute() {
      adapterCalls++;
      throw new Error("shadow qualification must never invoke an adapter");
    },
    async cancel() {},
  });
  const dispatcher = createComputeDispatcher({
    policy: SWARM_POLICY,
    adapters: new Map([
      ["local", blockedAdapter("local")],
      ["modal", blockedAdapter("modal")],
      ["hetzner", blockedAdapter("hetzner")],
    ]),
  });
  const rows: ShadowDecisionRow[] = [];
  const allFixtures = fixtures();
  for (const fixture of allFixtures) {
    const lane = executionLaneForTicket({
      identifier: fixture.id,
      title: fixture.title,
      description: fixture.description,
    }, "DIRECT", FACTORY_ENV);
    rows.push(row(fixture, "factory", lane.compute_shadow?.proposed, lane.compute_shadow?.no_dispatch === true));

    const task: Task = {
      id: fixture.id,
      persona: "shadow-qualification",
      task: fixture.description,
      priority: "medium",
      compute: fixture.intent,
    };
    const result = await dispatcher.dispatch(task);
    rows.push(row(fixture, "swarm", result.computeDecision, result.computeDecision?.action !== "dispatch"));
  }
  const agreementCount = rows.filter((entry) => entry.agreement).length;
  const noDispatch = rows.every((entry) => entry.noDispatch) && adapterCalls === 0;
  return {
    schemaVersion: 1,
    generatedAt: now.toISOString(),
    fixtureCount: allFixtures.length,
    decisionCount: rows.length,
    workloadClasses: [...new Set(allFixtures.map((fixture) => fixture.workloadClass))].sort(),
    agreementCount,
    agreementRate: agreementCount / rows.length,
    adapterCalls,
    providerSpendUsd: 0,
    noDispatch,
    passed: rows.length >= 50 && agreementCount === rows.length && noDispatch,
    rows,
  };
}

function renderReport(report: ShadowQualificationReport): string {
  const byClass = report.workloadClasses.map((workloadClass) => {
    const rows = report.rows.filter((entry) => entry.workloadClass === workloadClass);
    const agreement = rows.filter((entry) => entry.agreement).length;
    return `| ${workloadClass} | ${rows.length} | ${agreement}/${rows.length} |`;
  });
  return [
    "# Modal Shadow Qualification - 2026-08-11",
    "",
    `**Result:** ${report.passed ? "PASS" : "FAIL"}`,
    "",
    "| Metric | Result |",
    "|---|---:|",
    `| Fixtures | ${report.fixtureCount} |`,
    `| Factory + Swarm decisions | ${report.decisionCount} |`,
    `| Expected-label agreement | ${report.agreementCount}/${report.decisionCount} (${(report.agreementRate * 100).toFixed(1)}%) |`,
    `| Adapter calls | ${report.adapterCalls} |`,
    `| Provider spend | $${report.providerSpendUsd.toFixed(2)} |`,
    `| No-dispatch proof | ${report.noDispatch ? "PASS" : "FAIL"} |`,
    "",
    "## Workload Coverage",
    "",
    "| Workload class | Decisions | Agreement |",
    "|---|---:|---:|",
    ...byClass,
    "",
    "Factory decisions were computed beside the incumbent lane without changing it. Swarm decisions used the compute dispatcher with adapters that increment a call counter and fail if invoked; the final counter remained zero.",
    "",
  ].join("\n");
}

export function writeShadowQualification(report: ShadowQualificationReport, outputDir: string): { jsonPath: string; markdownPath: string } {
  const directory = resolve(outputDir);
  mkdirSync(directory, { recursive: true });
  const jsonPath = join(directory, "modal-shadow-qualification-2026-08-11.json");
  const markdownPath = join(directory, "modal-shadow-qualification-2026-08-11.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, renderReport(report));
  return { jsonPath, markdownPath };
}

if (import.meta.main) {
  const outputArg = process.argv.indexOf("--output-dir");
  const outputDir = outputArg >= 0 ? process.argv[outputArg + 1] : undefined;
  if (!outputDir) throw new Error("Usage: bun modal-shadow-qualification.ts --output-dir <directory>");
  const report = await runShadowQualification();
  const paths = writeShadowQualification(report, outputDir);
  process.stdout.write(`${JSON.stringify({ ...paths, passed: report.passed, decisions: report.decisionCount, adapterCalls: report.adapterCalls })}\n`);
  if (!report.passed) process.exitCode = 1;
}
