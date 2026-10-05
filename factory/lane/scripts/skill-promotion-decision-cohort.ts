import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { EvaluationTaskClass, Sha256Digest, SkillLifecycleRecord } from "../../../Skills/skill-security-gate/scripts/lifecycle/types.ts";
import { buildPortableHarnessInventory } from "../../../packages/swarm/src/executor/portability.ts";
import { actorSha256, parseActorSystemManifest } from "./actor-system-twin.ts";
import { buildSyntheticScenarioSourceQualification } from "./scenario-source-comparison-cohort.ts";
import { evaluateScenarioSourceComparison } from "./scenario-source-comparison-runner.ts";
import { buildSyntheticOutputTrajectoryQualification } from "./output-trajectory-comparison-cohort.ts";
import { evaluateOutputTrajectoryComparison } from "./output-trajectory-comparison-runner.ts";
import { buildSyntheticSilentSuccessQualification } from "./silent-success-comparison-cohort.ts";
import { evaluateSilentSuccessComparison } from "./silent-success-comparison-runner.ts";
import { buildSyntheticHarnessPortabilityQualification } from "./harness-portability-comparison-cohort.ts";
import { evaluateHarnessPortabilityComparison } from "./harness-portability-comparison-runner.ts";
import {
  COMPATIBILITY_INVENTORY,
  PREDECESSOR_SCHEMAS,
  PRIMARY_METRICS,
  SKILL_PROMOTION_OBSERVATION,
  SKILL_PROMOTION_PAIR,
  SKILL_PROMOTION_PROTOCOL,
  VERSION_ARMS,
  canonicalizePromotion,
  finalizeObservation,
  finalizePair,
  finalizeProtocol,
  promotionSha256,
  type PredecessorBundle,
  type PromotionMetricValues,
  type SkillPromotionObservation,
  type SkillPromotionPair,
  type SkillPromotionProtocol,
  type VersionArm,
} from "./skill-promotion-decision-contract.ts";

export interface SyntheticSkillPromotionQualification {
  protocol: SkillPromotionProtocol;
  observations: SkillPromotionObservation[];
  approved_lifecycle: SkillLifecycleRecord;
  candidate_lifecycle: SkillLifecycleRecord;
  predecessors: PredecessorBundle;
  signature: null;
  uses_live_models_harnesses_or_receipts: false;
  claim_eligible: false;
}

function digest(value: unknown): Sha256Digest {
  return `sha256:${promotionSha256(value)}` as Sha256Digest;
}

function lifecycleSubject(identity: SkillLifecycleRecord["identity"]): Sha256Digest {
  const sorted = (values: string[]) => [...values].sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
  const normalized = {
    ...identity,
    capabilities: {
      tools: sorted(identity.capabilities.tools),
      filesystem: {
        read: sorted(identity.capabilities.filesystem.read),
        write: sorted(identity.capabilities.filesystem.write),
      },
      process: {
        spawn: identity.capabilities.process.spawn,
        commands: sorted(identity.capabilities.process.commands),
      },
      network: {
        hosts: sorted(identity.capabilities.network.hosts),
        protocols: sorted(identity.capabilities.network.protocols),
      },
    },
    credentials: [...identity.credentials].sort((left, right) => `${left.class}\0${left.envName}`.localeCompare(`${right.class}\0${right.envName}`)),
    dependencies: [...identity.dependencies].sort((left, right) => `${left.manager}\0${left.name}\0${left.versionOrRevision}`.localeCompare(`${right.manager}\0${right.name}\0${right.versionOrRevision}`)),
  };
  return digest({ schemaVersion: 1, identity: normalized });
}

function taskClassHash(task: EvaluationTaskClass): Sha256Digest {
  return digest({ ...task, fixtureHashes: [...task.fixtureHashes].sort() });
}

function lifecycleRecord(version: string): SkillLifecycleRecord {
  const identity: SkillLifecycleRecord["identity"] = {
    slug: "synthetic-governed-skill",
    version,
    source: {
      kind: "generated",
      canonicalUri: `https://example.invalid/synthetic-governed-skill/${version}`,
      immutableRevision: promotionSha256({ version, revision: "synthetic" }),
      signature: {
        scheme: "sha256",
        signer: "synthetic-qualification",
        signatureHash: digest({ version, signature: "synthetic" }),
      },
    },
    contentHash: digest({ version, content: "synthetic-redacted" }),
    dependencyManifestHash: digest([]),
    capabilities: {
      tools: ["Read"],
      filesystem: { read: ["workspace"], write: [] },
      process: { spawn: false, commands: [] },
      network: { hosts: [], protocols: [] },
    },
    credentials: [],
    dependencies: [],
  };
  const subjectHash = lifecycleSubject(identity);
  const task: EvaluationTaskClass = {
    name: "phase-d-compatibility",
    version: "1.0.0",
    required: true,
    inputContractHash: digest("phase-d-input-contract-v1"),
    outputContractHash: digest("phase-d-output-contract-v1"),
    verifierContractHash: digest("phase-d-verifier-contract-v1"),
    fixtureHashes: [digest("redacted-synthetic-fixture-v1")],
    minimumScore: 0.8,
  };
  const contractHash = digest([task]);
  const issuedAt = "2026-08-20T12:00:00.000Z";
  const validUntil = "2027-08-20T12:00:00.000Z";
  return {
    schemaVersion: 1,
    subjectHash,
    identity,
    state: version === "1.0.0" ? "promoted" : "approved",
    security: {
      deterministic: ["skillspector", "supply-chain"].map((kind, index) => ({
        kind: kind as "skillspector" | "supply-chain",
        subjectHash,
        verdict: "pass" as const,
        reportHash: digest({ version, kind, index }),
        gateVersion: `${kind}@1.0.0`,
        policyVersion: "skill-security-policy@1",
        issuedAt,
        validUntil,
      })),
      modelBased: [{
        kind: "external-model-security",
        subjectHash,
        provider: "synthetic-provider",
        model: "synthetic-security-reviewer",
        modelRevision: "2026-08-20",
        promptVersion: "security-review@1",
        policyVersion: "model-security-policy@1",
        verdict: "pass",
        findings: [],
        reportHash: digest({ version, review: "external-model-security" }),
        issuedAt,
        validUntil,
      }],
      humanOverrides: [],
    },
    evaluation: {
      contractHash,
      taskClasses: [task],
      compatibility: COMPATIBILITY_INVENTORY.map((harness, index) => ({
        taskClass: task.name,
        taskClassVersion: task.version,
        subjectHash,
        contractHash: taskClassHash(task),
        model: { provider: "synthetic-provider", id: "synthetic-model", revision: "2026-08-20" },
        harness: { name: harness, version: "1.0.0", configHash: digest({ harness, config: 1 }) },
        seed: `synthetic-${index + 1}`,
        passed: true,
        score: 0.95,
        threshold: task.minimumScore,
        cost: { amount: 0, currency: "USD" },
        latencyMs: 0,
        receiptHash: digest({ version, harness, receipt: "synthetic" }),
        failure: null,
        contamination: { checked: true, detected: false, evidenceHash: digest({ version, harness, contamination: "clear" }) },
      })),
      parity: {
        subjectHash,
        evaluationContractHash: contractHash,
        productionContractHash: contractHash,
        evaluationAdapterContractHash: contractHash,
        verifierContractHash: digest([task.verifierContractHash]),
        verdict: "pass",
        evidenceHash: digest({ version, parity: "synthetic" }),
        verifiedAt: "2026-08-20T13:00:00.000Z",
      },
    },
  };
}

function predecessorBundle(manifestPath: string): PredecessorBundle {
  const scenario = buildSyntheticScenarioSourceQualification(manifestPath);
  const output = buildSyntheticOutputTrajectoryQualification(manifestPath);
  const silent = buildSyntheticSilentSuccessQualification(manifestPath);
  const harness = buildSyntheticHarnessPortabilityQualification(manifestPath);
  const inventory = buildPortableHarnessInventory();
  return {
    scenario_source_summary: evaluateScenarioSourceComparison(scenario.protocol, scenario.observations),
    output_trajectory_summary: evaluateOutputTrajectoryComparison(output.protocol, output.observations),
    silent_success_summary: evaluateSilentSuccessComparison(silent.protocol, silent.observations),
    harness_portability_protocol: harness.protocol,
    harness_portability_summary: evaluateHarnessPortabilityComparison(harness.protocol, harness.pairs, harness.observations, harness.capability_cells, inventory),
    production_inventory: inventory,
  };
}

function metricValues(pair: SkillPromotionPair, arm: VersionArm): PromotionMetricValues {
  const unit = Number.parseInt(promotionSha256({ pair: pair.pair_id }).slice(0, 6), 16) / 0xffffff;
  const candidate = arm === "candidate";
  return {
    verified_quality: Number((0.82 + unit * 0.02 + (candidate ? 0.05 : 0)).toFixed(6)),
    contract_conformance: Number((0.86 + unit * 0.02 + (candidate ? 0.04 : 0)).toFixed(6)),
    failure_rate: Number((0.10 + unit * 0.01 - (candidate ? 0.04 : 0)).toFixed(6)),
    recovery_rate: Number((0.78 + unit * 0.02 + (candidate ? 0.06 : 0)).toFixed(6)),
    latency_ms: Number((1000 + unit * 20 - (candidate ? 40 : 0)).toFixed(6)),
    cost_usd: Number((0.5 + unit * 0.01 - (candidate ? 0.03 : 0)).toFixed(6)),
    edge_proof_completeness: Number((0.80 + unit * 0.02 + (candidate ? 0.05 : 0)).toFixed(6)),
    contamination_rate: 0,
  };
}

export function buildSyntheticSkillPromotionQualification(manifestPath: string): SyntheticSkillPromotionQualification {
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseActorSystemManifest(JSON.parse(manifestBytes.toString("utf8")));
  const contracts = [...manifest.contracts].sort((left, right) => left.id.localeCompare(right.id)).slice(0, 10);
  const seeds = [...manifest.replicateSeeds].sort((left, right) => left - right);
  if (contracts.length !== 10 || seeds.length !== 3) throw new Error("synthetic qualification requires ten contracts and three registered seeds");
  const approvedLifecycle = lifecycleRecord("1.0.0");
  const candidateLifecycle = lifecycleRecord("1.1.0");
  const protocolId = "zou-1067-synthetic-skill-promotion-v1";
  const pairs = contracts.flatMap((contract) => seeds.map((seed) => {
    const taskHash = actorSha256(contract);
    return finalizePair({
      schema: SKILL_PROMOTION_PAIR,
      protocol_id: protocolId,
      pair_id: `${contract.id}:${seed}`,
      skill_slug: approvedLifecycle.identity.slug,
      approved_version: approvedLifecycle.identity.version,
      approved_subject_sha256: approvedLifecycle.subjectHash,
      candidate_version: candidateLifecycle.identity.version,
      candidate_subject_sha256: candidateLifecycle.subjectHash,
      task_id: contract.id,
      task_class: contract.actorKind,
      seed,
      input_contract_sha256: taskHash,
      output_contract_sha256: promotionSha256({ contract: contract.id, expected: contract.expectedTerminal }),
      verifier_contract_sha256: promotionSha256({ task_class: contract.actorKind, expected: contract.expectedTerminal, recovery: contract.recovery }),
      authority_envelope_sha256: promotionSha256({ manifest: createHash("sha256").update(manifestBytes).digest("hex"), task: taskHash, review: manifest.reviewBinding }),
    });
  }));
  const protocol = finalizeProtocol({
    schema: SKILL_PROMOTION_PROTOCOL,
    protocol_id: protocolId,
    evidence_class: "synthetic_qualification",
    evaluation_time: "2026-08-20T14:00:00.000Z",
    skill_slug: approvedLifecycle.identity.slug,
    approved_version: approvedLifecycle.identity.version,
    approved_subject_sha256: approvedLifecycle.subjectHash,
    candidate_version: candidateLifecycle.identity.version,
    candidate_subject_sha256: candidateLifecycle.subjectHash,
    planned_pairs: 30,
    required_observations: 60,
    version_arms: [...VERSION_ARMS],
    compatibility_inventory: [...COMPATIBILITY_INVENTORY],
    required_predecessor_schemas: [...PREDECESSOR_SCHEMAS],
    primary_metrics: [...PRIMARY_METRICS],
    confidence_level: 0.95,
    interval_method: "paired-normal-95",
    maximum_latency_ratio: 1.10,
    maximum_cost_ratio: 1.10,
    advisory_only: true,
    production_promotion_mutations: 0,
    production_routing_mutations: 0,
    budget: {
      maximum_runs: 110,
      required_runs: 60,
      maximum_cost_usd: 93.5,
      maximum_tokens: 12_100_000,
      maximum_compute_hours: 24.2,
      maximum_storage_gib: 1.54,
      per_run_timeout_minutes: 30,
    },
    pairs,
  });
  const observations = pairs.flatMap((pair, pairIndex) => VERSION_ARMS.map((arm, armIndex) => {
    const subjectHash = arm === "last-approved" ? approvedLifecycle.subjectHash : candidateLifecycle.subjectHash;
    const harness = COMPATIBILITY_INVENTORY[(pairIndex + armIndex) % COMPATIBILITY_INVENTORY.length]!;
    return finalizeObservation({
      schema: SKILL_PROMOTION_OBSERVATION,
      observation_id: `obs-${promotionSha256({ pair: pair.pair_id, arm }).slice(0, 24)}`,
      protocol_id: protocol.protocol_id,
      pair_id: pair.pair_id,
      arm,
      skill_subject_sha256: subjectHash,
      model_id: "synthetic-provider:synthetic-model",
      model_revision: "2026-08-20",
      harness_id: harness,
      harness_version: "1.0.0",
      harness_config_sha256: promotionSha256({ harness, config: 1 }),
      task_contract_sha256: pair.input_contract_sha256,
      output_sha256: promotionSha256({ pair: pair.pair_id, arm, output: "redacted" }),
      receipt_sha256: promotionSha256({ pair: pair.pair_id, arm, receipt: "synthetic" }),
      verifier_report_sha256: promotionSha256({ pair: pair.pair_id, arm, verifier: "synthetic" }),
      authority_valid: true,
      receipt_valid: true,
      verifier_valid: true,
      production_parity_valid: true,
      rollback_valid: true,
      constitutional_failure: false,
      contamination_detected: false,
      unresolved_critical_objection: false,
      metrics: metricValues(pair, arm),
    });
  }));
  const result: SyntheticSkillPromotionQualification = {
    protocol,
    observations,
    approved_lifecycle: approvedLifecycle,
    candidate_lifecycle: candidateLifecycle,
    predecessors: predecessorBundle(manifestPath),
    signature: null,
    uses_live_models_harnesses_or_receipts: false,
    claim_eligible: false,
  };
  const serialized = canonicalizePromotion(result);
  if (["raw_task_input", "raw_output", "raw_receipt", "raw_verifier_report", "holdout_plaintext", "hidden_answer", "golden_patch", "fixture_path", "credential", "secret"].some((field) => serialized.includes(`\"${field}\"`))) throw new Error("synthetic qualification crossed the retention boundary");
  return result;
}
