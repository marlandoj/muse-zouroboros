import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createServer } from "node:tls";
import { fileURLToPath } from "node:url";
import { admitHeldHermesMutualTls, admitHeldHermesMutualTlsWithProof } from "./held-hermes-mtls";
import { admitHeldMutualTlsConfig } from "./hermes-work-admission";

const linuxTest = process.platform === "linux" || process.env.HERMES_MTLS_FORCE_TEST === "1" ? test : test.skip;
const manifest = JSON.parse(await Bun.file(new URL("../hermes/manifest.json", import.meta.url)).text());
const receiptDigest = "a".repeat(64);
let root = "";
let proofRoot = "";

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const item = value as Record<string, unknown>;
    return "{" + Object.keys(item).sort().map(k => JSON.stringify(k) + ":" + canonical(item[k])).join(",") + "}";
  }
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error("mTLS fixture canonical input");
  return raw;
}

function snapshot() {
  return { board: "software-factory", dispatch_enabled: false, integrity: "ok",
    schema_version: manifest.schema_version, schema_sha256: manifest.schema_sha256,
    status_counts: {}, source_commit: manifest.commit,
    full_schema_sha256: manifest.full_schema_sha256,
    full_schema_artifact_sha256: manifest.full_schema_artifact_sha256,
    work: [], work_admission: "held" };
}

function snapshotWithWork() {
  const taskId = "task-a";
  const factoryWorkId = "fw_" + createHash("sha256")
    .update("hermes\0software-factory\0" + taskId).digest("hex");
  return { ...snapshot(), status_counts: { ready: 1 }, work: [{
    schema: "factory-work/v1", factory_work_id: factoryWorkId, source: "hermes",
    external_references: { hermes_board: "software-factory", hermes_task_id: taskId },
    title: "Prepared task", description: "Synthetic held work", source_status: "ready",
    dispatch_eligible: false,
  }] };
}

function openssl(...args: string[]) {
  const result = spawnSync("openssl", args, { timeout: 15_000 });
  if (result.status !== 0) throw new Error("mTLS certificate fixture generation failed");
  return result.stdout;
}

function leaf(name: string, dns: string, eku: string) {
  openssl("req", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=" + dns,
    "-keyout", join(root, name + ".key"), "-out", join(root, name + ".csr"));
  writeFileSync(join(root, name + ".ext"),
    "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n"
    + "extendedKeyUsage=" + eku + "\nsubjectAltName=DNS:" + dns + "\n");
  openssl("x509", "-req", "-in", join(root, name + ".csr"), "-CA", join(root, "ca.crt"),
    "-CAkey", join(root, "ca.key"), "-CAcreateserial", "-days", "1",
    "-out", join(root, name + ".crt"), "-extfile", join(root, name + ".ext"));
}

beforeAll(() => {
  if (process.platform !== "linux" && process.env.HERMES_MTLS_FORCE_TEST !== "1") return;
  root = mkdtempSync(join(tmpdir(), "zo-task-hermes-mtls-ts-"));
  chmodSync(root, 0o700);
  openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-subj", "/CN=Fixture CA", "-keyout", join(root, "ca.key"),
    "-out", join(root, "ca.crt"));
  leaf("server", "reader.fixture.test", "serverAuth");
  leaf("client", "consumer.fixture.test", "clientAuth");
  chmodSync(join(root, "client.key"), 0o600);
  proofRoot = mkdtempSync(join(tmpdir(), "zo-task-hermes-proof-mtls-"));
  chmodSync(proofRoot, 0o700);
  openssl("genpkey", "-algorithm", "Ed25519", "-out", join(proofRoot, "reader.key"));
  chmodSync(join(proofRoot, "reader.key"), 0o600);
  openssl("pkey", "-in", join(proofRoot, "reader.key"), "-pubout",
    "-out", join(proofRoot, "reader.pub"));
});

afterAll(() => {
  if (root.startsWith(join(tmpdir(), "zo-task-hermes-mtls-ts-"))) {
    rmSync(root, { recursive: true, force: true });
  }
  if (proofRoot.startsWith(join(tmpdir(), "zo-task-hermes-proof-mtls-"))) {
    rmSync(proofRoot, { recursive: true, force: true });
  }
});

async function withServer(mode: "normal" | "replay" | "oversize", run: (port: number) => Promise<void>) {
  const ca = readFileSync(join(root, "ca.crt"));
  const cert = readFileSync(join(root, "server.crt"));
  const key = readFileSync(join(root, "server.key"));
  const clientDer = openssl("x509", "-in", join(root, "client.crt"), "-outform", "DER");
  const clientPin = createHash("sha256").update(clientDer).digest("hex");
  const clientSpki = new X509Certificate(clientDer).publicKey.export({ type: "spki", format: "der" });
  const clientSpkiPin = createHash("sha256").update(clientSpki).digest("hex");
  const server = createServer({ ca, cert, key, requestCert: true,
    rejectUnauthorized: true, minVersion: "TLSv1.3" }, socket => {
    const client = socket.getPeerCertificate(true);
    if (!socket.authorized || !Buffer.isBuffer(client.raw)
        || createHash("sha256").update(client.raw).digest("hex") !== clientPin
        || client.subjectaltname !== "DNS:consumer.fixture.test") {
      socket.destroy();
      return;
    }
    const observedSpki = new X509Certificate(client.raw).publicKey.export({ type: "spki", format: "der" });
    if (createHash("sha256").update(observedSpki).digest("hex") !== clientSpkiPin) {
      socket.destroy();
      return;
    }
    const chunks: Buffer[] = [];
    socket.on("data", chunk => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.length < 4 || data.length !== data.readUInt32BE(0) + 4) return;
      const request = JSON.parse(data.subarray(4).toString("utf8"));
      if (mode === "oversize") {
        const frame = Buffer.alloc(4);
        frame.writeUInt32BE(8_000_001);
        socket.end(frame);
        return;
      }
      const body = { cache_control: "no-store", dispatch_enabled: false,
        nonce: mode === "replay" ? "0".repeat(32) : request.nonce,
        receipt_digest: receiptDigest, schema: "held-reader-response/v1",
        snapshot: snapshot(), work_admission: "held" };
      // Python's fixture emits sorted canonical JSON; this twin does likewise.
      const payload = Buffer.from(canonical(body));
      const frame = Buffer.alloc(4 + payload.length);
      frame.writeUInt32BE(payload.length, 0);
      payload.copy(frame, 4);
      socket.end(frame);
    });
  });
  const sockets = new Set<import("node:net").Socket>();
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture listener missing");
    await run(address.port);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

async function withPythonServer(replay: boolean, run: (port: number) => Promise<void>,
  withProof = false, snapshotValue: unknown = snapshot()) {
  const script = fileURLToPath(new URL("../hermes/held_mtls_fixture.py", import.meta.url));
  const payload = join(root, "snapshot.json");
  const portFile = join(root, "port.txt");
  writeFileSync(payload, canonical(snapshotValue), { mode: 0o600 });
  const clientDer = openssl("x509", "-in", join(root, "client.crt"), "-outform", "DER");
  const clientPin = createHash("sha256").update(clientDer).digest("hex");
  const clientSpki = new X509Certificate(clientDer).publicKey.export({ type: "spki", format: "der" });
  const clientSpkiPin = createHash("sha256").update(clientSpki).digest("hex");
  const child = Bun.spawn(["python3", "-I", "-B", script, "serve-fixture",
    "--server-cert", join(root, "server.crt"), "--server-key", join(root, "server.key"),
    "--ca-cert", join(root, "ca.crt"), "--client-cert-sha256", clientPin,
    "--client-spki-sha256", clientSpkiPin,
    "--receipt-digest", receiptDigest, "--snapshot", payload,
    "--port-file", portFile, ...(replay ? ["--replay"] : []),
    ...(withProof ? ["--proof-private-key", join(proofRoot, "reader.key"),
      "--proof-public-key", join(proofRoot, "reader.pub"),
      "--full-schema-sha256", manifest.full_schema_sha256] : [])], {
    env: { ...process.env, FACTORY_STATE_MODE: "test" }, stdout: "pipe", stderr: "pipe",
  });
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(portFile); attempt++) await Bun.sleep(10);
    expect(existsSync(portFile)).toBe(true);
    const port = Number(readFileSync(portFile, "utf8"));
    expect(Number.isSafeInteger(port) && port > 0).toBe(true);
    await run(port);
    expect(await child.exited).toBe(0);
  } finally {
    child.kill();
    await child.exited;
    if (existsSync(portFile)) rmSync(portFile);
    if (existsSync(payload)) rmSync(payload);
  }
}

function input(port: number) {
  const der = openssl("x509", "-in", join(root, "server.crt"), "-outform", "DER");
  const spki = new X509Certificate(der).publicKey.export({ type: "spki", format: "der" });
  return { port, ca: readFileSync(join(root, "ca.crt")),
    clientCert: readFileSync(join(root, "client.crt")),
    clientKey: readFileSync(join(root, "client.key")),
    expectedServerDns: "reader.fixture.test",
    expectedServerCertSha256: createHash("sha256").update(der).digest("hex"),
    expectedServerSpkiSha256: createHash("sha256").update(spki).digest("hex"),
    receiptDigest,
    binding: { commit: manifest.commit, schema_version: manifest.schema_version,
      schema_sha256: manifest.schema_sha256,
      full_schema_sha256: manifest.full_schema_sha256,
      full_schema_artifact_sha256: manifest.full_schema_artifact_sha256 } };
}

linuxTest("mutual-TLS fixture consumer receives held work only", async () => {
  await withServer("normal", async port => {
    const work = await admitHeldHermesMutualTls(input(port));
    expect(work).toEqual([]);
  });
});

linuxTest("server pin, replay and oversized frame fail closed", async () => {
  await withServer("normal", async port => {
    await expect(admitHeldHermesMutualTls({ ...input(port), expectedServerCertSha256: "0".repeat(64) }))
      .rejects.toThrow("HERMES_MTLS_SERVER_IDENTITY");
  });
  await withServer("normal", async port => {
    await expect(admitHeldHermesMutualTls({ ...input(port), expectedServerSpkiSha256: "0".repeat(64) }))
      .rejects.toThrow("HERMES_MTLS_SERVER_SPKI");
  });
  await withServer("replay", async port => {
    await expect(admitHeldHermesMutualTls(input(port))).rejects.toThrow("HERMES_MTLS_RESPONSE");
  });
  await withServer("oversize", async port => {
    await expect(admitHeldHermesMutualTls(input(port))).rejects.toThrow("HERMES_MTLS_SIZE");
  });
});

linuxTest("production mode refuses fixture TLS before connecting", async () => {
  const prior = process.env.FACTORY_STATE_MODE;
  delete process.env.FACTORY_STATE_MODE;
  try {
    await expect(admitHeldHermesMutualTls(input(1))).rejects.toThrow("HERMES_MTLS_FIXTURE_ONLY");
  } finally {
    if (prior === undefined) delete process.env.FACTORY_STATE_MODE;
    else process.env.FACTORY_STATE_MODE = prior;
  }
});

test.skipIf(process.platform !== "linux")("Python mutual-TLS server reaches TypeScript held consumer", async () => {
  await withPythonServer(false, async port => {
    const work = await admitHeldHermesMutualTls(input(port));
    expect(work).toEqual([]);
  });
  await withPythonServer(true, async port => {
    await expect(admitHeldHermesMutualTls(input(port))).rejects.toThrow("HERMES_MTLS_RESPONSE");
  });
});

function proofBinding() {
  const publicKeyPem = readFileSync(join(proofRoot, "reader.pub"));
  const spki = openssl("pkey", "-pubin", "-in", join(proofRoot, "reader.pub"),
    "-outform", "DER");
  const clientSpki = new X509Certificate(readFileSync(join(root, "client.crt")))
    .publicKey.export({ type: "spki", format: "der" });
  return { publicKeyPem, expectedSpkiSha256: createHash("sha256").update(spki).digest("hex"),
    receiptDigest, boardGeneration: 1, dbGeneration: 1, issuerEpoch: 1,
    fullSchemaSha256: manifest.full_schema_sha256,
    clientSpkiSha256: createHash("sha256").update(clientSpki).digest("hex") };
}

test.skipIf(process.platform !== "linux")("Python mTLS response carries a verified held proof", async () => {
  await withPythonServer(false, async port => {
    const result = await admitHeldHermesMutualTlsWithProof(input(port), proofBinding());
    expect(result.work).toEqual([]);
    expect(result.proof.status).toBe("held_untrusted_snapshot");
    expect(result.proof.dispatch_eligible).toBe(false);
  }, true);
  await withPythonServer(false, async port => {
    await expect(admitHeldHermesMutualTlsWithProof(input(port),
      { ...proofBinding(), expectedSpkiSha256: "0".repeat(64) }))
      .rejects.toThrow("HERMES_PROOF_KEY_PIN");
  }, true);
  await withPythonServer(false, async port => {
    await expect(admitHeldHermesMutualTlsWithProof(input(port),
      { ...proofBinding(), dbGeneration: 2 }))
      .rejects.toThrow("HERMES_PROOF_FIELDS");
  }, true);
  await withPythonServer(false, async port => {
    await expect(admitHeldHermesMutualTlsWithProof(input(port),
      { ...proofBinding(), clientSpkiSha256: "0".repeat(64) }))
      .rejects.toThrow("HERMES_PROOF_CLIENT_PIN");
  }, true);
  await withPythonServer(false, async port => {
    await expect(admitHeldHermesMutualTlsWithProof(input(port), proofBinding()))
      .rejects.toThrow("HERMES_MTLS_RESPONSE");
  });
});

test.skipIf(process.platform !== "linux")("fixture CLI reaches the proof-bound held caller", async () => {
  await withPythonServer(false, async port => {
    const transport = input(port);
    const reader = proofBinding();
    writeFileSync(join(root, "reader.pub"), reader.publicKeyPem, { mode: 0o600 });
    const config = {
      schema: "hermes-held-mtls-fixture-client/v1", port,
      expected_server_dns: transport.expectedServerDns,
      expected_server_cert_sha256: transport.expectedServerCertSha256,
      expected_server_spki_sha256: transport.expectedServerSpkiSha256,
      expected_reader_spki_sha256: reader.expectedSpkiSha256,
      receipt_digest: receiptDigest,
      board_generation: reader.boardGeneration, db_generation: reader.dbGeneration,
      issuer_epoch: reader.issuerEpoch, client_spki_sha256: reader.clientSpkiSha256,
    };
    writeFileSync(join(root, "binding.json"), canonical(config), { mode: 0o600 });
    const script = fileURLToPath(new URL("./hermes-work-admission.ts", import.meta.url));
    const child = Bun.spawnSync([process.execPath, script, "--held-mtls-config",
      join(root, "binding.json")], {
      env: { ...process.env, FACTORY_STATE_MODE: "test" },
      stdout: "pipe", stderr: "pipe", timeout: 10_000,
    });
    expect(child.exitCode).toBe(0);
    const result = JSON.parse(Buffer.from(child.stdout).toString("utf8"));
    expect(result).toMatchObject({ schema: "factory-held-mtls-caller/v1",
      dispatch_eligible: false, claim_eligible: false,
      proof: { status: "held_untrusted_snapshot", dispatch_eligible: false } });
    expect(result.work).toHaveLength(1);
    expect(result.work[0]).toMatchObject({
      factory_work_id: snapshotWithWork().work[0]!.factory_work_id,
      source_status: "ready", admission: "held_untrusted_snapshot",
      dispatch_eligible: false,
    });
  }, true, snapshotWithWork());
});

test.skipIf(process.platform !== "linux")("fixture CLI rejects duplicate bindings before connecting", async () => {
  const candidate = mkdtempSync(join(tmpdir(), "zo-task-hermes-mtls-ts-"));
  try {
    chmodSync(candidate, 0o700);
    const path = join(candidate, "binding.json");
    writeFileSync(path, '{"schema":"a","schema":"b"}', { mode: 0o600 });
    await expect(admitHeldMutualTlsConfig(path)).rejects.toThrow("HERMES_MTLS_CONFIG");
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("fixture CLI rejects linked certificate material before connecting", async () => {
  const candidate = mkdtempSync(join(tmpdir(), "zo-task-hermes-mtls-ts-"));
  try {
    chmodSync(candidate, 0o700);
    const transport = input(1);
    const reader = proofBinding();
    const config = {
      schema: "hermes-held-mtls-fixture-client/v1", port: 1,
      expected_server_dns: transport.expectedServerDns,
      expected_server_cert_sha256: transport.expectedServerCertSha256,
      expected_server_spki_sha256: transport.expectedServerSpkiSha256,
      expected_reader_spki_sha256: reader.expectedSpkiSha256,
      receipt_digest: receiptDigest, board_generation: 1, db_generation: 1,
      issuer_epoch: 1, client_spki_sha256: reader.clientSpkiSha256,
    };
    const path = join(candidate, "binding.json");
    writeFileSync(path, canonical(config), { mode: 0o600 });
    symlinkSync(join(root, "ca.crt"), join(candidate, "ca.crt"));
    await expect(admitHeldMutualTlsConfig(path)).rejects.toThrow("HERMES_MTLS_CONFIG_FILE");
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "linux")("production mode refuses the fixture CLI before file access", async () => {
  const prior = process.env.FACTORY_STATE_MODE;
  delete process.env.FACTORY_STATE_MODE;
  try {
    await expect(admitHeldMutualTlsConfig("/tmp/does-not-exist/binding.json"))
      .rejects.toThrow("HERMES_MTLS_FIXTURE_ONLY");
  } finally {
    if (prior === undefined) delete process.env.FACTORY_STATE_MODE;
    else process.env.FACTORY_STATE_MODE = prior;
  }
});
