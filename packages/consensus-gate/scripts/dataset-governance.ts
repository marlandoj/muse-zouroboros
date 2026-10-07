import { createHash } from "node:crypto";

export const DATASET_GOVERNANCE_SCHEMA_VERSION = "1.0.0";
export type CohortName = "train" | "calibration" | "holdout";

export interface GovernedCase {
  id: string;
  source_consensus_id?: string;
  annotated_by?: string;
  annotated_at?: string;
  expected_pass?: boolean;
  [key: string]: unknown;
}

export interface CohortManifest {
  schema_version: typeof DATASET_GOVERNANCE_SCHEMA_VERSION;
  cohort: CohortName;
  version: string;
  immutable: boolean;
  case_count: number;
  case_ids: string[];
  content_sha256: string;
  generated_at: string;
}

export interface ProvenanceEdge {
  source_trace_id: string;
  source_trace_sha256: string;
  annotation_sha256: string;
  cohort: CohortName;
  cohort_sha256: string;
  rubric_sha256: string;
}

export interface GovernanceReport {
  source_trace_count: number;
  annotated_trace_count: number;
  annotation_coverage: number;
  cohort_counts: Record<CohortName, number>;
  oldest_annotation_days: number | null;
  manifests_drifted: CohortName[];
}

export interface GovernanceArtifact {
  schema_version: typeof DATASET_GOVERNANCE_SCHEMA_VERSION;
  generated_at: string;
  manifests: Record<CohortName, CohortManifest>;
  provenance: ProvenanceEdge[];
  report: GovernanceReport;
  rubric: { version: string; content_sha256: string };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

export function buildCohortManifest(
  cohort: CohortName,
  version: string,
  cases: GovernedCase[],
  generatedAt: string,
): CohortManifest {
  const ordered = [...cases].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schema_version: DATASET_GOVERNANCE_SCHEMA_VERSION,
    cohort,
    version,
    immutable: cohort === "holdout",
    case_count: ordered.length,
    case_ids: ordered.map((item) => item.id),
    content_sha256: sha256(ordered),
    generated_at: generatedAt,
  };
}

function ageDays(timestamp: string, nowMs: number): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor((nowMs - parsed) / 86_400_000)) : null;
}

export function buildGovernanceArtifact(input: {
  train: GovernedCase[];
  calibration: GovernedCase[];
  holdout: GovernedCase[];
  versions: Record<CohortName, string>;
  sourceTraceIds: string[];
  rubricVersion: string;
  rubricContent: string;
  generatedAt: string;
  previousManifests?: Partial<Record<CohortName, CohortManifest>>;
}): GovernanceArtifact {
  const manifests = {
    train: buildCohortManifest("train", input.versions.train, input.train, input.generatedAt),
    calibration: buildCohortManifest("calibration", input.versions.calibration, input.calibration, input.generatedAt),
    holdout: buildCohortManifest("holdout", input.versions.holdout, input.holdout, input.generatedAt),
  };
  const cohorts: Array<[CohortName, GovernedCase[]]> = [
    ["train", input.train], ["calibration", input.calibration], ["holdout", input.holdout],
  ];
  const rubricHash = sha256(input.rubricContent);
  const provenance: ProvenanceEdge[] = [];
  const annotationDates: number[] = [];
  for (const [cohort, cases] of cohorts) {
    for (const item of cases) {
      if (!item.source_consensus_id || !item.annotated_by || !item.annotated_at || typeof item.expected_pass !== "boolean") continue;
      const parsed = Date.parse(item.annotated_at);
      if (Number.isFinite(parsed)) annotationDates.push(parsed);
      provenance.push({
        source_trace_id: item.source_consensus_id,
        source_trace_sha256: sha256({ id: item.source_consensus_id }),
        annotation_sha256: sha256({
          source_consensus_id: item.source_consensus_id,
          expected_pass: item.expected_pass,
          annotated_by: item.annotated_by,
          annotated_at: item.annotated_at,
        }),
        cohort,
        cohort_sha256: manifests[cohort].content_sha256,
        rubric_sha256: rubricHash,
      });
    }
  }
  provenance.sort((a, b) => a.source_trace_id.localeCompare(b.source_trace_id));
  const sourceIds = new Set(input.sourceTraceIds);
  const annotated = new Set(provenance.map((edge) => edge.source_trace_id).filter((id) => sourceIds.has(id)));
  const nowMs = Date.parse(input.generatedAt);
  const oldest = annotationDates.length > 0 ? Math.min(...annotationDates) : null;
  const drifted = (Object.keys(manifests) as CohortName[]).filter((cohort) => {
    const previous = input.previousManifests?.[cohort];
    return previous !== undefined && previous.content_sha256 !== manifests[cohort].content_sha256;
  });
  return {
    schema_version: DATASET_GOVERNANCE_SCHEMA_VERSION,
    generated_at: input.generatedAt,
    manifests,
    provenance,
    report: {
      source_trace_count: sourceIds.size,
      annotated_trace_count: annotated.size,
      annotation_coverage: sourceIds.size > 0 ? annotated.size / sourceIds.size : 0,
      cohort_counts: {
        train: input.train.length,
        calibration: input.calibration.length,
        holdout: input.holdout.length,
      },
      oldest_annotation_days: oldest === null ? null : ageDays(new Date(oldest).toISOString(), nowMs),
      manifests_drifted: drifted,
    },
    rubric: { version: input.rubricVersion, content_sha256: rubricHash },
  };
}

export interface RegressionEvidence {
  calibration: { samples: number; baseline_accuracy: number; candidate_accuracy: number };
  holdout: { samples: number; baseline_accuracy: number; candidate_accuracy: number; content_sha256: string };
}

export interface PromotionDecision {
  status: "promoted" | "rejected";
  reviewed_by: string;
  reviewed_at: string;
  reasons: string[];
  rubric_sha256: string;
  manifests: Record<CohortName, string>;
  evidence_sha256: string;
}

export function decideRubricPromotion(input: {
  governance: GovernanceArtifact;
  evidence: RegressionEvidence;
  human: { approved: boolean; reviewed_by: string; reviewed_at: string };
  minimum?: { calibration: number; holdout: number; annotation_coverage: number };
}): PromotionDecision {
  const minimum = input.minimum ?? { calibration: 20, holdout: 3, annotation_coverage: 0.8 };
  const reasons: string[] = [];
  if (!input.human.approved || input.human.reviewed_by.trim() === "") reasons.push("manual human approval missing");
  if (!Number.isFinite(Date.parse(input.human.reviewed_at))) reasons.push("review timestamp invalid");
  if (input.evidence.calibration.samples < minimum.calibration) reasons.push("insufficient calibration evidence");
  if (input.evidence.holdout.samples < minimum.holdout) reasons.push("insufficient holdout evidence");
  if (input.evidence.calibration.samples !== input.governance.manifests.calibration.case_count) reasons.push("calibration sample count mismatch");
  if (input.evidence.holdout.samples !== input.governance.manifests.holdout.case_count) reasons.push("holdout sample count mismatch");
  if (input.governance.report.annotation_coverage < minimum.annotation_coverage) reasons.push("annotation coverage below minimum");
  if (input.evidence.calibration.candidate_accuracy < input.evidence.calibration.baseline_accuracy) reasons.push("calibration regression");
  if (input.evidence.holdout.candidate_accuracy < input.evidence.holdout.baseline_accuracy) reasons.push("holdout regression");
  if (input.evidence.holdout.content_sha256 !== input.governance.manifests.holdout.content_sha256) reasons.push("immutable holdout hash mismatch");
  return {
    status: reasons.length === 0 ? "promoted" : "rejected",
    reviewed_by: input.human.reviewed_by,
    reviewed_at: input.human.reviewed_at,
    reasons,
    rubric_sha256: input.governance.rubric.content_sha256,
    manifests: {
      train: input.governance.manifests.train.content_sha256,
      calibration: input.governance.manifests.calibration.content_sha256,
      holdout: input.governance.manifests.holdout.content_sha256,
    },
    evidence_sha256: sha256(input.evidence),
  };
}
