import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { admitHeldHermesStream } from "./held-hermes-stream";

const linuxTest = process.platform === "linux" ? test : test.skip;
const binding = JSON.parse(await Bun.file(new URL("../hermes/manifest.json", import.meta.url)).text());
const proof = "a".repeat(64);

async function envelope() {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("hermes\0software-factory\0task-1"));
  const workId = `fw_${Buffer.from(digest).toString("hex")}`;
  return {
    board: "software-factory", dispatch_enabled: false, integrity: "ok",
    schema_version: binding.schema_version, schema_sha256: binding.schema_sha256,
    status_counts: { scheduled: 1 }, source_commit: binding.commit,
    full_schema_sha256: binding.full_schema_sha256,
    full_schema_artifact_sha256: binding.full_schema_artifact_sha256,
    work: [{ schema: "factory-work/v1", factory_work_id: workId, source: "hermes",
      external_references: { hermes_board: "software-factory", hermes_task_id: "task-1" },
      title: "Build", description: "Criteria", source_status: "scheduled", dispatch_eligible: false }],
    work_admission: "held",
  };
}

async function withServer(flags: string[], run: (input: {
  socketPath: string; expectedReaderUid: number; expectedReaderGid: number; receiptDigest: string;
  fixtureSecret: Uint8Array; binding: typeof binding;
}) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "zo-task-hermes-stream-"));
  chmodSync(root, 0o710);
  const socketPath = join(root, "reader.sock");
  const payload = join(root, "payload.json");
  writeFileSync(payload, JSON.stringify(await envelope()));
  const secret = randomBytes(32);
  const uid = process.getuid!();
  const gid = process.getgid!();
  const script = fileURLToPath(new URL("../hermes/held_stream_transport.py", import.meta.url));
  const child = Bun.spawn(["python3", "-I", "-B", script, "serve-fixture", "--socket", socketPath,
    "--payload", payload, "--receipt-digest", proof, "--client-uid", String(uid),
    "--client-gid", String(gid), ...flags], {
    env: { ...process.env, FACTORY_STATE_MODE: "test", HERMES_STREAM_FIXTURE_SECRET: secret.toString("hex") },
    stdout: "pipe", stderr: "pipe",
  });
  try {
    for (let attempt = 0; attempt < 200 && !existsSync(socketPath); attempt++) await Bun.sleep(10);
    expect(existsSync(socketPath)).toBe(true);
    await run({ socketPath, expectedReaderUid: uid, expectedReaderGid: gid,
      receiptDigest: proof, fixtureSecret: secret, binding });
  } finally {
    child.kill();
    await child.exited;
    if (root.startsWith(join(tmpdir(), "zo-task-hermes-stream-"))) rmSync(root, { recursive: true, force: true });
  }
}

linuxTest("peer-checked held stream reaches the TypeScript consumer without dispatch", async () => {
  await withServer([], async input => {
    const [work] = await admitHeldHermesStream(input);
    expect(work.source_status).toBe("scheduled");
    expect(work.admission).toBe("held_untrusted_snapshot");
    expect(work.dispatch_eligible).toBe(false);
  });
});

linuxTest("reader UID, receipt proof, nonce replay, and oversized frame fail closed", async () => {
  await withServer([], async input => {
    await expect(admitHeldHermesStream({ ...input, expectedReaderUid: input.expectedReaderUid + 1 }))
      .rejects.toThrow("HERMES_STREAM_PEER_PATH");
  });
  await withServer([], async input => {
    await expect(admitHeldHermesStream({ ...input, receiptDigest: "b".repeat(64) }))
      .rejects.toThrow(/HERMES_STREAM_(CONNECTION|TRUNCATED)/);
  });
  await withServer(["--replay"], async input => {
    await expect(admitHeldHermesStream(input)).rejects.toThrow("HERMES_STREAM_RESPONSE");
  });
  await withServer(["--bad-length"], async input => {
    await expect(admitHeldHermesStream(input)).rejects.toThrow("HERMES_STREAM_SIZE");
  });
});

linuxTest("production mode refuses the fixture consumer before opening transport", async () => {
  const prior = process.env.FACTORY_STATE_MODE;
  delete process.env.FACTORY_STATE_MODE;
  try {
    await expect(admitHeldHermesStream({
      socketPath: "/tmp/zo-task-hermes-stream-missing/reader.sock",
      expectedReaderUid: process.getuid!(), expectedReaderGid: process.getgid!(), receiptDigest: proof,
      fixtureSecret: randomBytes(32), binding,
    })).rejects.toThrow("HERMES_STREAM_FIXTURE_ONLY");
  } finally {
    if (prior === undefined) delete process.env.FACTORY_STATE_MODE;
    else process.env.FACTORY_STATE_MODE = prior;
  }
});
