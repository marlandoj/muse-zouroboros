import { hashPlanArtifact } from './canonicalize.js';
import { evaluatePlanGatePolicy, type PlanGateContext } from './policy.js';
import { verifyApprovalReceipt, type TrustedPublicKeys } from './receipt.js';
import { validatePlanArtifact } from './validate.js';
import type { PlanValidationOptions } from './validate.js';
import type {
  ApprovalReceipt,
  PlanArtifact,
  PlanGateMode,
  PlanGatePreflightResult,
} from './types.js';

export interface PlanGatePreflightOptions {
  artifact: PlanArtifact;
  mode?: PlanGateMode;
  receipt?: ApprovalReceipt;
  trustedKeys?: TrustedPublicKeys;
  now?: Date;
  validationOptions?: PlanValidationOptions;
  policyContext?: PlanGateContext;
}

export function evaluatePlanGatePreflight(options: PlanGatePreflightOptions): PlanGatePreflightResult {
  const mode = options.mode ?? 'disabled';
  const artifactSha256 = hashPlanArtifact(options.artifact);
  const policy = evaluatePlanGatePolicy(options.artifact, options.policyContext);
  const deterministicReport = validatePlanArtifact(options.artifact, options.validationOptions);
  const required = policy.mode === 'mandatory';
  const deterministicBlocked = !deterministicReport.passed;
  const verification = options.receipt
    ? verifyApprovalReceipt(options.receipt, {
        artifactSha256,
        revision: options.artifact.revision,
        mode,
        trustedKeys: options.trustedKeys,
        now: options.now,
      })
    : undefined;
  const wouldHold = required && (deterministicBlocked || !verification?.valid || !verification.enforcement_eligible);

  if (mode === 'enforce' && wouldHold) {
    const reason = deterministicBlocked
      ? 'deterministic_validation_failed'
      : verification?.reason ?? 'approval_receipt_required';
    return {
      action: 'hold', mode, required, would_hold: true, artifact_sha256: artifactSha256,
      policy, deterministic_report: deterministicReport, receipt_verification: verification,
      reason, audit_event: 'plan_gate_hold',
    };
  }

  return {
    action: 'proceed', mode, required, would_hold: wouldHold, artifact_sha256: artifactSha256,
    policy, deterministic_report: deterministicReport, receipt_verification: verification,
    reason: mode === 'disabled' ? 'plan_gate_disabled' : wouldHold ? 'shadow_or_advisory_would_hold' : 'plan_gate_passed',
    audit_event: wouldHold ? 'plan_gate_shadow_hold' : 'plan_gate_proceed',
  };
}
