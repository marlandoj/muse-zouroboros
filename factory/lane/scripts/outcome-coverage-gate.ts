#!/usr/bin/env bun

import { readOutcomeEvidenceLedger, reconcileOutcomeEvidence } from "./outcome-evidence-reconcile";
import { factoryStatePath } from "./factory-state-root";
import {
  OUTCOME_COVERAGE_FLOOR,
  OUTCOME_MINIMUM_ELIGIBLE_SAMPLE,
} from "./factory-metrics";
import type { OutcomeEnvelope } from "./outcome-envelope";

export const OUTCOME_EVIDENCE_MODES = ["off", "shadow", "advisory", "bounded_canary", "enforce"] as const;
export type OutcomeEvidenceMode = (typeof OUTCOME_EVIDENCE_MODES)[number];
export const MAX_AUTHORIZED_OUTCOME_EVIDENCE_MODE: OutcomeEvidenceMode = "shadow";

export interface OutcomeCoverageDecision {
  mode: OutcomeEvidenceMode;
  authorized: boolean;
  enforcement_active: boolean;
  transition_allowed: boolean;
  would_block: boolean;
  ready: boolean;
  reason: string;
  coverage_floor: number;
  minimum_sample: number;
  eligible_total: number;
  window_size: number;
  window_measured: number;
  window_held_unmeasured: number;
  window_coverage: number | null;
  successful_eligible: number;
  successful_measured: number;
  successful_coverage: number | null;
}

function modeRank(mode: OutcomeEvidenceMode): number {
  return OUTCOME_EVIDENCE_MODES.indexOf(mode);
}

export function isOutcomeEvidenceMode(value: unknown): value is OutcomeEvidenceMode {
  return typeof value === "string" && (OUTCOME_EVIDENCE_MODES as readonly string[]).includes(value);
}

export function evaluateOutcomeCoverage(
  envelopes: OutcomeEnvelope[],
  options: {
    mode?: OutcomeEvidenceMode;
    coverageFloor?: number;
    minimumSample?: number;
    maximumAuthorizedMode?: OutcomeEvidenceMode;
  } = {},
): OutcomeCoverageDecision {
  const mode = options.mode ?? "off";
  const coverageFloor = options.coverageFloor ?? OUTCOME_COVERAGE_FLOOR;
  const minimumSample = options.minimumSample ?? OUTCOME_MINIMUM_ELIGIBLE_SAMPLE;
  const maximumAuthorizedMode = options.maximumAuthorizedMode ?? MAX_AUTHORIZED_OUTCOME_EVIDENCE_MODE;
  const authorized = modeRank(mode) <= modeRank(maximumAuthorizedMode);
  const eligible = envelopes
    .filter((envelope) => envelope.disposition !== "excluded")
    .sort((a, b) => Date.parse(a.terminal_at) - Date.parse(b.terminal_at));
  const window = eligible.slice(-minimumSample);
  const measured = window.filter((envelope) => envelope.disposition === "measured").length;
  const held = window.filter((envelope) => envelope.disposition === "held_unmeasured").length;
  const coverage = window.length === 0 ? null : measured / window.length;
  const successful = eligible.filter((envelope) => envelope.terminal_state === "accepted");
  const successfulMeasured = successful.filter(
    (envelope) => envelope.disposition === "measured" && envelope.verification?.verdict === "pass",
  ).length;
  const successfulCoverage = successful.length === 0 ? null : successfulMeasured / successful.length;
  const ready = eligible.length >= minimumSample
    && coverage !== null
    && coverage >= coverageFloor
    && (successfulCoverage === null || successfulCoverage === 1);
  const wouldBlock = !ready;
  const enforcementActive = authorized && (mode === "bounded_canary" || mode === "enforce");
  const transitionAllowed = authorized && (!enforcementActive || ready);

  let reason: string;
  if (!authorized) {
    reason = `mode ${mode} exceeds the operator-authorized ceiling ${maximumAuthorizedMode}`;
  } else if (mode === "off") {
    reason = "gate disabled; evidence collection remains independent";
  } else if (ready) {
    reason = `rolling coverage satisfies ${coverageFloor} across ${window.length} eligible terminals`;
  } else if (eligible.length < minimumSample) {
    reason = `insufficient eligible sample: ${eligible.length}/${minimumSample}`;
  } else if (successfulCoverage !== null && successfulCoverage < 1) {
    reason = `successful-terminal evidence coverage ${successfulCoverage} is below 1`;
  } else {
    reason = `rolling coverage ${coverage ?? 0} is below ${coverageFloor}`;
  }

  return {
    mode,
    authorized,
    enforcement_active: enforcementActive,
    transition_allowed: transitionAllowed,
    would_block: wouldBlock,
    ready,
    reason,
    coverage_floor: coverageFloor,
    minimum_sample: minimumSample,
    eligible_total: eligible.length,
    window_size: window.length,
    window_measured: measured,
    window_held_unmeasured: held,
    window_coverage: coverage,
    successful_eligible: successful.length,
    successful_measured: successfulMeasured,
    successful_coverage: successfulCoverage,
  };
}

export function readOutcomeCoverageDecision(options: {
  ledgerPath?: string;
  mode?: OutcomeEvidenceMode;
} = {}): { decision: OutcomeCoverageDecision; ledger_available: boolean; ledger_errors: string[] } {
  const ledgerPath = options.ledgerPath ?? factoryStatePath("outcome-evidence-ledger.jsonl");
  const ledger = readOutcomeEvidenceLedger(ledgerPath);
  const preview = ledger.available ? null : reconcileOutcomeEvidence({ apply: false });
  const current = ledger.available
    ? ledger.current
    : preview?.generated.map((row) => row.envelope) ?? [];
  const previewErrors = preview?.source_errors.map((error) => `${error.source}: ${error.error}`) ?? [];
  const allErrors = [...ledger.errors, ...previewErrors];
  const decision = evaluateOutcomeCoverage(current, { mode: options.mode });
  if (allErrors.length > 0 || (!ledger.available && decision.enforcement_active)) {
    return {
      ledger_available: ledger.available,
      ledger_errors: allErrors,
      decision: {
        ...decision,
        ready: false,
        would_block: true,
        transition_allowed: decision.enforcement_active ? false : decision.transition_allowed,
        reason: allErrors.length > 0
          ? `outcome evidence sources invalid: ${allErrors.join("; ")}`
          : "durable outcome evidence ledger unavailable for enforcement",
      },
    };
  }
  return {
    decision: ledger.available
      ? decision
      : { ...decision, reason: `${decision.reason}; read-only reconciliation preview` },
    ledger_available: ledger.available,
    ledger_errors: [],
  };
}

if (import.meta.main) {
  const rawMode = process.env.OUTCOME_EVIDENCE_MODE ?? "off";
  if (!isOutcomeEvidenceMode(rawMode)) {
    console.error(JSON.stringify({ ok: false, error: `OUTCOME_EVIDENCE_MODE must be one of ${OUTCOME_EVIDENCE_MODES.join("|")}` }));
    process.exit(2);
  }
  const result = readOutcomeCoverageDecision({ mode: rawMode });
  console.log(JSON.stringify(result, null, 2));
  if (!result.decision.authorized || result.ledger_errors.length > 0) process.exit(2);
  if (result.decision.enforcement_active && !result.decision.transition_allowed) process.exit(1);
}
