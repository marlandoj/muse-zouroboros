/** Provider-aware identity for the contained Hermes execution fixture.
 * A fixture envelope never upgrades held reader work or authorizes production.
 */
import { createHash } from "node:crypto";
import { factoryClaimStorageKeyV2, heldHermesClaimSubject } from "./factory-claim-identity";
import type { ClaimReceiptV2 } from "./factory-claims-v2";
import type { HeldFactoryWork } from "./factory-work-contract";

export interface FactoryExecutionSubject {
  schema: "factory-execution-subject/v1";
  provider: "hermes";
  factory_work_id: string;
  claim_key: string;
  claim_generation: number;
  claim_owner: string;
  reader_proof_sha256: string;
  execution_id: string;
}

export interface FixtureHermesDispatch {
  schema: "factory-hermes-dispatch-fixture/v1";
  scope: "synthetic_only";
  dispatch_eligible: false;
  subject: FactoryExecutionSubject;
  work: HeldFactoryWork;
  claim_receipt: ClaimReceiptV2;
  content_sha256: string;
}

const TOKEN = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const RECEIPT_KEYS = ["schema", "transition", "request_id", "key", "provider", "factory_work_id",
  "generation", "owner", "reader_admission_proof", "lease_started_ms", "lease_expires_ms",
  "requested_lease_ms", "transition_sequence", "recorded_at_ms"];

export function fixtureHermesDispatch(work: HeldFactoryWork, receipt: ClaimReceiptV2,
  executionId: string): FixtureHermesDispatch {
  const claim = heldHermesClaimSubject(work);
  if (work.source_status !== "ready") throw new Error("FACTORY_EXECUTION_NOT_READY");
  if (typeof executionId !== "string" || !/^exec-[A-Za-z0-9_.:-]{1,120}$/.test(executionId)) throw new Error("FACTORY_EXECUTION_ID");
  if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)
    || Object.keys(receipt).length !== RECEIPT_KEYS.length
    || RECEIPT_KEYS.some(key => !Object.hasOwn(receipt, key))
    || receipt.schema !== "factory-claim-receipt/v2"
    || !["acquire", "renew"].includes(receipt.transition)
    || receipt.provider !== "hermes" || receipt.factory_work_id !== claim.work_id
    || receipt.key !== factoryClaimStorageKeyV2(claim)
    || !Number.isSafeInteger(receipt.generation) || receipt.generation < 1
    || typeof receipt.owner !== "string" || !TOKEN.test(receipt.owner)
    || typeof receipt.request_id !== "string" || !TOKEN.test(receipt.request_id)
    || !receipt.reader_admission_proof || Object.keys(receipt.reader_admission_proof).length !== 2
    || receipt.reader_admission_proof.schema !== "factory-reader-admission-proof/v1"
    || typeof receipt.reader_admission_proof.opaque_sha256 !== "string" || !DIGEST.test(receipt.reader_admission_proof.opaque_sha256)
    || !Number.isSafeInteger(receipt.transition_sequence) || receipt.transition_sequence < 1
    || ![receipt.lease_started_ms, receipt.lease_expires_ms, receipt.recorded_at_ms,
      receipt.requested_lease_ms].every(Number.isSafeInteger)
    || receipt.lease_started_ms < 0 || receipt.recorded_at_ms < receipt.lease_started_ms
    || receipt.requested_lease_ms < 1_000 || receipt.requested_lease_ms > 3_600_000
    || receipt.lease_expires_ms !== receipt.recorded_at_ms + receipt.requested_lease_ms) {
    throw new Error("FACTORY_EXECUTION_CLAIM_BINDING");
  }
  const subject: FactoryExecutionSubject = {
    schema: "factory-execution-subject/v1", provider: "hermes", factory_work_id: claim.work_id,
    claim_key: receipt.key, claim_generation: receipt.generation, claim_owner: receipt.owner,
    reader_proof_sha256: receipt.reader_admission_proof.opaque_sha256, execution_id: executionId,
  };
  return JSON.parse(JSON.stringify({ schema: "factory-hermes-dispatch-fixture/v1",
    scope: "synthetic_only", dispatch_eligible: false, subject, work, claim_receipt: receipt,
    content_sha256: createHash("sha256").update(JSON.stringify([work.title, work.description])).digest("hex"),
  })) as FixtureHermesDispatch;
}

/** Rebuild every binding, rather than trusting an object cast at a caller boundary. */
export function validateFixtureHermesDispatch(input: FixtureHermesDispatch): FixtureHermesDispatch {
  if (!input || typeof input !== "object" || Array.isArray(input) || !input.subject) {
    throw new Error("FACTORY_EXECUTION_ENVELOPE");
  }
  const expected = fixtureHermesDispatch(input.work, input.claim_receipt, input.subject.execution_id);
  if (JSON.stringify(input) !== JSON.stringify(expected)) throw new Error("FACTORY_EXECUTION_ENVELOPE");
  return expected;
}
