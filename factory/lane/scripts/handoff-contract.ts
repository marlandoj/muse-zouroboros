#!/usr/bin/env bun
/**
 * FH-14 (P1-11) — Contractual final handoff.
 *
 * The ZouroBench Results Explorer handoff succeeded, but nothing in the factory
 * checked that it had. The final ticket could have completed with the service
 * down, the runbook missing, or nothing on earth consuming the deployment, and
 * the conveyor would have reported the same "done".
 *
 * A project is not delivered because its last PR merged. It is delivered when
 * someone can find it, run it, and use it. This module states that as a
 * contract and checks it.
 *
 * Seven obligations, each traceable to something the ZBRE run had to establish
 * by hand:
 *
 *   deployment_commit  the merge that is actually running
 *   service_health     a live health probe, not a deploy exit code
 *   production_smoke   an end-to-end check against production
 *   operator_runbook   how a human operates and recovers it
 *   dashboard          discoverable from somewhere people already look
 *   access_mode        who can reach it, stated rather than assumed
 *   named_consumer     something that actually uses it
 *
 * `named_consumer` is the one that catches the expensive mistake. The ZOU-415
 * Hetzner box passed every acceptance test, was fully wired, and was culled the
 * same day because nothing consumed it. "It works" is not "something uses it".
 *
 * Every probe is injected, so the contract is checkable without touching a
 * network. Unproven obligations are `unproven`, never `satisfied` — the whole
 * point is that silence stops counting as success.
 *
 * Reachability: `post-merge-reconcile.ts` evaluates the contract before marking
 * a project's final ticket accepted; the CLI reports it for an operator.
 */

import { parseArgs } from "node:util";

export const HANDOFF_OBLIGATIONS = [
  "deployment_commit",
  "service_health",
  "production_smoke",
  "operator_runbook",
  "dashboard",
  "access_mode",
  "named_consumer",
] as const;

export type HandoffObligation = (typeof HANDOFF_OBLIGATIONS)[number];

export type ObligationStatus = "satisfied" | "unproven" | "failed";

export interface ObligationResult {
  obligation: HandoffObligation;
  status: ObligationStatus;
  /** What proves it. Empty when unproven — that absence is the finding. */
  evidence: string | null;
  detail: string;
}

export interface HandoffVerdict {
  ok: boolean;
  project: string;
  evaluated_at: string;
  satisfied: number;
  results: ObligationResult[];
  /** One line an operator can act on, or null when the contract is met. */
  blocking_summary: string | null;
}

export interface HandoffEvidence {
  /** Commit SHA currently deployed. */
  deployment_commit?: string | null;
  /** Live health probe result. `null` means not probed, which is not healthy. */
  service_health?: { ok: boolean; detail: string } | null;
  /** Production smoke outcome. */
  production_smoke?: { ok: boolean; detail: string } | null;
  /** Path or URL to the operator runbook. */
  operator_runbook?: string | null;
  /** Where the deployment is registered for discovery. */
  dashboard?: string | null;
  /** Stated access mode: `public`, `private`, `internal`. */
  access_mode?: string | null;
  /**
   * What consumes this. A link, a service id, a scheduled job — anything that
   * names a real caller. "Available for use" is not a consumer.
   */
  named_consumer?: string | null;
}

const FULL_SHA = /^[0-9a-f]{7,40}$/i;
const ACCESS_MODES = new Set(["public", "private", "internal"]);

/** Phrases that describe availability rather than a consumer. */
const NON_CONSUMER = /\b(?:available|ready|can be used|open to|anyone|tbd|n\/?a|none)\b/i;

function result(
  obligation: HandoffObligation,
  status: ObligationStatus,
  detail: string,
  evidence: string | null = null,
): ObligationResult {
  return { obligation, status, evidence, detail };
}

export function evaluateHandoff(
  project: string,
  evidence: HandoffEvidence,
  now = new Date().toISOString(),
): HandoffVerdict {
  const results: ObligationResult[] = [];

  const commit = (evidence.deployment_commit ?? "").trim();
  results.push(
    !commit
      ? result("deployment_commit", "unproven", "no deployed commit recorded")
      : FULL_SHA.test(commit)
        ? result("deployment_commit", "satisfied", "deployed commit recorded", commit)
        : result("deployment_commit", "failed", `"${commit}" is not a commit sha`, commit),
  );

  const health = evidence.service_health;
  results.push(
    !health
      ? result("service_health", "unproven", "service was never probed — a deploy exit code is not health")
      : health.ok
        ? result("service_health", "satisfied", "live health probe passed", health.detail)
        : result("service_health", "failed", `health probe failed: ${health.detail}`, health.detail),
  );

  const smoke = evidence.production_smoke;
  results.push(
    !smoke
      ? result("production_smoke", "unproven", "no production smoke run recorded")
      : smoke.ok
        ? result("production_smoke", "satisfied", "production smoke passed", smoke.detail)
        : result("production_smoke", "failed", `production smoke failed: ${smoke.detail}`, smoke.detail),
  );

  const runbook = (evidence.operator_runbook ?? "").trim();
  results.push(
    runbook
      ? result("operator_runbook", "satisfied", "runbook recorded", runbook)
      : result("operator_runbook", "unproven", "no operator runbook — nobody knows how to recover this"),
  );

  const dashboard = (evidence.dashboard ?? "").trim();
  results.push(
    dashboard
      ? result("dashboard", "satisfied", "registered for discovery", dashboard)
      : result("dashboard", "unproven", "not registered anywhere an operator already looks"),
  );

  const access = (evidence.access_mode ?? "").trim().toLowerCase();
  results.push(
    !access
      ? result("access_mode", "unproven", "access mode not stated")
      : ACCESS_MODES.has(access)
        ? result("access_mode", "satisfied", `access mode is ${access}`, access)
        : result("access_mode", "failed", `unrecognized access mode "${access}"`, access),
  );

  const consumer = (evidence.named_consumer ?? "").trim();
  results.push(
    !consumer
      ? result("named_consumer", "unproven", "nothing consumes this — provisioning may be premature")
      : NON_CONSUMER.test(consumer)
        ? result("named_consumer", "failed", `"${consumer}" describes availability, not a consumer`, consumer)
        : result("named_consumer", "satisfied", "a real consumer is named", consumer),
  );

  const unmet = results.filter((item) => item.status !== "satisfied");
  return {
    ok: unmet.length === 0,
    project,
    evaluated_at: now,
    satisfied: results.length - unmet.length,
    results,
    blocking_summary: unmet.length === 0
      ? null
      : `${unmet.length} of ${results.length} handoff obligations unmet: `
        + unmet.map((item) => `${item.obligation} (${item.status})`).join(", "),
  };
}

export function formatHandoff(verdict: HandoffVerdict): string {
  const lines = [`Handoff ${verdict.project}: ${verdict.ok ? "COMPLETE" : "INCOMPLETE"}`];
  lines.push(`${verdict.satisfied}/${verdict.results.length} obligations satisfied`);
  for (const item of verdict.results) {
    const mark = item.status === "satisfied" ? "✓" : item.status === "failed" ? "✗" : "?";
    lines.push(`  ${mark} ${item.obligation}: ${item.detail}${item.evidence ? ` — ${item.evidence}` : ""}`);
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { project: { type: "string" }, evidence: { type: "string" }, json: { type: "boolean" } },
    strict: false,
  });

  if (!values.project || !values.evidence) {
    console.error("Usage: bun handoff-contract.ts --project <name> --evidence <file|-> [--json]");
    process.exit(2);
  }

  let evidence: HandoffEvidence;
  try {
    const raw = values.evidence === "-"
      ? require("node:fs").readFileSync(0, "utf-8")
      : require("node:fs").readFileSync(String(values.evidence), "utf-8");
    evidence = JSON.parse(raw) as HandoffEvidence;
  } catch (error) {
    console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(2);
  }

  const verdict = evaluateHandoff(String(values.project), evidence);
  if (values.json) console.log(JSON.stringify(verdict));
  else console.log(formatHandoff(verdict));
  process.exit(verdict.ok ? 0 : 1);
}
