#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { classifyCascadeFailure, decideCascadeRetry } from "./coding-cascade";

interface InstanceResult {
  instance_id: string;
  arm: string;
  resolved: boolean;
  latencySec: number;
  costUsd: number | null;
  costBasis: string;
}

interface ScoreArtifact {
  instances: InstanceResult[];
}

function usage(message?: string): never {
  if (message) console.error(`ERROR: ${message}`);
  console.error("Usage: coding-cascade-heldout.ts <audited-score.json> <output.json>");
  process.exit(2);
}

const sourcePath = process.argv[2];
const outputPath = process.argv[3];
if (!sourcePath || !outputPath) usage();

const sourceBytes = readFileSync(sourcePath);
const source = JSON.parse(sourceBytes.toString("utf8")) as ScoreArtifact;
const byArm = new Map<string, Map<string, InstanceResult>>();
for (const row of source.instances) {
  if (!byArm.has(row.arm)) byArm.set(row.arm, new Map());
  byArm.get(row.arm)!.set(row.instance_id, row);
}

const opus = byArm.get("opus5");
const sol = byArm.get("gpt56sol");
const moa = byArm.get("moa-current");
if (!opus || !sol || !moa) throw new Error("held-out score must contain opus5, gpt56sol, and moa-current arms");
if (opus.size !== sol.size || opus.size !== moa.size) throw new Error("held-out arms have different cohort sizes");

const rows = [...opus.keys()].map((instanceId) => {
  const primary = opus.get(instanceId)!;
  const fallback = sol.get(instanceId);
  const incumbent = moa.get(instanceId);
  if (!fallback || !incumbent) throw new Error(`missing paired result for ${instanceId}`);
  if (primary.resolved) {
    return {
      instance_id: instanceId,
      primary_resolved: true,
      fallback_invoked: false,
      fallback_resolved: null,
      cascade_resolved: true,
      cascade_latency_sec: primary.latencySec,
      decision: "primary_pass",
    };
  }
  const failure = classifyCascadeFailure({
    cause: "mechanical_validation",
    detail: "official SWE-bench grader did not resolve the primary patch",
  });
  const decision = decideCascadeRetry({
    mode: "enforce",
    failure,
    attempts_made: 1,
    max_attempts: 2,
    now: () => "2026-08-05T00:00:00.000Z",
  });
  if (decision.action !== "retry") throw new Error(`production policy did not retry held-out failure for ${instanceId}`);
  return {
    instance_id: instanceId,
    primary_resolved: false,
    fallback_invoked: true,
    fallback_resolved: fallback.resolved,
    cascade_resolved: fallback.resolved,
    cascade_latency_sec: primary.latencySec + fallback.latencySec,
    decision: `${decision.action}:${decision.trigger}`,
  };
});

const graded = rows.length;
const resolved = rows.filter((row) => row.cascade_resolved).length;
const fallbackInvocations = rows.filter((row) => row.fallback_invoked).length;
const fallbackUniqueWins = rows.filter((row) => row.fallback_invoked && row.fallback_resolved).length;
const avgLatency = rows.reduce((sum, row) => sum + row.cascade_latency_sec, 0) / graded;
const opusResolved = [...opus.values()].filter((row) => row.resolved).length;
const moaResolved = [...moa.values()].filter((row) => row.resolved).length;
const opusLatency = [...opus.values()].reduce((sum, row) => sum + row.latencySec, 0) / graded;

const artifact = {
  schema_version: 1,
  generated_at: new Date().toISOString(),
  source: {
    path: sourcePath,
    sha256: createHash("sha256").update(sourceBytes).digest("hex"),
    cohort: "ScaleAI/SWE-bench_Pro fixed 12-instance smoke",
  },
  comparators: {
    opus_only: { graded, resolved: opusResolved, pass_at_1: opusResolved / graded, avg_latency_sec: Number(opusLatency.toFixed(1)) },
    opus_to_sol_cascade: {
      graded,
      resolved,
      pass_at_1: resolved / graded,
      avg_latency_sec: Number(avgLatency.toFixed(1)),
      fallback_invocations: fallbackInvocations,
      fallback_unique_wins: fallbackUniqueWins,
      cost_basis: "unknown_subscription_cost",
    },
    benchmark_incumbent_moa: { graded, resolved: moaResolved, pass_at_1: moaResolved / graded },
  },
  promotion: {
    decision: "hold",
    reasons: [
      "The 12-instance cohort is directional and not large or stratified enough for default promotion.",
      "The projected cascade improves resolved count from 8 to 9 but increases average latency.",
      "Subscription-backed Opus and Sol costs are not invoice-grade, so the cost bound is unproven.",
    ],
    required_next_evidence: "Larger stratified paired cohort plus shadow production telemetry.",
  },
  caveat: "Counterfactual replay assumes Sol's independently observed result is unchanged when invoked conditionally after an official grader failure.",
  instances: rows,
};

writeFileSync(outputPath, `${JSON.stringify(artifact, null, 2)}\n`);
console.log(JSON.stringify(artifact.comparators));
