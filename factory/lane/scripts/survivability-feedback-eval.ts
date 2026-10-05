#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { autoLaneEligibleInputs } from "./risk-classifier";
import { dedupeResolvedByTicketAction, readLedger, type LedgerEntry } from "./approval-ledger";
import {
  blendReputation,
  computeSurvivability,
  loadSurvivabilityConfig,
  readFateLedger,
  sf012Flags,
  type FateRecord,
  type SurvivabilityConfig,
} from "./survivability-core";

export interface FeedbackEvalOptions {
  holdoutPercent?: number;
  minHoldout?: number;
  minApprovalTickets?: number;
  approvalRateFloor?: number;
  holdoutSelector?: (ticketId: string) => boolean;
}

export interface FeedbackEvalReport {
  status: "insufficient_data" | "advisory" | "promotion_eligible";
  promotion_eligible: boolean;
  split: "ticket-hash-v1" | "injected";
  train_tickets: number;
  holdout_tickets: number;
  baseline_errors: number;
  candidate_errors: number;
  changed_decisions: number;
  valid_work_suppressed: number;
  mature_survivability_prs: number;
  reasons: string[];
}

function defaultHoldout(ticketId: string, percent: number): boolean {
  const byte = Number.parseInt(createHash("sha256").update(ticketId).digest("hex").slice(0, 2), 16);
  return byte < Math.round((percent / 100) * 256);
}

export function evaluateSurvivabilityFeedback(
  entries: Map<string, LedgerEntry>,
  fates: FateRecord[],
  config: SurvivabilityConfig,
  options: FeedbackEvalOptions = {},
): FeedbackEvalReport {
  const holdoutPercent = options.holdoutPercent ?? 20;
  const minHoldout = options.minHoldout ?? 5;
  const minApprovalTickets = options.minApprovalTickets ?? 8;
  const approvalRateFloor = options.approvalRateFloor ?? 0.9;
  const selector = options.holdoutSelector ?? ((ticketId: string) => defaultHoldout(ticketId, holdoutPercent));
  const resolved = [...dedupeResolvedByTicketAction(entries).values()].filter(
    (entry) => entry.operator_verdict !== "pending" && entry.verdict.inputs,
  );
  const holdoutIds = new Set(resolved.filter((entry) => selector(entry.verdict.ticket_id)).map((entry) => entry.verdict.ticket_id));
  const train = resolved.filter((entry) => !holdoutIds.has(entry.verdict.ticket_id));
  const holdout = resolved.filter(
    (entry) => holdoutIds.has(entry.verdict.ticket_id) && autoLaneEligibleInputs(entry.verdict.inputs!),
  );

  const trainByArchetype = new Map<string, { approved: number; total: number }>();
  for (const entry of train) {
    const archetype = entry.verdict.inputs!.archetype;
    const bucket = trainByArchetype.get(archetype) ?? { approved: 0, total: 0 };
    bucket.total++;
    if (entry.operator_verdict === "approved") bucket.approved++;
    trainByArchetype.set(archetype, bucket);
  }

  const survivability = computeSurvivability(fates, config);
  let baselineErrors = 0;
  let candidateErrors = 0;
  let changed = 0;
  let suppressed = 0;
  for (const entry of holdout) {
    const archetype = entry.verdict.inputs!.archetype;
    const trainBucket = trainByArchetype.get(archetype) ?? { approved: 0, total: 0 };
    const approvalRate = trainBucket.total > 0 ? trainBucket.approved / trainBucket.total : null;
    const baselineAllow = trainBucket.total >= minApprovalTickets && approvalRate !== null && approvalRate >= approvalRateFloor;
    const survivalBucket = survivability.by_archetype[archetype] ?? {
      n: 0,
      survived: 0,
      reverted: 0,
      hotfixed: 0,
      survival_rate: null,
      insufficient_data: true,
    };
    const blend = blendReputation({ rate: approvalRate, resolved: trainBucket.total }, survivalBucket, config);
    const candidateAllow = baselineAllow && !blend.cold_start && blend.blended !== null && blend.blended >= approvalRateFloor;
    const approved = entry.operator_verdict === "approved";
    if (baselineAllow !== approved) baselineErrors++;
    if (candidateAllow !== approved) candidateErrors++;
    if (candidateAllow !== baselineAllow) {
      changed++;
      if (baselineAllow && !candidateAllow && approved) suppressed++;
    }
  }

  const reasons: string[] = [];
  if (holdout.length < minHoldout) reasons.push(`holdout ${holdout.length}/${minHoldout} eligible tickets`);
  if (survivability.global.n < config.min_sample) {
    reasons.push(`14-day survivability ${survivability.global.n}/${config.min_sample} mature PRs`);
  }
  if (changed === 0) reasons.push("survivability changed no held-out routing decisions");
  if (candidateErrors >= baselineErrors) reasons.push(`candidate errors ${candidateErrors} did not improve on baseline ${baselineErrors}`);
  if (suppressed > 0) reasons.push(`candidate suppressed ${suppressed} operator-approved holdout tickets`);

  const measurable = holdout.length >= minHoldout && survivability.global.n >= config.min_sample;
  const promotionEligible = measurable && changed > 0 && candidateErrors < baselineErrors && suppressed === 0;
  return {
    status: promotionEligible ? "promotion_eligible" : measurable ? "advisory" : "insufficient_data",
    promotion_eligible: promotionEligible,
    split: options.holdoutSelector ? "injected" : "ticket-hash-v1",
    train_tickets: new Set(train.map((entry) => entry.verdict.ticket_id)).size,
    holdout_tickets: new Set(holdout.map((entry) => entry.verdict.ticket_id)).size,
    baseline_errors: baselineErrors,
    candidate_errors: candidateErrors,
    changed_decisions: changed,
    valid_work_suppressed: suppressed,
    mature_survivability_prs: survivability.global.n,
    reasons,
  };
}

if (import.meta.main) {
  if (!sf012Flags().feedback) process.exit(0);
  const loaded = loadSurvivabilityConfig();
  const fates = readFateLedger();
  const approvalLedgerPath = process.env.SF012_APPROVAL_LEDGER_PATH || undefined;
  const report = evaluateSurvivabilityFeedback(readLedger(approvalLedgerPath), fates.records, loaded.config);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.promotion_eligible ? 0 : 1);
}
