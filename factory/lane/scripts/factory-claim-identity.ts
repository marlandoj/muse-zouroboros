/** Pure v2 namespace reservation. It does not acquire, renew, or release a claim. */
import { createHash } from "node:crypto";
import type { HeldFactoryWork } from "./factory-work-contract";

export interface FactoryClaimSubjectV2 {
  schema: "factory-claim-subject/v2";
  provider: string;
  work_id: string;
}

const PROVIDER = /^[a-z][a-z0-9-]{0,31}$/;
const WORK_ID = /^[A-Za-z0-9_.:-]{1,160}$/;
const DIGEST_DOMAIN = "factory-claim-subject/v2\0";
const HERMES_TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HERMES_STATUSES = new Set(["triage", "todo", "scheduled", "ready", "running",
  "blocked", "review", "done", "archived"]);

function exactSubject(value: unknown): value is FactoryClaimSubjectV2 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return Object.keys(item).length === 3
    && Object.hasOwn(item, "schema") && Object.hasOwn(item, "provider") && Object.hasOwn(item, "work_id")
    && item.schema === "factory-claim-subject/v2"
    && typeof item.provider === "string" && PROVIDER.test(item.provider) && item.provider !== "linear"
    && typeof item.work_id === "string" && WORK_ID.test(item.work_id);
}

/** A new storage namespace; historical ticket-claims/<bare SHA-256> remain untouched. */
export function factoryClaimStorageKeyV2(subject: unknown): string {
  if (!exactSubject(subject)) throw new Error("FACTORY_CLAIM_SUBJECT");
  const bytes = `${DIGEST_DOMAIN}${subject.provider}\0${subject.work_id}`;
  return `fc2_${createHash("sha256").update(bytes, "utf8").digest("hex")}`;
}

/**
 * Bind held Hermes work to the separate v2 namespace. Recheck its normalized
 * shape, but require the caller to establish reader provenance separately.
 * This returns an identity only: it supplies no reader proof or claim permit.
 */
export function heldHermesClaimSubject(work: HeldFactoryWork): FactoryClaimSubjectV2 {
  if (!work || typeof work !== "object" || Array.isArray(work)) throw new Error("FACTORY_HELD_HERMES_WORK");
  const item = work as unknown as Record<string, unknown>;
  const expected = ["schema", "factory_work_id", "source", "external_references", "title",
    "description", "source_status", "dispatch_eligible", "admission"];
  if (Object.keys(item).length !== expected.length || expected.some(key => !Object.hasOwn(item, key))
    || item.schema !== "factory-work/v1" || item.source !== "hermes"
    || item.dispatch_eligible !== false || item.admission !== "held_untrusted_snapshot"
    || typeof item.title !== "string" || !item.title.trim()
    || item.title !== item.title.trim() || item.title.length > 512
    || typeof item.description !== "string"
    || Buffer.byteLength(item.description, "utf8") > 65_536
    || typeof item.source_status !== "string" || !HERMES_STATUSES.has(item.source_status)
    || !item.external_references || typeof item.external_references !== "object"
    || Array.isArray(item.external_references)) throw new Error("FACTORY_HELD_HERMES_WORK");
  const refs = item.external_references as Record<string, unknown>;
  if (Object.keys(refs).length !== 2 || refs.hermes_board !== "software-factory"
    || typeof refs.hermes_task_id !== "string" || !HERMES_TASK_ID.test(refs.hermes_task_id)) {
    throw new Error("FACTORY_HELD_HERMES_WORK");
  }
  const expectedId = `fw_${createHash("sha256")
    .update(`hermes\0software-factory\0${refs.hermes_task_id}`, "utf8").digest("hex")}`;
  if (item.factory_work_id !== expectedId) throw new Error("FACTORY_HELD_HERMES_IDENTITY");
  return { schema: "factory-claim-subject/v2", provider: "hermes", work_id: expectedId };
}
