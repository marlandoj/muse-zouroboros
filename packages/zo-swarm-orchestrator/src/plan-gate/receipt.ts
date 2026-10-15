import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import type {
  ApprovalReceipt,
  PlanGateMode,
  ReceiptVerificationResult,
  TrustedPublicKey,
} from './types.js';

export type TrustedPublicKeys = Record<string, TrustedPublicKey | string>;

export interface SignReceiptOptions {
  keyId: string;
  privateKey: string;
}

export interface VerifyReceiptOptions {
  artifactSha256: string;
  revision?: number;
  mode: PlanGateMode;
  trustedKeys?: TrustedPublicKeys;
  now?: Date;
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((key) => [key, sortValue(source[key])]));
  }
  return value;
}

export function canonicalizeReceiptPayload(receipt: ApprovalReceipt): string {
  const { signature: _signature, ...payload } = receipt;
  return JSON.stringify(sortValue(payload));
}

export function signApprovalReceipt(
  receipt: ApprovalReceipt,
  options: SignReceiptOptions
): ApprovalReceipt {
  if (!options.keyId.trim()) throw new Error('Receipt key_id is required');
  if (!receipt.actor.id || !receipt.actor.source || !receipt.actor.authorization) {
    throw new Error('Authenticated actor assertion is required');
  }
  const signable: ApprovalReceipt = {
    ...receipt,
    key_id: options.keyId,
    signed: true,
    enforcement_eligible: true,
    signature: undefined,
  };
  const signature = sign(
    null,
    Buffer.from(canonicalizeReceiptPayload(signable), 'utf8'),
    createPrivateKey(options.privateKey)
  ).toString('base64url');
  return { ...signable, signature };
}

export function parseTrustedPublicKeys(raw: string | undefined): TrustedPublicKeys {
  if (!raw) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Trusted public keys must be a key-id map');
  }
  return parsed as TrustedPublicKeys;
}

function fail(reason: string, keyId?: string): ReceiptVerificationResult {
  return { valid: false, enforcement_eligible: false, reason, key_id: keyId };
}

export function verifyApprovalReceipt(
  receipt: ApprovalReceipt | undefined,
  options: VerifyReceiptOptions
): ReceiptVerificationResult {
  if (!receipt) return fail('receipt_missing');
  if (receipt.artifact_sha256 !== options.artifactSha256) return fail('artifact_hash_mismatch', receipt.key_id);
  if (options.revision !== undefined && receipt.revision !== options.revision) {
    return fail('revision_mismatch', receipt.key_id);
  }
  if (!receipt.actor?.id || !receipt.actor.source || !receipt.actor.authorization) {
    return fail('actor_assertion_invalid', receipt.key_id);
  }
  if (!Array.isArray(receipt.gate_run_ids) || receipt.gate_run_ids.length === 0) {
    return fail('gate_run_ids_missing', receipt.key_id);
  }
  const issuedAt = Date.parse(receipt.timestamp);
  const expiresAt = Date.parse(receipt.expiry);
  const now = (options.now ?? new Date()).getTime();
  if (!Number.isFinite(issuedAt) || !Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
    return fail('receipt_time_invalid', receipt.key_id);
  }
  if (now > expiresAt) return fail('receipt_expired', receipt.key_id);
  if (options.mode !== 'enforce') {
    return {
      valid: true,
      enforcement_eligible: false,
      reason: 'advisory_receipt_not_enforced',
      key_id: receipt.key_id,
    };
  }
  if (!receipt.signed || !receipt.signature || !receipt.key_id || !receipt.enforcement_eligible) {
    return fail('signed_enforcement_receipt_required', receipt.key_id);
  }
  const entry = options.trustedKeys?.[receipt.key_id];
  if (!entry) return fail('trusted_key_missing', receipt.key_id);
  const normalized = typeof entry === 'string' ? { public_key: entry } : entry;
  const metadata = normalized.metadata;
  if (metadata?.revoked) return fail('trusted_key_revoked', receipt.key_id);
  if (metadata && metadata.key_id !== receipt.key_id) return fail('trusted_key_id_mismatch', receipt.key_id);
  if (metadata?.not_before && now < Date.parse(metadata.not_before)) return fail('trusted_key_not_active', receipt.key_id);
  if (metadata?.not_after && now > Date.parse(metadata.not_after)) return fail('trusted_key_expired', receipt.key_id);
  try {
    const valid = verify(
      null,
      Buffer.from(canonicalizeReceiptPayload(receipt), 'utf8'),
      createPublicKey(normalized.public_key),
      Buffer.from(receipt.signature, 'base64url')
    );
    return valid
      ? { valid: true, enforcement_eligible: true, key_id: receipt.key_id }
      : fail('signature_invalid', receipt.key_id);
  } catch {
    return fail('trust_material_invalid', receipt.key_id);
  }
}
