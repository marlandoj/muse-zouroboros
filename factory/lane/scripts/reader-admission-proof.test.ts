import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, createPublicKey, generateKeyPairSync, sign as signWithKey } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFixtureReaderProof } from "./reader-admission-proof";

const linuxTest = process.platform === "linux" ? test : test.skip;
let root = "";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return "{" + Object.keys(item).sort().map(k => JSON.stringify(k) + ":" + canonical(item[k])).join(",") + "}";
  }
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error("invalid proof test input");
  return raw;
}

function openssl(...args: string[]) {
  const result = Bun.spawnSync(["openssl", ...args], { stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error("reader key fixture generation failed");
}

beforeAll(() => {
  if (process.platform !== "linux") return;
  root = mkdtempSync(join(tmpdir(), "zo-task-hermes-proof-"));
  chmodSync(root, 0o700);
  openssl("genpkey", "-algorithm", "ED25519", "-out", join(root, "reader.key"));
  chmodSync(join(root, "reader.key"), 0o600);
  openssl("pkey", "-in", join(root, "reader.key"), "-pubout", "-out", join(root, "reader.pub"));
});

afterAll(() => {
  if (root.startsWith(join(tmpdir(), "zo-task-hermes-proof-"))) {
    rmSync(root, { recursive: true, force: true });
  }
});

function snapshot() {
  return { board: "software-factory", dispatch_enabled: false,
    work_admission: "held", work: [] };
}

function sign(fields: Record<string, unknown>) {
  writeFileSync(join(root, "request.json"), canonical(fields), { mode: 0o600 });
  const script = fileURLToPath(new URL("../hermes/reader_proof.py", import.meta.url));
  const result = Bun.spawnSync(["python3", "-I", "-B", script, "sign-fixture",
    "--private-key", join(root, "reader.key"),
    "--public-key", join(root, "reader.pub"),
    "--request", join(root, "request.json")], {
    env: { ...process.env, FACTORY_STATE_MODE: "test" },
    stdout: "pipe", stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new Error("Python reader proof fixture failed");
  return JSON.parse(Buffer.from(result.stdout).toString("utf8"));
}

function fixture(offsetMs = 0) {
  const payload = snapshot();
  const now = Date.now() + offsetMs;
  const fields = {
    schema: "held-reader-proof/v1", receipt_digest: "a".repeat(64),
    board_generation: 3, db_generation: 5, issuer_epoch: 4,
    full_schema_sha256: "b".repeat(64),
    payload_sha256: createHash("sha256").update(canonical(payload)).digest("hex"),
    client_spki_sha256: "d".repeat(64),
    nonce: "c".repeat(32), issued_at_ms: now,
    expires_at_ms: now + 20_000,
  };
  const publicKeyPem = readFileSync(join(root, "reader.pub"));
  const spki = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  const binding = { publicKeyPem,
    expectedSpkiSha256: createHash("sha256").update(spki).digest("hex"),
    receiptDigest: fields.receipt_digest,
    boardGeneration: fields.board_generation, dbGeneration: fields.db_generation,
    issuerEpoch: fields.issuer_epoch,
    fullSchemaSha256: fields.full_schema_sha256,
    clientSpkiSha256: fields.client_spki_sha256, nonce: fields.nonce };
  return { proof: sign(fields), payload, binding };
}

linuxTest("Python reader key signs held proof verified by TypeScript", () => {
  const { proof, payload, binding } = fixture();
  const result = verifyFixtureReaderProof(proof, payload, binding);
  expect(result.status).toBe("held_untrusted_snapshot");
  expect(result.dispatch_eligible).toBe(false);
  expect(result.proof_sha256).toMatch(/^[0-9a-f]{64}$/);
});

linuxTest("payload, nonce, generation, key pin and signature drift hold", () => {
  const { proof, payload, binding } = fixture();
  expect(() => verifyFixtureReaderProof(proof, { ...payload, work: [1] }, binding))
    .toThrow("HERMES_PROOF_FIELDS");
  expect(() => verifyFixtureReaderProof(proof, { ...payload, score: Number.NaN }, binding))
    .toThrow("HERMES_PROOF_CANONICAL");
  expect(() => verifyFixtureReaderProof(proof, payload, { ...binding, nonce: "d".repeat(32) }))
    .toThrow("HERMES_PROOF_FIELDS");
  expect(() => verifyFixtureReaderProof(proof, payload, { ...binding, boardGeneration: 5 }))
    .toThrow("HERMES_PROOF_FIELDS");
  expect(() => verifyFixtureReaderProof(proof, payload, { ...binding, dbGeneration: 6 }))
    .toThrow("HERMES_PROOF_FIELDS");
  expect(() => verifyFixtureReaderProof(proof, payload,
    { ...binding, expectedSpkiSha256: "0".repeat(64) })).toThrow("HERMES_PROOF_KEY_PIN");
  const forged = { ...proof, signature: "0".repeat(128) };
  expect(() => verifyFixtureReaderProof(forged, payload, binding)).toThrow("HERMES_PROOF_SIGNATURE");
});

linuxTest("freshly signed stale and future proofs hold", () => {
  for (const offset of [-60_000, 60_000]) {
    const { proof, payload, binding } = fixture(offset);
    expect(() => verifyFixtureReaderProof(proof, payload, binding))
      .toThrow("HERMES_PROOF_FIELDS");
  }
});

linuxTest("a separate fixture client key cannot mint a reader proof", () => {
  const { proof, payload, binding } = fixture();
  const { privateKey } = generateKeyPairSync("ed25519");
  const body = proof.body;
  const message = Buffer.concat([Buffer.from("hermes-held-reader-proof/v1\0"),
    Buffer.from(canonical(body))]);
  const forged = { ...proof, signature: signWithKey(null, message, privateKey).toString("hex") };
  expect(() => verifyFixtureReaderProof(forged, payload, binding))
    .toThrow("HERMES_PROOF_SIGNATURE");
});

linuxTest("production mode refuses fixture proof before verification", () => {
  const { proof, payload, binding } = fixture();
  const prior = process.env.FACTORY_STATE_MODE;
  delete process.env.FACTORY_STATE_MODE;
  try {
    expect(() => verifyFixtureReaderProof(proof, payload, binding))
      .toThrow("HERMES_PROOF_FIXTURE_ONLY");
  } finally {
    if (prior === undefined) delete process.env.FACTORY_STATE_MODE;
    else process.env.FACTORY_STATE_MODE = prior;
  }
});
