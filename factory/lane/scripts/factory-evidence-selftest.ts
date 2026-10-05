import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEvidenceManifest,
  independentReviewers,
  readEvidenceManifest,
  rolloutMode,
  promotionBlockers,
  validateEvidenceManifest,
  writeEvidenceManifest,
  type AgentIdentity,
} from "./factory-evidence";
import type { PersonaInvocationEvidence, PersonaOrchestrationRecord } from "./persona-orchestrator";
import { parseVerdict } from "./factory-verdict";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
}

const author: AgentIdentity = { provider: "openai", model: "codex" };
const reviewer: AgentIdentity = { provider: "anthropic", model: "claude" };
const commitDigest = `sha256:${"a".repeat(64)}`;
const reviewers = independentReviewers(author, [author, reviewer, reviewer]);
check("author excluded and reviewers deduplicated", reviewers.length === 1 && reviewers[0].model === "claude");
check("legacy ticket remains advisory", rolloutMode({ labels: [] }) === "advisory");
check("evidence-v1 ticket blocks", rolloutMode({ labels: ["evidence-v1"] }) === "blocking");

const dir = mkdtempSync(join(tmpdir(), "factory-evidence-"));
const reviewPath = join(dir, "review.json");
const tracePath = join(dir, "trace.json");
const featurePath = join(dir, "feature.json");
const testPath = join(dir, "test.json");
const attestationPath = join(dir, "attestation.json");
writeFileSync(reviewPath, JSON.stringify({ execution_id: "exec-test", verdict: "pass", author, reviewer }));
writeFileSync(tracePath, JSON.stringify({ execution_id: "exec-test", status: "pass" }));
writeFileSync(featurePath, JSON.stringify({ execution_id: "exec-test", status: "pass" }));
writeFileSync(testPath, JSON.stringify({ execution_id: "exec-test", status: "pass" }));
writeFileSync(attestationPath, JSON.stringify({ execution_id: "exec-test", status: "pass" }));
const hash = (path: string) => `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;

const personaReview: PersonaInvocationEvidence = {
  role_id: "game-designer",
  phase: "review",
  required: true,
  status: "invoked",
  selector: "GameDev · Game Designer",
  persona_id: "persona-1",
  persona_name: "GameDev · Game Designer",
  scopes: ["all"],
  owned_paths: [],
  association_version: "1.0.0",
  association_sha256: "a".repeat(64),
  directory_snapshot_hash: "b".repeat(64),
  model_name: "byok:test",
  resolved_model_name: "byok:test",
  harness: "zo-ask",
  invocation_key: `sha256:${"c".repeat(64)}`,
  requested_at: "2026-07-11T00:00:00.000Z",
  completed_at: "2026-07-11T00:00:01.000Z",
  prompt_sha256: `sha256:${"d".repeat(64)}`,
  result_sha256: hash(reviewPath),
  artifact_ref: reviewPath,
  artifact_sha256: hash(reviewPath),
  result_ref: reviewPath,
  cost_usd: 0.01,
  reused: false,
  verdict: "pass",
  model_vendor: "anthropic",
  implementer_model_name: "byok:implementer",
  implementer_vendor: "openai",
  distinct_model: true,
  vendor_diverse: true,
  reason: null,
};
const personaParticipation: PersonaOrchestrationRecord = {
  version: 1,
  campaign_id: "campaign-test",
  task_id: "T1",
  mode: "enforce",
  association: { template_reference: "game@1.0.0", version: "1.0.0", sha256: "a".repeat(64), content_fingerprint: "e".repeat(64) },
  directory: { snapshot_hash: "b".repeat(64), captured_at: "2026-07-11T00:00:00.000Z" },
  invocations: [personaReview],
  omitted_roles: [],
  blocked_reason: null,
  total_cost_usd: 0.01,
  created_at: "2026-07-11T00:00:00.000Z",
  updated_at: "2026-07-11T00:00:01.000Z",
};

const manifest = createEvidenceManifest({
  schema_version: 1,
  ticket: "ZOU-TEST",
  execution_id: "exec-test",
  commit_digest: commitDigest,
  seed_hash: "sha256:seed",
  author,
  executor: author,
  reviewers: [author, reviewer],
  review_evidence: { status: "pass", evidence: [reviewPath], hashes: { [reviewPath]: hash(reviewPath) } },
  tests: ["bun test", "bun test"],
  test_evidence: { status: "pass", evidence: [testPath], hashes: { [testPath]: hash(testPath) } },
  artifacts: [tracePath],
  trace_verification: { status: "pass", evidence: [tracePath], hashes: { [tracePath]: hash(tracePath) } },
  feature_contract: { status: "pass", evidence: [featurePath], hashes: { [featurePath]: hash(featurePath) } },
  supply_chain: { status: "pass", evidence: [attestationPath], hashes: { [attestationPath]: hash(attestationPath) }, attestation_hash: "sha256:supply" },
  verdict: "pass",
  rollout_mode: "blocking",
  override: null,
  generated_at: "2026-07-11T00:00:00.000Z",
  persona_participation: personaParticipation,
});
check("blocking manifest validates", validateEvidenceManifest(manifest).length === 0);
const legacyManifest = Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "commit_digest"));
const legacyUnsigned = Object.fromEntries(Object.entries(legacyManifest).filter(([key]) => key !== "content_hash"));
legacyManifest.content_hash = createEvidenceManifest(legacyUnsigned as Omit<typeof manifest, "content_hash">).content_hash;
check("historical v1 manifest without commit binding remains valid", validateEvidenceManifest(legacyManifest).length === 0);
check("blocking manifest is promotion eligible", promotionBlockers(manifest).length === 0);
const uncalledPersona = createEvidenceManifest({
  ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "content_hash")),
  persona_participation: {
    ...personaParticipation,
    invocations: [{ ...personaReview, status: "not_invoked", requested_at: null, completed_at: null, result_ref: null, result_sha256: null, artifact_ref: null, artifact_sha256: null, cost_usd: null, verdict: null }],
  },
} as Omit<typeof manifest, "content_hash">);
check("required uncalled persona cannot receive promotion credit", promotionBlockers(uncalledPersona).some((error) => error.includes("was not invoked")));
check("new pass verdict cannot omit evidence mode", !parseVerdict({
  ticket: "ZOU-BYPASS", execution_id: "exec-bypass", verdict: "pass", rework: false,
  evidence: "claimed pass", decided_at: "2026-07-11T00:00:01.000Z",
}).ok);

writeFileSync(tracePath, JSON.stringify({ execution_id: "exec-test", status: "fail" }));
const failedTraceManifest = createEvidenceManifest({
  ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "content_hash")),
  trace_verification: { status: "pass", evidence: [tracePath], hashes: { [tracePath]: hash(tracePath) } },
} as Omit<typeof manifest, "content_hash">);
check("failed trace artifact blocks promotion despite declared pass", promotionBlockers(failedTraceManifest).some((error) => error.includes("trace_verification artifact must pass")));
writeFileSync(tracePath, JSON.stringify({ execution_id: "exec-test", status: "pass" }));

const tampered = JSON.parse(JSON.stringify(manifest));
tampered.ticket = "ZOU-TAMPER";
check("tamper is detected", validateEvidenceManifest(tampered).includes("content_hash mismatch"));

try {
  const path = writeEvidenceManifest(manifest, dir);
  check("manifest persisted", readFileSync(path, "utf8").includes(manifest.content_hash));
  check("persisted manifest reads back", readEvidenceManifest(path).ticket === "ZOU-TEST");
  const verdict = parseVerdict({
    ticket: "ZOU-TEST",
    execution_id: "exec-test",
    verdict: "pass",
    rework: false,
    evidence: "focused tests passed",
    decided_at: "2026-07-11T00:00:00.000Z",
    evidence_manifest_path: path,
    evidence_manifest_hash: manifest.content_hash,
    evidence_mode: "blocking",
    outcome_verifier: { id: "factory-review-gate:exec-test", harness: "factory-review-gate", model: "deterministic/git-diff-check-v1" },
    commit_digest: commitDigest,
    evidence_digest: manifest.content_hash,
  });
  check("factory verdict consumes valid manifest", verdict.ok);
  check("partial outcome binding fails closed", !parseVerdict({
    ticket: "ZOU-TEST",
    execution_id: "exec-test",
    verdict: "pass",
    rework: false,
    evidence: "focused tests passed",
    decided_at: "2026-07-11T00:00:00.000Z",
    evidence_manifest_path: path,
    evidence_manifest_hash: manifest.content_hash,
    evidence_mode: "blocking",
    commit_digest: commitDigest,
  }).ok);
  check("identical retry is idempotent", writeEvidenceManifest(manifest, dir) === path);
  const different = createEvidenceManifest({
    ...Object.fromEntries(Object.entries(manifest).filter(([key]) => key !== "content_hash")),
    generated_at: "2026-07-11T00:01:00.000Z",
  } as Omit<typeof manifest, "content_hash">);
  const differentPath = writeEvidenceManifest(different, dir);
  check("changed evidence creates a new immutable version", differentPath !== path && readEvidenceManifest(path).content_hash === manifest.content_hash);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

process.exit(failures === 0 ? 0 : 1);
