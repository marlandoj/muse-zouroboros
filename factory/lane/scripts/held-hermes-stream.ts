/** Fixture-only authenticated Unix-socket held reader. No production caller. */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { lstatSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { admitHeldHermesEnvelope, type HeldSnapshotBinding } from "./held-hermes-http";
import type { HeldFactoryWork } from "./factory-work-contract";

const MAX_FRAME = 8_000_000;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("HERMES_STREAM_CANONICAL");
  return serialized;
}

function fixtureSocket(path: string, expectedUid: number, expectedGid: number): void {
  if (process.env.FACTORY_STATE_MODE !== "test") throw new Error("HERMES_STREAM_FIXTURE_ONLY");
  if (!/^\/tmp\/zo-task-hermes-stream-[^/]+\/reader\.sock$/.test(path)
      || !Number.isSafeInteger(expectedUid) || expectedUid < 0
      || !Number.isSafeInteger(expectedGid) || expectedGid < 0) throw new Error("HERMES_STREAM_TARGET");
  const parent = lstatSync(dirname(path));
  const socket = lstatSync(path);
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== expectedUid
      || parent.gid !== expectedGid || (parent.mode & 0o777) !== 0o710
      || !socket.isSocket() || socket.isSymbolicLink() || socket.uid !== expectedUid
      || socket.gid !== expectedGid || (socket.mode & 0o777) !== 0o660) {
    throw new Error("HERMES_STREAM_PEER_PATH");
  }
}

async function exchange(path: string, request: object): Promise<Buffer> {
  const bytes = Buffer.from(canonical(request), "utf8");
  if (bytes.byteLength > 512) throw new Error("HERMES_STREAM_REQUEST_SIZE");
  const frame = Buffer.allocUnsafe(4 + bytes.byteLength);
  frame.writeUInt32BE(bytes.byteLength, 0);
  bytes.copy(frame, 4);
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path });
    const deadline = setTimeout(() => fail(new Error("HERMES_STREAM_TIMEOUT")), 5000);
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const header = Buffer.alloc(4);
    let headerBytes = 0;
    let expectedLength: number | null = null;
    function fail(error: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      reject(error);
    }
    socket.on("connect", () => socket.write(frame));
    socket.on("data", (chunk: Buffer) => {
      if (headerBytes < 4) {
        const take = Math.min(4 - headerBytes, chunk.byteLength);
        chunk.copy(header, headerBytes, 0, take);
        headerBytes += take;
        if (headerBytes === 4) {
          expectedLength = header.readUInt32BE(0);
          if (expectedLength === 0 || expectedLength > MAX_FRAME) return fail(new Error("HERMES_STREAM_SIZE"));
        }
      }
      total += chunk.byteLength;
      if (total > MAX_FRAME + 4) return fail(new Error("HERMES_STREAM_SIZE"));
      chunks.push(chunk);
      if (expectedLength !== null && total > expectedLength + 4) fail(new Error("HERMES_STREAM_SIZE"));
    });
    socket.on("end", () => {
      if (settled) return;
      if (expectedLength === null || total !== expectedLength + 4) {
        return fail(new Error("HERMES_STREAM_TRUNCATED"));
      }
      settled = true;
      clearTimeout(deadline);
      const received = Buffer.concat(chunks, total);
      resolve(received.subarray(4));
    });
    socket.on("error", () => fail(new Error("HERMES_STREAM_CONNECTION")));
  });
}

/** The reader UID/path check and HMAC prove a fixture peer; installed authority is separate. */
export async function admitHeldHermesStream(input: {
  socketPath: string;
  expectedReaderUid: number;
  expectedReaderGid: number;
  receiptDigest: string;
  fixtureSecret: Uint8Array;
  binding: HeldSnapshotBinding;
}): Promise<HeldFactoryWork[]> {
  fixtureSocket(input.socketPath, input.expectedReaderUid, input.expectedReaderGid);
  if (!HEX64.test(input.receiptDigest) || input.fixtureSecret.byteLength !== 32) {
    throw new Error("HERMES_STREAM_BINDING");
  }
  const nonce = randomBytes(16).toString("hex");
  const raw = await exchange(input.socketPath, {
    schema: "held-reader-request/v1", nonce, receipt_digest: input.receiptDigest,
  });
  const response: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  if (!record(response) || !exact(response, ["body", "signature"]) || !record(response.body)
      || !exact(response.body, ["schema", "nonce", "receipt_digest", "cache_control", "snapshot"])
      || response.body.schema !== "held-reader-response/v1"
      || typeof response.body.nonce !== "string" || !HEX32.test(response.body.nonce)
      || response.body.nonce !== nonce || response.body.receipt_digest !== input.receiptDigest
      || response.body.cache_control !== "no-store" || typeof response.signature !== "string"
      || !HEX64.test(response.signature)) throw new Error("HERMES_STREAM_RESPONSE");
  const signed = Buffer.from(response.signature, "hex");
  const expected = createHmac("sha256", input.fixtureSecret).update(canonical(response.body)).digest();
  if (!timingSafeEqual(signed, expected)) throw new Error("HERMES_STREAM_SIGNATURE");
  return admitHeldHermesEnvelope(response.body.snapshot, input.binding);
}
