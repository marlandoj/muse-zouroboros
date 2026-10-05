/**
 * Durable native review qualification using the existing OperationJournal schema.
 * The Factory dispatcher is not wired here. An installed consumer must supply an
 * attested plan/profile, a qualified journal path and current operator authority.
 * Campaign IDs and logical bindings come from that trusted consumer, not a model.
 * Native enforcement remains a separate shadow/qualification lane, not an initial
 * activation prerequisite. api_call effects require an independent receipt
 * verifier under the existing receipt contract; an injected callback or boolean
 * is not by itself installed organizational attestation or model Consensus.
 */
import { createHash } from "node:crypto";
import {
  createNativeReviewPreparation, type NativePersonaCallRequest, type NativePersonaCallResult,
  type NativeReviewOutcome, type NativeReviewPlan, type NativeReviewReceipt,
  type NativeReviewTransportDependencies,
} from "./native-review-adapter";
import { OperationJournal, OperationJournalError, type CrashBoundary, type JournalAuthority } from "./run-operation-journal";
import { canonicalize, CONTRACT_ID, RECEIPT_SCHEMA_VERSION, type RunReceipt } from "./run-receipt-contract";

export interface NativeReviewBinding {
  workId: string;
  sourceRevision: string;
  /** Exact native persona ID, fixed by the trusted review assignment. */
  roleId: string;
  round: number;
}
export interface NativeReviewCampaign {
  id: string;
  directorySha256: string;
  authority: JournalAuthority;
}
export interface JournaledNativeReviewResult {
  status: "completed" | "failed" | "held";
  operationId: string;
  receiptHash: string | null;
  review: NativeReviewReceipt | null;
  result: NativePersonaCallResult | null;
  reused: boolean;
  reasonCode: string | null;
}
export interface JournaledNativeReviewOptions {
  plan: NativeReviewPlan;
  expectedPlanSha256: string;
  campaign: NativeReviewCampaign;
  journalPath: string;
  mode?: "shadow" | "qualification";
  dependencies: NativeReviewTransportDependencies;
  /** Independently owned receipt verifier; installation authority must attest its
   * identity and separation. There is deliberately no permissive default. */
  verifier: {
    identity: string;
    organizationSeparate: true;
    verify(review: Readonly<NativeReviewReceipt>): Promise<void>;
  };
  now?: () => string;
  /** Fixture seam only; production must not install a crash injector. */
  crashInjector?: (boundary: CrashBoundary) => void;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const POLICY_SCOPE = "factory.native-review.policy/v1";
const INVOKE_SCOPE = "native-review.invoke";
const ARTIFACT_REF = "native-review:retained-attempt/v1";
function fail(code: string): never { throw new Error(`NATIVE_REVIEW_${code}`); }
function snapshot<T>(value: T): T {
  const result = JSON.parse(JSON.stringify(value)) as T;
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") { Object.values(item).forEach(freeze); Object.freeze(item); }
  };
  freeze(result); return result;
}
function validateAuthority(authority: JournalAuthority): void {
  if (authority.envelopeKind !== "operator_approval" || authority.autonomyTier !== "T0"
      || !Array.isArray(authority.scopes) || !authority.scopes.includes("operation.reserve")
      || !authority.scopes.includes(INVOKE_SCOPE)
      || !Number.isFinite(Date.parse(authority.approvalTs ?? ""))
      || !Number.isFinite(Date.parse(authority.expiresAt ?? ""))) fail("AUTHORITY_INVALID");
  // References only. Never persist free-form credential values in an envelope.
  for (const value of [authority.approvingAuthority, authority.approvalRef, authority.authorizationEvidenceRef, ...authority.scopes]) {
    if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._/@#-]{0,255}$/.test(value)
        || /(?:lin_api_|sk-|gh[pousr]_|xox[baprs]-|(?:api[_-]?key|password|secret|token)=)/i.test(value)) fail("AUTHORITY_INVALID");
  }
}
function template(operationId: string, logicalKey: string, revision: string, planHash: string,
  authority: JournalAuthority, review: NativeReviewReceipt | null, verifierIdentity: string,
  independentlyVerified = false): RunReceipt {
  const artifact = review ? canonicalize(review) : null;
  return {
    contract_id: CONTRACT_ID, schema_version: RECEIPT_SCHEMA_VERSION,
    receipt_id: "rr-00000000000000000000000000", operation_id: operationId,
    idempotency_key: logicalKey, receipt_hash: "0".repeat(64),
    trigger: { kind: "factory", identity: "native-review-journal", intent: logicalKey, input_hash: "0".repeat(64), ts: new Date(0).toISOString() },
    lineage: { parent_receipt_id: null, trace_id: logicalKey.slice(0, 32), span_id: logicalKey.slice(32, 48),
      inherited_state_refs: [`git:${revision}`], wave_id: null, seed_id: null },
    versions: { contract_version: CONTRACT_ID, policy_version: planHash, model_versions: review ? { reviewer: review.model } : {},
      tool_versions: { source_revision: revision }, schema_migrations: [] },
    authority: { envelope_kind: authority.envelopeKind, approving_authority: authority.approvingAuthority,
      approval_ts: authority.approvalTs, approval_ref: authority.approvalRef, autonomy_tier: authority.autonomyTier,
      authorization_evidence_ref: authority.authorizationEvidenceRef },
    events: [], attempts: [],
    terminal: { outcome: "held", committed_state_hash: "0".repeat(64), ledger_entries: [],
      artifacts: artifact ? [{ kind: "evaluation", ref: ARTIFACT_REF, hash: hash(artifact), description: artifact }] : [] },
    acknowledgements: { accepted: { kind: "accepted", event_id: "evt-placeholder", ts: new Date(0).toISOString(), evidence_ref: "native-review-placeholder" },
      completed: null, user_visible: null },
    verification: { verifier_identity: verifierIdentity, verifier_org_separate: independentlyVerified,
      checks: [], edge_proof: { chain_ok: true, anchor_ok: true, ledger_head: null } },
    observation: { user_visible_outcome: null, user_confirmed: null, feedback_ref: null },
    ts_created: new Date(0).toISOString(), ts_terminal: new Date(0).toISOString(),
  };
}
function retained(journal: OperationJournal, receipt: RunReceipt, expected: Readonly<NativeReviewReceipt>,
  verifierIdentity: string, maxCost: number): NativeReviewReceipt | null {
  const artifacts = receipt.terminal.artifacts.filter((item) => item.ref === ARTIFACT_REF);
  if (!artifacts.length) {
    if (receipt.terminal.outcome !== "held") fail("RETAINED_RECEIPT_INVALID");
    return null;
  }
  if (artifacts.length !== 1 || artifacts[0]!.hash !== hash(artifacts[0]!.description)) fail("RETAINED_RECEIPT_INVALID");
  const review = JSON.parse(artifacts[0]!.description) as NativeReviewReceipt;
  if (review.schema !== "native-review-attempt/v1" || review.planSha256 !== expected.planSha256
      || review.personaId !== expected.personaId || review.model !== expected.model || review.vendor !== expected.vendor
      || review.promptSha256 !== expected.promptSha256 || !/^[a-f0-9-]{36}$/.test(review.attemptId)
      || review.status !== "completed" && review.status !== "failed") fail("RETAINED_RECEIPT_INVALID");
  if (review.status === "completed") {
    if (review.verdict !== "pass" && review.verdict !== "fail" || typeof review.summary !== "string" || !review.summary.trim()
        || review.outputSha256 !== hash(JSON.stringify({ verdict: review.verdict, summary: review.summary }))
        || typeof review.reportedCostUsd !== "number" || !Number.isFinite(review.reportedCostUsd)
        || review.reportedCostUsd < 0 || review.reportedCostUsd > maxCost || review.failureCode !== null
        || receipt.verification.verifier_identity !== verifierIdentity || receipt.verification.verifier_org_separate !== true
        || receipt.terminal.outcome !== (review.verdict === "pass" ? "success" : "failure")) fail("RETAINED_RECEIPT_INVALID");
    // Receipt hashes alone do not establish agreement with the durable effect
    // observation. Require the independently persisted committed evidence too.
    const rows = journal.db.query(`SELECT d.adapter_kind, d.target, s.state, s.canonical_evidence, s.evidence_hash
      FROM effect_definitions d JOIN effect_states s ON d.effect_id = s.effect_id
      WHERE d.operation_id = ? AND s.state_sequence =
        (SELECT MAX(x.state_sequence) FROM effect_states x WHERE x.effect_id = d.effect_id)`)
      .all(receipt.operation_id) as Array<{ adapter_kind: string; target: string; state: string; canonical_evidence: string; evidence_hash: string }>;
    const row = rows[0];
    if (rows.length !== 1 || !row || row.state !== "committed" || row.adapter_kind !== "native-subscription-review/v1"
        || row.target !== `claude-code:${expected.personaId}` || hash(row.canonical_evidence) !== row.evidence_hash) fail("RETAINED_RECEIPT_INVALID");
    const evidence = JSON.parse(row.canonical_evidence) as { review?: NativeReviewReceipt; invocationStarted?: boolean };
    if (evidence.invocationStarted !== true || canonicalize(evidence.review) !== canonicalize(review)) fail("RETAINED_RECEIPT_INVALID");
  } else if (typeof review.failureCode !== "string" || !/^NATIVE_REVIEW_[A-Z_]+$/.test(review.failureCode)
      || review.verdict !== null || review.summary !== null || review.outputSha256 !== null
      || !["failure", "held"].includes(receipt.terminal.outcome)) fail("RETAINED_RECEIPT_INVALID");
  return review;
}
function response(operationId: string, receipt: RunReceipt | null, review: NativeReviewReceipt | null,
  reused: boolean, reasonCode: string | null): JournaledNativeReviewResult {
  const status = !receipt || receipt.terminal.outcome === "held" ? "held" : review?.status === "completed" ? "completed" : "failed";
  return {
    status,
    operationId, receiptHash: receipt?.receipt_hash ?? null, review, reused, reasonCode,
    result: status === "completed" && review?.status === "completed" ? { output: JSON.stringify({ verdict: review.verdict, summary: review.summary }),
      model_name: review.model, cost_usd: review.reportedCostUsd } : null,
  };
}

export function createJournaledNativeReviewer(options: JournaledNativeReviewOptions):
  (request: NativePersonaCallRequest, binding: NativeReviewBinding) => Promise<JournaledNativeReviewResult> {
  const mode = options.mode ?? "shadow", plan = snapshot(options.plan), campaign = snapshot(options.campaign);
  const expectedPlanSha256 = options.expectedPlanSha256, journalPath = options.journalPath;
  const now = options.now ?? (() => new Date().toISOString()), crashInjector = options.crashInjector;
  if (!options.verifier || options.verifier.organizationSeparate !== true
      || typeof options.verifier.identity !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9:._/-]{0,127}$/.test(options.verifier.identity)
      || /(?:lin_api_|sk-|gh[pousr]_|xox[baprs]-)/i.test(options.verifier.identity)
      || typeof options.verifier.verify !== "function") fail("INDEPENDENT_VERIFIER_REQUIRED");
  const verifierIdentity = options.verifier.identity, verifyRecordedReview = options.verifier.verify.bind(options.verifier);
  const dependencies = {
    invoke: options.dependencies.invoke.bind(options.dependencies),
    verifyInstallation: options.dependencies.verifyInstallation.bind(options.dependencies),
    beforeInvocation: options.dependencies.beforeInvocation?.bind(options.dependencies),
  };
  // Validate the plan without opening a database, probing auth or launching a CLI.
  createNativeReviewPreparation({ plan, expectedPlanSha256, dependencies });
  if (typeof campaign.id !== "string" || !campaign.id.trim() || campaign.id.length > 128
      || !/^[a-f0-9]{64}$/.test(campaign.directorySha256)) fail("CAMPAIGN_INVALID");
  validateAuthority(campaign.authority);
  const campaignKey = hash(campaign.id), authority = campaign.authority;

  return async (input, suppliedBinding) => {
    if (mode !== "qualification") fail("SHADOW_NO_CALL");
    const request = snapshot(input), binding = snapshot(suppliedBinding);
    if (typeof binding.workId !== "string" || !binding.workId.trim() || binding.workId.length > 256
        || !/^[a-f0-9]{40}$/.test(binding.sourceRevision) || binding.roleId !== request.persona_id
        || !Number.isSafeInteger(binding.round) || binding.round < 1 || binding.round > 8) fail("LOGICAL_BINDING_INVALID");
    let lastTime = -Infinity;
    const assertAuthorityWindow = (): void => {
      const measured = Date.parse(now());
      if (!Number.isFinite(measured) || measured < lastTime || measured < Date.parse(authority.approvalTs!)
          || measured + request.timeout_ms >= Date.parse(authority.expiresAt!)) fail("AUTHORITY_WINDOW");
      lastTime = measured;
    };
    const prepare = createNativeReviewPreparation({ plan, expectedPlanSha256, dependencies: {
      invoke: dependencies.invoke, verifyInstallation: dependencies.verifyInstallation,
      beforeInvocation: async () => {
        assertAuthorityWindow();
        await dependencies.beforeInvocation?.();
        assertAuthorityWindow();
      },
    } });
    const prepared = prepare(request);
    assertAuthorityWindow();
    const stableBinding = { workIdSha256: hash(binding.workId), sourceRevision: binding.sourceRevision,
      roleId: binding.roleId, round: binding.round };
    const logicalKey = hash(canonicalize(stableBinding));
    // maxBusyRetries also controls effect retries: explicitly zero, even for
    // known preflight failures. Every future attempt needs a new approved binding.
    const journal = new OperationJournal(journalPath, { maxBusyRetries: 0, now, crashInjector });
    try {
      const policy = journal.reserve({ scope: POLICY_SCOPE, idempotencyKey: campaignKey,
        intent: { schema: "native-review-campaign/v1", campaignKey, planSha256: expectedPlanSha256,
          directorySha256: campaign.directorySha256, maxCalls: plan.maxCalls, verifierIdentity },
        triggerKind: "factory", triggerIdentity: "native-review-journal", authority });
      if (policy.status !== "reserved") fail("AUTHORITY_HELD");
      journal.assertOperationAuthority(policy.operationId, authority);
      const logical = journal.reserve({ scope: `factory.native-review.logical/v1:${campaignKey}`, idempotencyKey: logicalKey,
        intent: { schema: "native-review-logical/v1", ...stableBinding, campaignPolicy: policy.operationId,
          planSha256: expectedPlanSha256, personaId: prepared.receipt.personaId, model: prepared.receipt.model,
          promptSha256: prepared.receipt.promptSha256, inputSha256: hash(request.input), timeoutMs: request.timeout_ms },
        triggerKind: "factory", triggerIdentity: "native-review-journal", authority });
      if (logical.status !== "reserved") fail("AUTHORITY_HELD");
      journal.assertOperationAuthority(logical.operationId, authority);
      if (logical.existing) {
        const prior = journal.receipt(logical.operationId);
        const review = prior ? retained(journal, prior, prepared.receipt, verifierIdentity, plan.maxReportedCostUsd) : null;
        // A reservation without its terminal receipt is active or uncertain.
        // Never turn it into a new random attempt or retry the provider.
        return response(logical.operationId, prior, review, true,
          prior ? review?.failureCode ?? (prior.terminal.outcome === "held" ? "NATIVE_REVIEW_HELD" : null) : "NATIVE_REVIEW_ACTIVE_OR_UNCERTAIN");
      }
      journal.beginAttempt(logical.operationId, 1);
      let slotId: string | null = null;
      // Finite immutable slot keys replace a racy count-then-insert quota. Each
      // reserve uses the journal's BEGIN IMMEDIATE and UNIQUE(scope,key). Slots
      // are permanently consumed, including preflight failures and crash gaps.
      for (let slot = 1; slot <= plan.maxCalls; slot++) {
        try {
          const reserved = journal.reserve({ scope: `factory.native-review.budget/v1:${campaignKey}`, idempotencyKey: `slot:${slot}`,
            intent: { campaignPolicy: policy.operationId, logicalOperation: logical.operationId },
            triggerKind: "factory", triggerIdentity: "native-review-journal", authority });
          if (reserved.status !== "reserved") fail("AUTHORITY_HELD");
          journal.assertOperationAuthority(reserved.operationId, authority);
          slotId = reserved.operationId; break;
        } catch (error) {
          if (!(error instanceof OperationJournalError) || error.code !== "idempotency_conflict") throw error;
        }
      }
      if (!slotId) {
        journal.completeAttempt(logical.operationId, 1, "cancelled", "NATIVE_REVIEW_CALL_CAP");
        const receipt = journal.terminalize(logical.operationId, "held", "NATIVE_REVIEW_CALL_CAP",
          template(logical.operationId, logicalKey, binding.sourceRevision, expectedPlanSha256, authority, null, verifierIdentity));
        return response(logical.operationId, receipt, null, false, "NATIVE_REVIEW_CALL_CAP");
      }
      let observed: NativeReviewOutcome | null = null;
      const effect = await journal.executeEffect(logical.operationId, {
        attemptN: 1, adapterKind: "native-subscription-review/v1", sideEffectKind: "api_call",
        target: `claude-code:${prepared.receipt.personaId}`, input: { slotId, logicalKey,
          planSha256: expectedPlanSha256, promptSha256: prepared.receipt.promptSha256 },
        reversible: false, rollbackRef: null, authorityScope: INVOKE_SCOPE,
      }, authority, {
        dispatch: async () => {
          try {
            observed = await prepared.run();
            return { state: observed.receipt.status === "completed" ? "committed"
              : observed.invocationStarted ? "ambiguous" : "not_committed",
            evidence: { review: observed.receipt, invocationStarted: observed.invocationStarted } };
          } catch {
            // Never allow raw dependency errors into journal evidence, and never
            // infer non-dispatch after an unexpected transport exception.
            return { state: "ambiguous", evidence: { failureCode: "NATIVE_REVIEW_UNCERTAIN" } };
          }
        },
        probe: () => ({ state: "ambiguous", evidence: { failureCode: "NATIVE_REVIEW_RECONCILIATION_REQUIRED" } }),
      });
      const completed = observed as NativeReviewOutcome | null;
      const review = completed?.receipt ?? null;
      let independentlyVerified = false;
      if (effect.state === "committed" && review?.status === "completed") {
        try { await verifyRecordedReview(snapshot(review)); independentlyVerified = true; }
        catch {
          // The provider effect remains durably committed; missing verification
          // cannot be rewritten as a preflight failure or retried. Keep the
          // journal operation held pending explicit verification reconciliation.
          journal.completeAttempt(logical.operationId, 1, "failure", "NATIVE_REVIEW_VERIFICATION_REQUIRED");
          return response(logical.operationId, null, review, false, "NATIVE_REVIEW_VERIFICATION_REQUIRED");
        }
      }
      const outcome = effect.status === "held" ? "held" : review?.status === "completed"
        ? review.verdict === "pass" ? "success" : "failure" : "failure";
      const reason = review?.failureCode ?? (outcome === "held" ? "NATIVE_REVIEW_UNCERTAIN" : "NATIVE_REVIEW_RECORDED");
      journal.completeAttempt(logical.operationId, 1, outcome === "success" ? "success" : "failure", outcome === "success" ? null : reason);
      const receipt = journal.terminalize(logical.operationId, outcome, reason,
        template(logical.operationId, logicalKey, binding.sourceRevision, expectedPlanSha256, authority, review, verifierIdentity, independentlyVerified));
      return response(logical.operationId, receipt, review, false, review?.failureCode ?? (outcome === "held" ? reason : null));
    } catch (error) {
      // Preserve durable ambiguity. In particular do not rewrite a completed
      // effect when terminal receipt persistence failed.
      if (error instanceof OperationJournalError && ["idempotency_conflict", "authority_drift"].includes(error.code)) fail("BINDING_CONFLICT");
      if (error instanceof Error && /^NATIVE_REVIEW_[A-Z_]+$/.test(error.message)) throw error;
      fail("JOURNAL_FAILURE");
    } finally { journal.close(); }
  };
}
