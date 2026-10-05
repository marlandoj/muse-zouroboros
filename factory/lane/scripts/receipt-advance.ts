#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * FH-13 (P1-10) — Advance shipping receipts to a terminal state.
 *
 * ZOU-933's shipping receipt read `succeeded` with outcome `merge_queued` while
 * GitHub said PR #400 was merged, the journal recorded
 * `reconcile.execution-merged`, Linear said Done, and the execution JSON still
 * said `pr_ready` with `target_reached: false`. Every store was honest about
 * what it had been told. None of them was told the rest.
 *
 * `merge_queued` is a *request*, not an outcome. Nothing advanced it once the
 * merge actually landed, so the receipt froze at the moment the factory stopped
 * paying attention.
 *
 * This module closes the loop using the FH-05 projection as the authority —
 * the same source FH-11 uses for promotion evidence, so the two cannot disagree
 * about whether something merged. It advances the receipt and the execution
 * lifecycle together, and it is idempotent: re-running against an already
 * advanced receipt is a no-op.
 *
 * It never advances *past* the evidence. A receipt reaches `merged` when the
 * projection proves merged, and `deployed`/`accepted` only when the FH-14
 * handoff contract is satisfied. Optimistically marking a project accepted is
 * the failure this whole program exists to stop.
 *
 * Reachability: `post-merge-reconcile.ts` calls `advanceReceipts()` after
 * recording merge evidence.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { evaluateHandoff, type HandoffEvidence } from "./handoff-contract";
import { collectDeliveryEvidence, type DeliveryEvidenceResult } from "./delivery-evidence";

const PROJECT_DIR = join(import.meta.dir, "..");

/** Terminal for shipping purposes: the merge landed and was observed. */
export type TerminalOutcome = "merged" | "deployed" | "accepted";

export interface ReceiptAdvance {
  execution_id: string;
  identifier: string;
  from: string | null;
  to: TerminalOutcome | null;
  advanced: boolean;
  reason: string;
}

export interface AdvanceReport {
  ok: boolean;
  degraded_reason: string | null;
  evaluated: number;
  advanced: number;
  results: ReceiptAdvance[];
}

interface ReceiptLike {
  execution_id: string;
  identifier: string;
  status?: string;
  outcome?: string | null;
  pr_number?: number | null;
  [key: string]: unknown;
}

function atomicWrite(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

export function readReceipts(base = PROJECT_DIR): Array<{ path: string; receipt: ReceiptLike }> {
  const dir = factoryStatePathForProject(base);
  if (!existsSync(dir)) return [];
  const rows: Array<{ path: string; receipt: ReceiptLike }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.startsWith("shipping-request-") || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as ReceiptLike;
      if (parsed && typeof parsed.execution_id === "string") rows.push({ path, receipt: parsed });
    } catch {
      // One corrupt receipt must not stop the rest from advancing.
    }
  }
  return rows;
}

/**
 * Decide the terminal outcome for one receipt. Pure — the policy, not the file
 * format, is what the tests pin.
 *
 * `handoff` is optional: without it a receipt can reach `merged` but never
 * `deployed` or `accepted`, because those claims need the FH-14 evidence.
 */
export function decideAdvance(
  receipt: Pick<ReceiptLike, "execution_id" | "identifier" | "outcome" | "status">,
  merged: boolean,
  handoff?: HandoffEvidence | null,
): ReceiptAdvance {
  const from = receipt.outcome ?? null;
  const base = {
    execution_id: receipt.execution_id,
    identifier: receipt.identifier,
    from,
  };

  if (from === "accepted" || from === "deployed") {
    return { ...base, to: from as TerminalOutcome, advanced: false, reason: `already terminal (${from})` };
  }
  if (!merged) {
    return { ...base, to: null, advanced: false, reason: "no merge evidence for this execution" };
  }

  if (handoff) {
    const verdict = evaluateHandoff(receipt.identifier, handoff);
    if (verdict.ok) {
      return { ...base, to: "accepted", advanced: from !== "accepted", reason: "merged and handoff contract satisfied" };
    }
    // Merged and deployed, but the handoff is incomplete — say so rather than
    // rounding up to accepted.
    const deployed = verdict.results.find((item) => item.obligation === "deployment_commit")?.status === "satisfied"
      && verdict.results.find((item) => item.obligation === "service_health")?.status === "satisfied";
    return {
      ...base,
      to: deployed ? "deployed" : "merged",
      advanced: from !== (deployed ? "deployed" : "merged"),
      reason: `merged; ${verdict.blocking_summary}`,
    };
  }

  return {
    ...base,
    to: "merged",
    advanced: from !== "merged",
    reason: "merge evidence recorded; handoff evidence not supplied",
  };
}

export interface AdvanceOptions {
  base?: string;
  /** Injected for tests; defaults to the live projection. */
  evidence?: DeliveryEvidenceResult;
  /** Per-identifier handoff evidence, when available. */
  handoff?: ReadonlyMap<string, HandoffEvidence>;
  /** When false, compute the plan without writing. */
  apply?: boolean;
}

export function advanceReceipts(options: AdvanceOptions = {}): AdvanceReport {
  const base = options.base ?? PROJECT_DIR;
  const evidence = options.evidence ?? collectDeliveryEvidence({ base });

  if (!evidence.ok) {
    // Fail closed: without trustworthy merge evidence, advancing a receipt to
    // a terminal state would assert something unproven.
    return {
      ok: false,
      degraded_reason: evidence.degraded_reason,
      evaluated: 0,
      advanced: 0,
      results: [],
    };
  }

  const results: ReceiptAdvance[] = [];
  let advanced = 0;

  for (const { path, receipt } of readReceipts(base)) {
    const proof = evidence.byTwin.get(receipt.identifier);
    const decision = decideAdvance(receipt, Boolean(proof), options.handoff?.get(receipt.identifier) ?? null);
    results.push(decision);
    if (!decision.advanced || !decision.to) continue;

    advanced++;
    if (options.apply === false) continue;
    atomicWrite(path, {
      ...receipt,
      outcome: decision.to,
      status: "succeeded",
      terminal_reason: decision.reason,
      terminal_evidence: proof
        ? { execution_id: proof.execution_id, state: proof.state, observed_at: proof.observed_at }
        : null,
    });
  }

  return { ok: true, degraded_reason: null, evaluated: results.length, advanced, results };
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { json: { type: "boolean" }, "dry-run": { type: "boolean" } },
    strict: false,
  });

  const report = advanceReceipts({ apply: !values["dry-run"] });
  if (values.json) console.log(JSON.stringify(report));
  else if (!report.ok) console.error(`receipt advance DEGRADED — ${report.degraded_reason}`);
  else {
    for (const item of report.results) {
      console.log(`${item.identifier} ${item.from ?? "none"} → ${item.to ?? "unchanged"}: ${item.reason}`);
    }
    console.log(`${report.advanced}/${report.evaluated} receipt(s) advanced${values["dry-run"] ? " (dry run)" : ""}`);
  }
  process.exit(report.ok ? 0 : 1);
}
