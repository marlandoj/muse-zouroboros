#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-009 T1 — Scenario spec core.
 *
 * A ScenarioSpec is one ephemeral verification run: N shell steps executed in
 * a throwaway workdir under the P0-3 hermetic sandbox, optionally against a
 * deterministic digital twin (SF-009 v1 ships a Linear contract-mock).
 * This module is the pure layer: parse/validate the spec (fail-loud). The
 * runner (scenario-run.ts) owns spawning, the twin lifecycle, and the ledger.
 *
 * Env forwarding rule: `env` values are LITERALS from the committed spec —
 * nothing is ever forwarded from the parent environment. Names are still
 * secret-checked at parse (isSecretEnvName) so a spec can never normalize
 * committing real credential conventions.
 *
 * Placeholders materialized by the runner inside `run` commands:
 *   {scripts_dir} → this scripts/ directory   {workdir} → the run's temp dir
 *
 * CLI (validation only, writes nothing):
 *   bun scenario-spec.ts validate --spec <yaml>   (requires SF009_SCENARIOS=1)
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { isSecretEnvName } from "../../../packages/selfheal/src/crystallize/eval-replay.ts";

// ─── Flags ────────────────────────────────────────────────────────────────────

/** SF009_SCENARIOS default OFF — scenarios are an execution surface (SF-003 precedent). */
export function scenariosEnabled(): boolean {
  return process.env.SF009_SCENARIOS === "1";
}

export function actorTwinsEnabled(): boolean {
  return process.env.SF009_ACTOR_TWINS === "1";
}

export function trajectoryVerifierEnabled(): boolean {
  return process.env.SF009_TRAJECTORY_VERIFIER === "1";
}

// ─── Paths (env-injectable for the sandboxed selftest) ────────────────────────

export function scenarioRunsPath(): string {
  return resolveFactoryStateOverride(process.env.SF009_RUNS_PATH, "scenario-runs.jsonl");
}

// ─── Spec ─────────────────────────────────────────────────────────────────────

export interface LinearTwinDecl {
  kind: "linear";
  fixture: string;
}

export interface ActorSystemTwinDecl {
  kind: "actor-system";
  fixture: string;
  contract_id: string;
  authority_kind: "approved_manifest" | "admitted_lineage";
  manifest_sha256: string;
  contract_sha256: string;
  review_sha256: string;
}

export type TwinDecl = LinearTwinDecl | ActorSystemTwinDecl;

export interface StepExpect {
  exit_code?: number;
  stdout_contains?: string[];
  stderr_contains?: string[];
  /** Workdir-relative paths; traversal ("..") and absolute paths rejected at parse. */
  files_exist?: string[];
}

export interface ScenarioStep {
  name: string;
  run: string;
  timeout_ms?: number;
  expect: StepExpect;
}

export interface ScenarioLineage {
  source_receipt_id: string;
  source_receipt_hash: string;
  candidate_id: string;
  candidate_hash: string;
  review_id: string;
  review_hash: string;
  scenario_version: string;
}

export interface TrajectoryVerifierDecl {
  mode: "advisory";
  generator_model_id: string;
  generator_prompt_sha256: string;
  generator_history_sha256: string;
  verifier_model_id: string;
  verifier_prompt_sha256: string;
  verifier_history_sha256: string;
  rubric_sha256: string;
  qualitative_score: number;
  qualitative_confidence: number;
  qualitative_rationale_sha256: string;
}

export interface ScenarioSpec {
  scenario_id: string;
  description?: string;
  /** Drives the twin's PRNG — same seed ⇒ byte-identical twin transcript. */
  seed: number;
  twin?: TwinDecl;
  env?: Record<string, string>;
  steps: ScenarioStep[];
  lineage?: ScenarioLineage;
  trajectory_verifier?: TrajectoryVerifierDecl;
}

const EXPECT_KEYS = new Set(["exit_code", "stdout_contains", "stderr_contains", "files_exist"]);
const LINEAGE_KEYS = [
  "source_receipt_id", "source_receipt_hash", "candidate_id", "candidate_hash",
  "review_id", "review_hash", "scenario_version",
] as const;
const HASH = /^[0-9a-f]{64}$/;
const TRAJECTORY_KEYS = [
  "mode", "generator_model_id", "generator_prompt_sha256", "generator_history_sha256",
  "verifier_model_id", "verifier_prompt_sha256", "verifier_history_sha256", "rubric_sha256",
  "qualitative_score", "qualitative_confidence", "qualitative_rationale_sha256",
] as const;

function parseTrajectoryVerifier(value: unknown): TrajectoryVerifierDecl {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("trajectory_verifier must be an object");
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(TRAJECTORY_KEYS as readonly string[]).includes(key));
  const missing = TRAJECTORY_KEYS.filter((key) => raw[key] === undefined);
  if (unknown.length > 0) throw new Error(`trajectory_verifier has unknown keys: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`trajectory_verifier is missing keys: ${missing.join(", ")}`);
  if (raw.mode !== "advisory") throw new Error("trajectory_verifier.mode must be advisory");
  for (const key of ["generator_model_id", "verifier_model_id"] as const) {
    if (typeof raw[key] !== "string" || !/^[a-z0-9][a-z0-9._:-]{2,127}$/i.test(raw[key])) throw new Error(`trajectory_verifier.${key} is invalid`);
  }
  for (const key of [
    "generator_prompt_sha256", "generator_history_sha256", "verifier_prompt_sha256",
    "verifier_history_sha256", "rubric_sha256", "qualitative_rationale_sha256",
  ] as const) {
    if (typeof raw[key] !== "string" || !HASH.test(raw[key])) throw new Error(`trajectory_verifier.${key} must be lowercase SHA-256`);
  }
  for (const key of ["qualitative_score", "qualitative_confidence"] as const) {
    if (typeof raw[key] !== "number" || !Number.isFinite(raw[key]) || raw[key] < 0 || raw[key] > 1) {
      throw new Error(`trajectory_verifier.${key} must be between 0 and 1`);
    }
  }
  return Object.fromEntries(TRAJECTORY_KEYS.map((key) => [key, raw[key]])) as unknown as TrajectoryVerifierDecl;
}

function parseLineage(value: unknown, path: string): ScenarioLineage {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`lineage must be an object in ${path}`);
  const raw = value as Record<string, unknown>;
  const unknown = Object.keys(raw).filter((key) => !(LINEAGE_KEYS as readonly string[]).includes(key));
  const missing = LINEAGE_KEYS.filter((key) => raw[key] === undefined);
  if (unknown.length > 0) throw new Error(`lineage has unknown keys: ${unknown.join(", ")}`);
  if (missing.length > 0) throw new Error(`lineage is missing keys: ${missing.join(", ")}`);
  for (const key of ["source_receipt_hash", "candidate_hash", "review_hash"] as const) {
    if (typeof raw[key] !== "string" || !HASH.test(raw[key])) throw new Error(`lineage.${key} must be lowercase SHA-256`);
  }
  for (const key of ["source_receipt_id", "candidate_id", "review_id", "scenario_version"] as const) {
    if (typeof raw[key] !== "string" || raw[key].trim() === "") throw new Error(`lineage.${key} is required`);
  }
  return Object.fromEntries(LINEAGE_KEYS.map((key) => [key, raw[key]])) as unknown as ScenarioLineage;
}

function parseStringList(value: unknown, label: string): string[] {
  const arr = Array.isArray(value) ? value : [value];
  if (arr.length === 0 || arr.some((s) => typeof s !== "string" || s.trim() === "")) {
    throw new Error(`${label} must be a non-empty string or string array`);
  }
  return arr as string[];
}

function parseExpect(value: unknown, label: string): StepExpect {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label}.expect must be an object with at least one expectation`);
  }
  const raw = value as Record<string, unknown>;
  const keys = Object.keys(raw);
  const unknown = keys.filter((k) => !EXPECT_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(`${label}.expect has unknown keys: ${unknown.join(", ")} (allowed: ${[...EXPECT_KEYS].join(", ")})`);
  }
  if (keys.length === 0) throw new Error(`${label}.expect must declare at least one expectation`);

  const expect: StepExpect = {};
  if (raw.exit_code !== undefined) {
    const code = Number(raw.exit_code);
    if (!Number.isInteger(code) || code < 0 || code > 255) {
      throw new Error(`${label}.expect.exit_code must be an integer 0-255`);
    }
    expect.exit_code = code;
  }
  if (raw.stdout_contains !== undefined) expect.stdout_contains = parseStringList(raw.stdout_contains, `${label}.expect.stdout_contains`);
  if (raw.stderr_contains !== undefined) expect.stderr_contains = parseStringList(raw.stderr_contains, `${label}.expect.stderr_contains`);
  if (raw.files_exist !== undefined) {
    const files = parseStringList(raw.files_exist, `${label}.expect.files_exist`);
    for (const f of files) {
      if (isAbsolute(f) || f.split("/").includes("..")) {
        throw new Error(`${label}.expect.files_exist entries must be workdir-relative without "..": ${f}`);
      }
    }
    expect.files_exist = files;
  }
  return expect;
}

/** Fail-loud spec parser — a malformed committed scenario must never half-run. */
export function parseScenarioSpec(path: string): ScenarioSpec {
  if (!existsSync(path)) throw new Error(`scenario spec not found: ${path}`);
  const doc = Bun.YAML.parse(readFileSync(path, "utf8")) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") throw new Error(`scenario spec is not a YAML object: ${path}`);

  const id = doc.scenario_id;
  if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(id)) {
    throw new Error(`scenario_id must match [a-z0-9][a-z0-9-]{2,63}: ${String(id)}`);
  }

  const seed = Number(doc.seed);
  if (!Number.isInteger(seed) || seed < 0) {
    throw new Error(`seed must be a non-negative integer in ${path}`);
  }

  let twin: TwinDecl | undefined;
  if (doc.twin !== undefined) {
    const t = doc.twin as Record<string, unknown> | null;
    if (!t || typeof t !== "object" || Array.isArray(t)) throw new Error(`twin must be an object in ${path}`);
    if (typeof t.fixture !== "string" || t.fixture.trim() === "") {
      throw new Error(`twin.fixture missing in ${path}`);
    }
    const fixture = resolve(dirname(path), t.fixture);
    if (!existsSync(fixture)) throw new Error(`twin.fixture not found: ${fixture}`);
    if (t.kind === "linear") {
      const unknown = Object.keys(t).filter((key) => !["kind", "fixture"].includes(key));
      if (unknown.length > 0) throw new Error(`linear twin has unknown keys: ${unknown.join(", ")}`);
      twin = { kind: "linear", fixture };
    } else if (t.kind === "actor-system") {
      const keys = ["kind", "fixture", "contract_id", "authority_kind", "manifest_sha256", "contract_sha256", "review_sha256"];
      const unknown = Object.keys(t).filter((key) => !keys.includes(key));
      const missing = keys.filter((key) => t[key] === undefined);
      if (unknown.length > 0) throw new Error(`actor-system twin has unknown keys: ${unknown.join(", ")}`);
      if (missing.length > 0) throw new Error(`actor-system twin is missing keys: ${missing.join(", ")}`);
      if (typeof t.contract_id !== "string" || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(t.contract_id)) {
        throw new Error("actor-system twin contract_id is invalid");
      }
      if (t.authority_kind !== "approved_manifest" && t.authority_kind !== "admitted_lineage") {
        throw new Error("actor-system twin authority_kind is invalid");
      }
      for (const key of ["manifest_sha256", "contract_sha256", "review_sha256"] as const) {
        if (typeof t[key] !== "string" || !HASH.test(t[key])) throw new Error(`actor-system twin ${key} must be lowercase SHA-256`);
      }
      twin = {
        kind: "actor-system",
        fixture,
        contract_id: t.contract_id,
        authority_kind: t.authority_kind,
        manifest_sha256: t.manifest_sha256 as string,
        contract_sha256: t.contract_sha256 as string,
        review_sha256: t.review_sha256 as string,
      };
    } else {
      throw new Error(`twin.kind must be "linear" or "actor-system": ${String(t.kind)}`);
    }
  }

  let env: Record<string, string> | undefined;
  if (doc.env !== undefined) {
    const e = doc.env as Record<string, unknown> | null;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw new Error(`env must be a string map in ${path}`);
    env = {};
    for (const [name, value] of Object.entries(e)) {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name)) throw new Error(`env name must be UPPER_SNAKE: ${name}`);
      if (isSecretEnvName(name)) throw new Error(`env name matches a secret convention, refuse to forward: ${name}`);
      // Runner-owned names — a spec must never unpin the egress sink or repoint the twin.
      if (/^(HTTPS?_PROXY|ALL_PROXY|NO_PROXY|LINEAR_API_URL|ACTOR_SYSTEM_TWIN_URL|FACTORY_STATE_DIR|FACTORY_STATE_MODE|FACTORY_STATE_ALLOW_OUTSIDE_ROOT)$/i.test(name)) {
        throw new Error(`env name is reserved by the scenario runner: ${name}`);
      }
      if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
        throw new Error(`env.${name} must be a scalar in ${path}`);
      }
      env[name] = String(value);
    }
  }

  const rawSteps = doc.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) {
    throw new Error(`steps must be a non-empty array in ${path}`);
  }
  const seen = new Set<string>();
  const steps: ScenarioStep[] = rawSteps.map((rawStep, i) => {
    const label = `steps[${i}]`;
    const s = rawStep as Record<string, unknown> | null;
    if (!s || typeof s !== "object") throw new Error(`${label} must be an object`);
    if (typeof s.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(s.name)) {
      throw new Error(`${label}.name must match [a-z0-9][a-z0-9-]{0,63}: ${String(s.name)}`);
    }
    if (seen.has(s.name)) throw new Error(`duplicate step name: ${s.name}`);
    seen.add(s.name);
    if (typeof s.run !== "string" || s.run.trim() === "") throw new Error(`${label}.run missing`);
    let timeout: number | undefined;
    if (s.timeout_ms !== undefined) {
      timeout = Number(s.timeout_ms);
      if (!Number.isInteger(timeout) || timeout <= 0) throw new Error(`${label}.timeout_ms must be a positive integer`);
    }
    return { name: s.name, run: s.run.trim(), timeout_ms: timeout, expect: parseExpect(s.expect, label) };
  });

  const lineage = doc.lineage === undefined ? undefined : parseLineage(doc.lineage, path);
  if (twin?.kind === "actor-system" && twin.authority_kind === "admitted_lineage") {
    if (!lineage) throw new Error("admitted_lineage actor-system twin requires scenario lineage");
    if (lineage.review_hash !== twin.review_sha256) throw new Error("actor-system review hash does not match admitted lineage");
  }
  const trajectoryVerifier = doc.trajectory_verifier === undefined ? undefined : parseTrajectoryVerifier(doc.trajectory_verifier);
  if (trajectoryVerifier && twin?.kind !== "actor-system") {
    throw new Error("trajectory_verifier requires an actor-system twin");
  }

  return {
    scenario_id: id,
    description: typeof doc.description === "string" ? doc.description.trim() : undefined,
    seed,
    twin,
    env,
    steps,
    lineage,
    trajectory_verifier: trajectoryVerifier,
  };
}

// ─── CLI (validate only — writes nothing) ─────────────────────────────────────

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (!scenariosEnabled()) {
    // Exit before ANY read/write when the flag is off (byte-identity AC).
    process.exit(0);
  }
  const specIdx = args.indexOf("--spec");
  if (args[0] !== "validate" || specIdx < 0 || specIdx + 1 >= args.length) {
    console.error("usage: scenario-spec.ts validate --spec <yaml>   (requires SF009_SCENARIOS=1)");
    process.exit(2);
  }
  const spec = parseScenarioSpec(args[specIdx + 1]);
  const twinNote = spec.twin ? `twin=${spec.twin.kind}` : "no twin";
  console.log(`scenario ${spec.scenario_id}: ${spec.steps.length} step(s), seed=${spec.seed}, ${twinNote} — VALID`);
  process.exit(0);
}
