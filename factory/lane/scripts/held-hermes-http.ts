/** Fixture-only HTTP admission of a held Hermes snapshot. This authenticates no caller. */
import { admitHeldHermesWork, type HeldFactoryWork } from "./factory-work-contract";

export interface HeldSnapshotBinding {
  commit: string;
  schema_version: number;
  schema_sha256: string;
  full_schema_artifact_sha256: string;
  full_schema_sha256: string;
}

const MAX_RESPONSE_BYTES = 8_000_000;
const STATUSES = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"]);
const KEYS = ["board", "dispatch_enabled", "integrity", "schema_version", "schema_sha256", "status_counts", "source_commit", "full_schema_sha256", "full_schema_artifact_sha256", "work", "work_admission"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export async function admitHeldHermesHttp(url: string, binding: HeldSnapshotBinding): Promise<HeldFactoryWork[]> {
  if (process.env.FACTORY_STATE_MODE !== "test") throw new Error("HERMES_HTTP_FIXTURE_ONLY");
  const target = new URL(url);
  if (target.protocol !== "http:" || target.hostname !== "127.0.0.1" || !target.port ||
      target.pathname !== "/held-work" || target.username || target.password || target.search || target.hash) {
    throw new Error("HERMES_HTTP_TARGET");
  }
  const response = await fetch(target, { redirect: "error", signal: AbortSignal.timeout(5000) });
  if (response.status !== 200 || response.headers.get("content-type")?.split(";", 1)[0].trim() !== "application/json" || !response.body) {
    throw new Error("HERMES_HTTP_RESPONSE");
  }
  const length = response.headers.get("content-length");
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_RESPONSE_BYTES)) throw new Error("HERMES_HTTP_SIZE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new Error("HERMES_HTTP_SIZE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return admitHeldHermesEnvelope(input, binding);
}

/** Shared fixture envelope validation for HTTP and authenticated stream tests. */
export async function admitHeldHermesEnvelope(input: unknown, binding: HeldSnapshotBinding): Promise<HeldFactoryWork[]> {
  if (!record(input) || !exactKeys(input, KEYS) || input.board !== "software-factory" ||
      input.dispatch_enabled !== false || input.integrity !== "ok" || input.work_admission !== "held" ||
      input.schema_version !== binding.schema_version || input.schema_sha256 !== binding.schema_sha256 ||
      input.full_schema_sha256 !== binding.full_schema_sha256 ||
      input.full_schema_artifact_sha256 !== binding.full_schema_artifact_sha256 ||
      input.source_commit !== binding.commit || !record(input.status_counts)) {
    throw new Error("HERMES_HTTP_BINDING");
  }
  const held = await admitHeldHermesWork(input.work);
  const observedCounts = new Map<string, number>();
  for (const item of held) {
    observedCounts.set(item.source_status, (observedCounts.get(item.source_status) ?? 0) + 1);
  }
  let count = 0;
  for (const [status, value] of Object.entries(input.status_counts)) {
    if (!STATUSES.has(status) || !Number.isSafeInteger(value) || (value as number) < 0) throw new Error("HERMES_HTTP_COUNTS");
    if ((observedCounts.get(status) ?? 0) !== value) throw new Error("HERMES_HTTP_COUNTS");
    count += value as number;
  }
  if (count !== held.length) throw new Error("HERMES_HTTP_COUNTS");
  return held;
}
