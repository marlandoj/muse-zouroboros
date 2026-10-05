/** Fixture-only reader-origin proof verifier; every accepted payload stays held. */
import { createHash, createPublicKey, verify } from "node:crypto";

const DOMAIN = Buffer.from("hermes-held-reader-proof/v1\0", "utf8");
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX128 = /^[0-9a-f]{128}$/;
const BODY_KEYS = ["schema", "receipt_digest", "board_generation", "db_generation", "issuer_epoch",
  "full_schema_sha256", "payload_sha256", "client_spki_sha256", "nonce", "issued_at_ms",
  "expires_at_ms", "key_id"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value)) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  if (typeof value === "number" && (!Number.isFinite(value) || Object.is(value, -0))) {
    throw new Error("HERMES_PROOF_CANONICAL");
  }
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error("HERMES_PROOF_CANONICAL");
  return raw;
}

export interface HeldReaderProofBinding {
  publicKeyPem: Buffer;
  expectedSpkiSha256: string;
  receiptDigest: string;
  boardGeneration: number;
  dbGeneration: number;
  issuerEpoch: number;
  fullSchemaSha256: string;
  clientSpkiSha256: string;
  nonce: string;
}

export interface HeldReaderProofResult {
  status: "held_untrusted_snapshot";
  dispatch_eligible: false;
  proof_sha256: string;
}

/** The verification key and expected bindings must arrive outside the proof. */
export function verifyFixtureReaderProof(
  proof: unknown, snapshot: unknown, binding: HeldReaderProofBinding,
): HeldReaderProofResult {
  if (process.env.FACTORY_STATE_MODE !== "test") throw new Error("HERMES_PROOF_FIXTURE_ONLY");
  if (!Buffer.isBuffer(binding.publicKeyPem) || !binding.publicKeyPem.length
      || binding.publicKeyPem.length > 16_384
      || !HEX64.test(binding.expectedSpkiSha256)
      || !HEX64.test(binding.receiptDigest) || !HEX64.test(binding.fullSchemaSha256)
      || !HEX64.test(binding.clientSpkiSha256)
      || !HEX32.test(binding.nonce)
      || !Number.isSafeInteger(binding.boardGeneration) || binding.boardGeneration < 1
      || !Number.isSafeInteger(binding.dbGeneration) || binding.dbGeneration < 1
      || !Number.isSafeInteger(binding.issuerEpoch) || binding.issuerEpoch < 1) {
    throw new Error("HERMES_PROOF_BINDING");
  }
  if (!record(proof) || !exact(proof, ["body", "signature", "work_admission", "dispatch_enabled"])
      || proof.work_admission !== "held" || proof.dispatch_enabled !== false
      || !record(proof.body) || !exact(proof.body, BODY_KEYS)
      || typeof proof.signature !== "string" || !HEX128.test(proof.signature)) {
    throw new Error("HERMES_PROOF_ENVELOPE");
  }
  const body = proof.body;
  const payloadHash = createHash("sha256").update(canonical(snapshot)).digest("hex");
  const now = Date.now();
  if (body.schema !== "held-reader-proof/v1"
      || body.receipt_digest !== binding.receiptDigest
      || body.board_generation !== binding.boardGeneration
      || body.db_generation !== binding.dbGeneration
      || body.issuer_epoch !== binding.issuerEpoch
      || body.full_schema_sha256 !== binding.fullSchemaSha256
      || body.payload_sha256 !== payloadHash || body.nonce !== binding.nonce
      || body.client_spki_sha256 !== binding.clientSpkiSha256
      || !Number.isSafeInteger(body.issued_at_ms)
      || !Number.isSafeInteger(body.expires_at_ms)
      || (body.issued_at_ms as number) > now + 2_000
      || (body.expires_at_ms as number) <= now
      || (body.expires_at_ms as number) - (body.issued_at_ms as number) > 30_000
      || (body.expires_at_ms as number) <= (body.issued_at_ms as number)
      || typeof body.key_id !== "string" || !HEX64.test(body.key_id)) {
    throw new Error("HERMES_PROOF_FIELDS");
  }
  let key;
  try {
    key = createPublicKey(binding.publicKeyPem);
  } catch {
    throw new Error("HERMES_PROOF_PUBLIC_KEY");
  }
  if (key.asymmetricKeyType !== "ed25519") throw new Error("HERMES_PROOF_PUBLIC_KEY");
  const spki = key.export({ format: "der", type: "spki" });
  const keyId = createHash("sha256").update(spki).digest("hex");
  if (keyId !== binding.expectedSpkiSha256 || body.key_id !== keyId) {
    throw new Error("HERMES_PROOF_KEY_PIN");
  }
  const message = Buffer.concat([DOMAIN, Buffer.from(canonical(body), "utf8")]);
  if (!verify(null, message, key, Buffer.from(proof.signature, "hex"))) {
    throw new Error("HERMES_PROOF_SIGNATURE");
  }
  return { status: "held_untrusted_snapshot", dispatch_eligible: false,
    proof_sha256: createHash("sha256").update(canonical(proof)).digest("hex") };
}
