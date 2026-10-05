#!/usr/bin/env bun
/** Validate supplied Hermes work or fixture transport; never claim or dispatch. */
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { admitHeldHermesWork } from "./factory-work-contract";
import { admitHeldHermesHttp } from "./held-hermes-http";
import { admitHeldHermesMutualTlsWithProof } from "./held-hermes-mtls";

// Python's default JSON encoding expands non-ASCII text; its input is capped at 2 MB.
const MAX_INPUT_BYTES = 8_000_000;
const HEX64 = /^[0-9a-f]{64}$/;

function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map(key => JSON.stringify(key) + ":" + canonical(record[key])).join(",") + "}";
  }
  const raw = JSON.stringify(value);
  if (raw === undefined) throw new Error("HERMES_MTLS_CONFIG");
  return raw;
}

/** Consume only a private, disposable certificate fixture with external pins. */
export async function admitHeldMutualTlsConfig(path: string) {
  if (process.env.FACTORY_STATE_MODE !== "test" || process.platform !== "linux") {
    throw new Error("HERMES_MTLS_FIXTURE_ONLY");
  }
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("HERMES_MTLS_FIXTURE_ONLY");
  const root = dirname(path);
  if (!isAbsolute(path) || path.includes("..") || basename(path) !== "binding.json"
      || dirname(root) !== tmpdir() || !basename(root).startsWith("zo-task-hermes-mtls-ts-")) {
    throw new Error("HERMES_MTLS_CONFIG_ROOT");
  }
  const rootStat = lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.uid !== uid || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error("HERMES_MTLS_CONFIG_ROOT");
  }
  function fixtureFile(name: string, privateFile = false): Buffer {
    const file = root + "/" + name;
    let fd: number;
    try {
      fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch {
      throw new Error("HERMES_MTLS_CONFIG_FILE");
    }
    try {
      const before = fstatSync(fd);
      if (!before.isFile() || before.uid !== uid || before.nlink !== 1
          || before.size < 1 || before.size > 16_384
          || (before.mode & (privateFile ? 0o077 : 0o022)) !== 0) {
        throw new Error("HERMES_MTLS_CONFIG_FILE");
      }
      const raw = readFileSync(fd);
      const after = fstatSync(fd);
      if (raw.length !== before.size || before.dev !== after.dev
          || before.ino !== after.ino || before.ctimeMs !== after.ctimeMs
          || before.size !== after.size) throw new Error("HERMES_MTLS_CONFIG_FILE");
      return raw;
    } finally {
      closeSync(fd);
    }
  }
  const raw = fixtureFile("binding.json", true);
  if (raw.length > 4096) throw new Error("HERMES_MTLS_CONFIG");
  const config: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  const keys = ["schema", "port", "expected_server_dns", "expected_server_cert_sha256",
    "expected_server_spki_sha256", "expected_reader_spki_sha256", "receipt_digest",
    "board_generation", "db_generation", "issuer_epoch", "client_spki_sha256"];
  if (!config || typeof config !== "object" || Array.isArray(config)
      || Object.keys(config).length !== keys.length
      || keys.some(key => !Object.hasOwn(config, key))
      || raw.toString("utf8") !== canonical(config)) throw new Error("HERMES_MTLS_CONFIG");
  const binding = config as Record<string, unknown>;
  if (binding.schema !== "hermes-held-mtls-fixture-client/v1"
      || !Number.isSafeInteger(binding.port) || (binding.port as number) < 1 || (binding.port as number) > 65535
      || typeof binding.expected_server_dns !== "string" || !/^[a-z0-9.-]+$/.test(binding.expected_server_dns)
      || ["expected_server_cert_sha256", "expected_server_spki_sha256",
        "expected_reader_spki_sha256", "receipt_digest", "client_spki_sha256"].some(
        key => typeof binding[key] !== "string" || !HEX64.test(binding[key] as string))
      || ["board_generation", "db_generation", "issuer_epoch"].some(
        key => !Number.isSafeInteger(binding[key]) || (binding[key] as number) < 1)) {
    throw new Error("HERMES_MTLS_CONFIG");
  }
  const manifest = JSON.parse(readFileSync(new URL("../hermes/manifest.json", import.meta.url), "utf8"));
  const result = await admitHeldHermesMutualTlsWithProof({
    port: binding.port as number,
    ca: fixtureFile("ca.crt"), clientCert: fixtureFile("client.crt"),
    clientKey: fixtureFile("client.key", true),
    expectedServerDns: binding.expected_server_dns as string,
    expectedServerCertSha256: binding.expected_server_cert_sha256 as string,
    expectedServerSpkiSha256: binding.expected_server_spki_sha256 as string,
    receiptDigest: binding.receipt_digest as string, binding: manifest,
  }, {
    publicKeyPem: fixtureFile("reader.pub"),
    expectedSpkiSha256: binding.expected_reader_spki_sha256 as string,
    receiptDigest: binding.receipt_digest as string,
    boardGeneration: binding.board_generation as number,
    dbGeneration: binding.db_generation as number,
    issuerEpoch: binding.issuer_epoch as number,
    fullSchemaSha256: manifest.full_schema_sha256,
    clientSpkiSha256: binding.client_spki_sha256 as string,
  });
  return { schema: "factory-held-mtls-caller/v1" as const,
    work: result.work, proof: result.proof,
    dispatch_eligible: false as const, claim_eligible: false as const };
}

export async function admitSuppliedWorkFile(path: string) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > MAX_INPUT_BYTES) throw new Error("FACTORY_WORK_FILE");
  const raw = readFileSync(path);
  if (raw.byteLength > MAX_INPUT_BYTES) throw new Error("FACTORY_WORK_FILE");
  return admitHeldHermesWork(JSON.parse(raw.toString("utf8")));
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { work: { type: "string" }, "held-url": { type: "string" },
    "held-mtls-config": { type: "string" } } });
  if ([values.work, values["held-url"], values["held-mtls-config"]].filter(Boolean).length !== 1) {
    throw new Error("choose one held work source");
  }
  const held = values["held-mtls-config"]
    ? await admitHeldMutualTlsConfig(values["held-mtls-config"])
    : values.work
    ? await admitSuppliedWorkFile(values.work)
    : await admitHeldHermesHttp(values["held-url"]!, JSON.parse(readFileSync(new URL("../hermes/manifest.json", import.meta.url), "utf8")));
  process.stdout.write(JSON.stringify(held, null, 2) + "\n");
}
