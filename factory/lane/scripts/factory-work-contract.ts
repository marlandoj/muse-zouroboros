/** Read-only admission for Hermes work projected from a supplied snapshot.
 *
 * This boundary deliberately cannot produce an IntakeTicket or a dispatch
 * result. The installed reader, board authority, and execution gates are not
 * qualified yet, so every accepted item stays held.
 */

export interface HeldFactoryWork {
  schema: "factory-work/v1";
  factory_work_id: string;
  source: "hermes";
  external_references: { hermes_board: "software-factory"; hermes_task_id: string };
  title: string;
  description: string;
  source_status: string;
  dispatch_eligible: false;
  admission: "held_untrusted_snapshot";
}

const STATUSES = new Set(["triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived"]);
const TASK_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const WORK_ID = /^fw_[0-9a-f]{64}$/;
const MAX_ITEMS = 1000;
const MAX_DESCRIPTION_BYTES = 65_536;
const MAX_TOTAL_DESCRIPTION_BYTES = 2_000_000;
const encoder = new TextEncoder();

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep the existing Linear conveyor source-specific until all effects are ported. */
export function assertLegacyLinearTicket(value: unknown): void {
  if (!object(value) || "factory_work_id" in value || "source" in value || "dispatch_eligible" in value ||
      typeof value.linear_id !== "string" || !value.linear_id.trim() ||
      typeof value.identifier !== "string" || !value.identifier.trim() ||
      typeof value.title !== "string" || typeof value.description !== "string") {
    throw new Error("LINEAR_TICKET_REQUIRED");
  }
}

async function hermesWorkId(taskId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`hermes\0software-factory\0${taskId}`));
  return `fw_${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("")}`;
}

/** Validate the Python projection and retain its closed-dispatch boundary. */
export async function admitHeldHermesWork(input: unknown): Promise<HeldFactoryWork[]> {
  if (!Array.isArray(input) || input.length > MAX_ITEMS) throw new Error("FACTORY_WORK_BATCH");
  const seen = new Set<string>();
  const result: HeldFactoryWork[] = [];
  let totalDescriptionBytes = 0;
  for (const item of input) {
    if (!object(item) || !exactKeys(item, ["schema", "factory_work_id", "source", "external_references", "title", "description", "source_status", "dispatch_eligible"])) {
      throw new Error("FACTORY_WORK_SHAPE");
    }
    const refs = item.external_references;
    if (!object(refs) || !exactKeys(refs, ["hermes_board", "hermes_task_id"]) || refs.hermes_board !== "software-factory" || typeof refs.hermes_task_id !== "string" || !TASK_ID.test(refs.hermes_task_id)) {
      throw new Error("FACTORY_WORK_REFERENCE");
    }
    if (item.schema !== "factory-work/v1" || item.source !== "hermes" || item.dispatch_eligible !== false || typeof item.factory_work_id !== "string" || !WORK_ID.test(item.factory_work_id)) {
      throw new Error("FACTORY_WORK_AUTHORITY");
    }
    if (item.factory_work_id !== await hermesWorkId(refs.hermes_task_id)) throw new Error("FACTORY_WORK_IDENTITY");
    if (seen.has(item.factory_work_id)) throw new Error("FACTORY_WORK_DUPLICATE");
    seen.add(item.factory_work_id);
    if (typeof item.title !== "string" || !item.title.trim() || item.title.length > 512 || typeof item.description !== "string" || typeof item.source_status !== "string" || !STATUSES.has(item.source_status)) {
      throw new Error("FACTORY_WORK_CONTENT");
    }
    const bodyBytes = encoder.encode(item.description).byteLength;
    totalDescriptionBytes += bodyBytes;
    if (bodyBytes > MAX_DESCRIPTION_BYTES || totalDescriptionBytes > MAX_TOTAL_DESCRIPTION_BYTES) throw new Error("FACTORY_WORK_SIZE");
    result.push({
      schema: "factory-work/v1",
      factory_work_id: item.factory_work_id,
      source: "hermes",
      external_references: { hermes_board: "software-factory", hermes_task_id: refs.hermes_task_id },
      title: item.title.trim(),
      description: item.description,
      source_status: item.source_status as string,
      dispatch_eligible: false,
      admission: "held_untrusted_snapshot",
    });
  }
  return result;
}
