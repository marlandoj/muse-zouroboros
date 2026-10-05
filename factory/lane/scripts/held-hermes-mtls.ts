/** Connected mutual-TLS held reader fixture. No production caller or claim authority. */
import { createHash, randomBytes, X509Certificate } from "node:crypto";
import { connect } from "node:tls";
import { admitHeldHermesEnvelope, type HeldSnapshotBinding } from "./held-hermes-http";
import type { HeldFactoryWork } from "./factory-work-contract";
import { verifyFixtureReaderProof, type HeldReaderProofBinding, type HeldReaderProofResult } from "./reader-admission-proof";

const MAX_RESPONSE = 8_000_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (record(value)) {
    return "{" + Object.keys(value).sort().map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
  }
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error("HERMES_MTLS_CANONICAL");
  return raw;
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export interface HeldMutualTlsFixture {
  port: number;
  ca: Buffer;
  clientCert: Buffer;
  clientKey: Buffer;
  expectedServerDns: string;
  expectedServerCertSha256: string;
  expectedServerSpkiSha256: string;
  receiptDigest: string;
  binding: HeldSnapshotBinding;
}

async function exchange(input: HeldMutualTlsFixture, nonce: string): Promise<Buffer> {
  const request = Buffer.from(canonical({ schema: "held-reader-request/v1", nonce,
    receipt_digest: input.receiptDigest }), "utf8");
  if (request.length > 512) throw new Error("HERMES_MTLS_REQUEST_SIZE");
  const frame = Buffer.allocUnsafe(request.length + 4);
  frame.writeUInt32BE(request.length, 0);
  request.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const peer = connect({ host: "127.0.0.1", port: input.port,
      ca: input.ca, cert: input.clientCert, key: input.clientKey,
      servername: input.expectedServerDns, rejectUnauthorized: true,
      minVersion: "TLSv1.3" });
    let settled = false;
    let secure = false;
    let total = 0;
    const chunks: Buffer[] = [];
    const deadline = setTimeout(() => fail(new Error("HERMES_MTLS_TIMEOUT")), 5000);
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      peer.destroy();
      reject(error);
    }
    peer.once("secureConnect", () => {
      const certificate = peer.getPeerCertificate(true);
      if (!peer.authorized || !Buffer.isBuffer(certificate.raw)
          || createHash("sha256").update(certificate.raw).digest("hex") !== input.expectedServerCertSha256
          || certificate.subjectaltname !== "DNS:" + input.expectedServerDns) {
        return fail(new Error("HERMES_MTLS_SERVER_IDENTITY"));
      }
      try {
        const spki = new X509Certificate(certificate.raw).publicKey.export({ type: "spki", format: "der" });
        if (createHash("sha256").update(spki).digest("hex") !== input.expectedServerSpkiSha256) {
          return fail(new Error("HERMES_MTLS_SERVER_SPKI"));
        }
      } catch {
        return fail(new Error("HERMES_MTLS_SERVER_SPKI"));
      }
      secure = true;
      peer.write(frame);
    });
    peer.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_RESPONSE + 4) return fail(new Error("HERMES_MTLS_SIZE"));
      chunks.push(chunk);
      if (total >= 4) {
        const joined = Buffer.concat(chunks, total);
        const size = joined.readUInt32BE(0);
        if (size === 0 || size > MAX_RESPONSE || total > size + 4) {
          return fail(new Error("HERMES_MTLS_SIZE"));
        }
      }
    });
    peer.on("end", () => {
      if (settled) return;
      const joined = Buffer.concat(chunks, total);
      if (!secure || total < 4 || joined.readUInt32BE(0) !== total - 4) {
        return fail(new Error("HERMES_MTLS_TRUNCATED"));
      }
      settled = true;
      clearTimeout(deadline);
      resolve(joined.subarray(4));
    });
    peer.on("error", () => fail(new Error("HERMES_MTLS_CONNECTION")));
  });
}

async function admit(input: HeldMutualTlsFixture,
  proofBinding?: Omit<HeldReaderProofBinding, "nonce">,
): Promise<{ work: HeldFactoryWork[]; proof?: HeldReaderProofResult }> {
  if (process.env.FACTORY_STATE_MODE !== "test") throw new Error("HERMES_MTLS_FIXTURE_ONLY");
  if (!Number.isSafeInteger(input.port) || input.port < 1 || input.port > 65535
      || !/^[a-z0-9.-]+$/.test(input.expectedServerDns)
      || !HEX64.test(input.expectedServerCertSha256)
      || !HEX64.test(input.expectedServerSpkiSha256) || !HEX64.test(input.receiptDigest)
      || !Buffer.isBuffer(input.ca) || !Buffer.isBuffer(input.clientCert)
      || !Buffer.isBuffer(input.clientKey)
      || [input.ca, input.clientCert, input.clientKey].some(item => item.length === 0 || item.length > 16_384)) {
    throw new Error("HERMES_MTLS_BINDING");
  }
  const nonce = randomBytes(16).toString("hex");
  const raw = await exchange(input, nonce);
  const decoded = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  const response: unknown = JSON.parse(decoded);
  const keys = ["schema", "nonce", "receipt_digest", "cache_control",
    "work_admission", "dispatch_enabled", "snapshot"];
  if (proofBinding) keys.push("proof");
  if (!record(response) || decoded !== canonical(response)
      || !exact(response, keys)
      || response.schema !== "held-reader-response/v1"
      || typeof response.nonce !== "string" || !HEX32.test(response.nonce)
      || response.nonce !== nonce || response.receipt_digest !== input.receiptDigest
      || response.cache_control !== "no-store" || response.work_admission !== "held"
      || response.dispatch_enabled !== false) throw new Error("HERMES_MTLS_RESPONSE");
  let proof: HeldReaderProofResult | undefined;
  if (proofBinding) {
    const clientSpki = new X509Certificate(input.clientCert).publicKey.export({ type: "spki", format: "der" });
    const clientSpkiSha256 = createHash("sha256").update(clientSpki).digest("hex");
    if (proofBinding.clientSpkiSha256 !== clientSpkiSha256) throw new Error("HERMES_PROOF_CLIENT_PIN");
    proof = verifyFixtureReaderProof(response.proof, response.snapshot, { ...proofBinding, nonce });
  }
  // Authenticate the connected payload before projecting any of its work.
  const work = await admitHeldHermesEnvelope(response.snapshot, input.binding);
  return { work, proof };
}

/** A legacy transport fixture response has no proof and remains held. */
export async function admitHeldHermesMutualTls(input: HeldMutualTlsFixture): Promise<HeldFactoryWork[]> {
  return (await admit(input)).work;
}

/** Connected proof binding is still a synthetic, non-dispatching held snapshot. */
export async function admitHeldHermesMutualTlsWithProof(input: HeldMutualTlsFixture,
  proofBinding: Omit<HeldReaderProofBinding, "nonce">,
): Promise<{ work: HeldFactoryWork[]; proof: HeldReaderProofResult }> {
  if (!proofBinding) throw new Error("HERMES_PROOF_BINDING");
  const result = await admit(input, proofBinding);
  if (!result.proof) throw new Error("HERMES_PROOF_MISSING");
  return { work: result.work, proof: result.proof };
}
