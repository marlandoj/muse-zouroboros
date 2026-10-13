/**
 * project-delegation-stub.ts — Local stand-in for the zouroboros-governance
 * project-delegation-receipt module.
 *
 * The upstream module (Skills/zouroboros-governance/scripts/
 * project-delegation-receipt.ts) performs cryptographic (HMAC/Ed25519)
 * verification of project-delegation receipts and is not vendored in this
 * distribution. This stub provides the types and constants the factory lane
 * needs to load, and FAILS CLOSED on any actual verification attempt:
 *
 * - `verifySeedAdmission` THROWS. It is only reached when a seed contract
 *   carries delegation metadata; without the real verifier we must not
 *   silently admit a delegated seed.
 * - The normal path (no delegation metadata) never calls it and is
 *   unaffected.
 *
 * If delegated execution is needed, vendor the upstream module and repoint
 * pool-queue.ts / swarm-exec.ts at it.
 */

import { homedir } from "node:os";
import { join } from "node:path";

export type ProjectDelegationRiskLane = "L1_local_reversible" | "L2_remote_reversible";

export interface ProjectDelegationPaths {
  mandate_path: string;
  activation_receipt_path: string;
  receipt_path: string;
  action_payload_path: string;
  evidence_path: string;
}

export const DEFAULT_PROJECT_DELEGATION_KEY_PATH = join(
  homedir(),
  ".zouroboros/governance/project-delegation-receipt.hmac",
);

export interface ProjectDelegationVerificationInput {
  paths: ProjectDelegationPaths;
  seed_path: string;
  expected_ticket: string;
  expected_repository: string;
  expected_lane: ProjectDelegationRiskLane;
  key_path?: string;
  audit_log_path: string;
}

export interface ProjectDelegationVerificationResult {
  passed: boolean;
  reason: string;
  receipt_sha256: string | null;
  seed_sha256: string | null;
  action_payload_sha256: string | null;
  evidence_sha256: string | null;
  mandate_sha256: string | null;
  lane: ProjectDelegationRiskLane | null;
}

/**
 * Fail-closed stub: delegated seed admission cannot be verified without the
 * upstream cryptographic verifier. Never returns a passing result.
 */
export function verifySeedAdmission(
  _input: ProjectDelegationVerificationInput,
): ProjectDelegationVerificationResult {
  throw new Error(
    "project-delegation-receipt is not vendored in this distribution — " +
      "cannot verify delegated seed admission; refusing to admit",
  );
}

export interface ProjectDelegationActionPayload {
  action: string;
  [key: string]: unknown;
}

export interface ProjectDelegationOperationalStatePaths {
  revocations_path: string;
  project_status_path: string;
}

/**
 * Fail-closed stubs: remote action admission cannot be verified without the
 * upstream cryptographic verifier.
 */
export function verifyRemoteActionAdmission(
  _input: Omit<ProjectDelegationVerificationInput, "expected_lane">,
): ProjectDelegationVerificationResult {
  throw new Error(
    "project-delegation-receipt is not vendored in this distribution — " +
      "cannot verify remote action admission; refusing to admit",
  );
}

export function verifyRemoteActionAdmissionForTest(
  _input: Omit<ProjectDelegationVerificationInput, "expected_lane">,
  _operationalStatePaths: ProjectDelegationOperationalStatePaths,
): ProjectDelegationVerificationResult {
  throw new Error(
    "project-delegation-receipt is not vendored in this distribution — " +
      "cannot verify remote action admission; refusing to admit",
  );
}
