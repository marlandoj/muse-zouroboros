#!/usr/bin/env bun
/**
 * ZOU-528 — Tier-Policy Parser Hook
 *
 * Parses the per-ticket `## Model Policy` block (Ori PROJECT.md §13.2/§13.3) and
 * applies its `FACTORY_MODEL_CHAIN` value to the execution environment for THAT
 * ticket only. Historical `LINEUP_PIN_*` values remain parseable for audit and
 * explicit operator-authorized runs, but are inert by default.
 *
 * Effect-scoped by construction: a ticket WITHOUT the block parses to `null`, so
 * the caller makes no env change and behavior is byte-identical to pre-hook —
 * projects that carry no Model Policy keep the factory default (no global
 * override, the guarantee §13.3 requires).
 *
 * Consumption: swarm-exec inherits `process.env` into the child harness and the
 * /zo/ask fallback. A model-based review consumes scoped lineup pins only when
 * `FACTORY_MODEL_REVIEW=operator` is set for that run. This module never writes
 * the shared lineup cache; callers restore the environment in `finally`.
 *
 * ZOU-1459 — the /factory-intake surface offers MoA-lineup and consensus-lineup
 * dropdowns that write `ZO_MOA_LINEUP_PATH` / `GATE_LINEUP_PROFILE` into the
 * scoped block. Both are read downstream from the environment
 * (`Skills/consensus-gate/scripts/moa-runtime.ts` resolves the lineup file,
 * `Skills/consensus-gate/scripts/consensus-gate.ts` selects the panel tier), but
 * neither was whitelisted here, so `values.size === 0` and every intake
 * selection parsed to `null` and was silently dropped. They are selectors, not
 * activators: each one only changes which lineup an already-invoked review uses,
 * so they are emitted without the `FACTORY_MODEL_REVIEW` gate that withholds the
 * `LINEUP_PIN_*` pins. A ticket with no `## Model Policy` block still parses to
 * `null` and keeps the factory default.
 */

/** The environment keys a Model Policy block may pin. */
export const POLICY_ENV_KEYS = [
  "LINEUP_PIN_PROPOSERS",
  "LINEUP_PIN_AGGREGATOR",
  "LINEUP_ROLE_CHAINS",
  "FACTORY_MODEL_CHAIN",
  "ZO_MOA_LINEUP_PATH",
  "GATE_LINEUP_PROFILE",
] as const;

export type PolicyEnvKey = (typeof POLICY_ENV_KEYS)[number];
export type ModelPolicyTier = "Routine" | "Reasoning";
export type ReviewLevel = "deterministic" | "consensus";

/**
 * The only directory a scoped `ZO_MOA_LINEUP_PATH` may name. `moa-runtime.ts`
 * defaults to `${HOME}/.zouroboros/lineup.json` and factory execution runs as
 * root, so this is that directory named literally rather than via `HOME` — a
 * ticket description must not be able to redirect the lineup read by exporting
 * a different `HOME`.
 */
export const MOA_LINEUP_ROOT = "/root/.zouroboros/";

/**
 * The consensus-lineup profiles the intake dropdown offers. Deliberately a
 * subset of `lineup-picker.ts`'s `PROFILES`: `judge` is a role-internal profile
 * that is not an operator-selectable panel tier, so it is rejected here.
 */
export const GATE_LINEUP_PROFILES = ["flagship", "open-weights", "fast", "coder"] as const;

export type GateLineupProfile = (typeof GATE_LINEUP_PROFILES)[number];

export interface ExecutionPolicy {
  tier: ModelPolicyTier;
  pin_proposers: string[];
  pin_aggregator: string | null;
  role_chains?: string | null;
  model_chain: string[];
  review_level: ReviewLevel;
  moa_lineup_path?: string | null;
  gate_lineup_profile?: GateLineupProfile | null;
}

export interface AppliedPolicy {
  policy: ExecutionPolicy;
  applied: Partial<Record<PolicyEnvKey, string>>;
  restore: () => void;
}

export const FACTORY_MODEL_REVIEW_ENV = "FACTORY_MODEL_REVIEW";

export function modelReviewAuthorized(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const value = env[FACTORY_MODEL_REVIEW_ENV];
  if (value === undefined || value === "" || value === "off" || value === "0") return false;
  if (value === "operator") return true;
  throw new Error(`${FACTORY_MODEL_REVIEW_ENV} must be off|operator, got ${value}`);
}

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

function parseModelIds(value: string, key: PolicyEnvKey): string[] {
  const ids = value.split(",").map((part) => part.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > 12) throw new Error(`${key} must contain 1-12 model ids`);
  for (const id of ids) {
    if (id.length > 200 || !MODEL_ID.test(id)) throw new Error(`${key} contains invalid model id: ${id}`);
  }
  return ids;
}

/**
 * ZOU-1459 — fail closed on an intake lineup path. The value reaches
 * `fs.readFileSync` in `moa-runtime.ts`, which swallows every read error, so an
 * unconstrained path would degrade silently to the fallback lineup instead of
 * surfacing the operator's mistake. Confining it to `MOA_LINEUP_ROOT` with no
 * traversal segments makes an out-of-scope selection a parse-time throw.
 */
function parseMoaLineupPath(value: string): string {
  if (value.length > 512) throw new Error("ZO_MOA_LINEUP_PATH must be at most 512 characters");
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("ZO_MOA_LINEUP_PATH must not contain control characters");
  if (!value.startsWith(MOA_LINEUP_ROOT)) {
    throw new Error(`ZO_MOA_LINEUP_PATH must be an absolute path under ${MOA_LINEUP_ROOT}, got ${value}`);
  }
  const segments = value.slice(MOA_LINEUP_ROOT.length).split("/");
  if (segments.length === 0 || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`ZO_MOA_LINEUP_PATH must name a file under ${MOA_LINEUP_ROOT} without traversal segments`);
  }
  return value;
}

/** ZOU-1459 — an unrecognized consensus profile is rejected, never defaulted. */
function parseGateLineupProfile(value: string): GateLineupProfile {
  if (!(GATE_LINEUP_PROFILES as readonly string[]).includes(value)) {
    throw new Error(`GATE_LINEUP_PROFILE must be one of ${GATE_LINEUP_PROFILES.join(", ")}, got ${value}`);
  }
  return value as GateLineupProfile;
}

/**
 * FH-01 — structural validation of LINEUP_ROLE_CHAINS at policy-parse time.
 *
 * The ZBRE run propagated a role-chain value wrapped in Markdown backticks
 * through four consecutive tickets: this parser copied the string verbatim, so
 * the failure only surfaced later inside the consensus process as
 * `JSON.parse: Unrecognized token`. By then it read as a generic gate error and
 * was blind-retried unchanged.
 *
 * Two changes. Surrounding backticks are stripped — the same markdown-wrapper
 * removal already applied to `"` and `'`. The remainder must then parse as an
 * object carrying a non-empty `proposers` array and an `aggregator`. Deep
 * semantic validation (provider diversity, canonical-identity preservation)
 * stays in the production parser `Skills/consensus-gate/scripts/lineup-roles.ts`,
 * which `project-preflight.ts` invokes before the first promotion.
 */
function parseRoleChains(value: string): string {
  let text = value.trim();
  const fence = text.match(/^(\x60{1,3})([\s\S]*)\1$/);
  if (fence) text = fence[2].trim();
  if (/^json\b/i.test(text)) text = text.replace(/^json\b/i, "").trim();
  if (!text) throw new Error("LINEUP_ROLE_CHAINS must not be empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `LINEUP_ROLE_CHAINS must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("LINEUP_ROLE_CHAINS must be a JSON object");
  }
  const config = parsed as { proposers?: unknown; aggregator?: unknown };
  if (!Array.isArray(config.proposers) || config.proposers.length === 0) {
    throw new Error("LINEUP_ROLE_CHAINS requires a non-empty proposers array");
  }
  if (config.aggregator === undefined || config.aggregator === null) {
    throw new Error("LINEUP_ROLE_CHAINS requires an aggregator");
  }
  // Re-serialize so the value handed to the consensus process is canonical
  // JSON, never the operator's raw markdown.
  return JSON.stringify(parsed);
}

type FenceMarker = { sequence: string; bare: boolean };

function fenceMarker(line: string): FenceMarker | null {
  const match = line.match(/^ {0,3}(\x60{3,}|~{3,})(.*)$/);
  return match ? { sequence: match[1], bare: match[2].trim().length === 0 } : null;
}

function updateFence(fence: string | null, marker: FenceMarker): string | null {
  if (fence === null) return marker.sequence;
  return marker.bare && marker.sequence[0] === fence[0] && marker.sequence.length >= fence.length ? null : fence;
}

function modelPolicyHeading(lines: string[]): number {
  let fence: string | null = null;
  for (let index = 0; index < lines.length; index++) {
    const marker = fenceMarker(lines[index]);
    if (marker) {
      fence = updateFence(fence, marker);
      continue;
    }
    if (fence === null && /^ {0,3}#{1,6}[ \t]+.*model[ \t]+policy/i.test(lines[index])) return index;
  }
  return -1;
}

function sectionBody(description: string): string[] | null {
  const lines = description.split("\n");
  const heading = modelPolicyHeading(lines);
  if (heading < 0) return null;
  const level = (lines[heading].match(/^ {0,3}(#{1,6})/)?.[1] ?? "##").length;
  let end = lines.length;
  let fence: string | null = null;
  for (let index = heading + 1; index < lines.length; index++) {
    const marker = fenceMarker(lines[index]);
    if (marker) {
      fence = updateFence(fence, marker);
      continue;
    }
    if (fence !== null) continue;
    const next = lines[index].match(/^ {0,3}(#{1,6})[ \t]+/)?.[1];
    if (next && next.length <= level) {
      end = index;
      break;
    }
  }
  return lines.slice(heading + 1, end);
}

export function parseModelPolicy(description: string): ExecutionPolicy | null {
  if (typeof description !== "string" || description.length === 0) return null;
  const body = sectionBody(description);
  if (!body) return null;

  const values = new Map<PolicyEnvKey, string>();
  for (const raw of body) {
    if (/^(?: {4}|\t)/.test(raw)) continue;
    const line = raw.trim().replace(/^[-*+]\s+/, "").replace(/^export\s+/, "").replace(/\s*\\$/, "").trim();
    const match = line.match(/^([A-Z][A-Z0-9_]*)\s*[:=]\s*(.+?)\s*$/);
    if (!match || !POLICY_ENV_KEYS.includes(match[1] as PolicyEnvKey)) continue;
    let value = match[2].trim();
    if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
      value = value.slice(1, -1).trim();
    }
    if (!value) throw new Error(`${match[1]} must not be empty`);
    values.set(match[1] as PolicyEnvKey, value);
  }
  if (values.size === 0) return null;

  const tierText = body.join("\n");
  const tier: ModelPolicyTier = /\breasoning(?:-heavy)?\b/i.test(tierText) ? "Reasoning" : "Routine";
  const pinProposers = values.has("LINEUP_PIN_PROPOSERS")
    ? parseModelIds(values.get("LINEUP_PIN_PROPOSERS")!, "LINEUP_PIN_PROPOSERS")
    : [];
  const pinAggregators = values.has("LINEUP_PIN_AGGREGATOR")
    ? parseModelIds(values.get("LINEUP_PIN_AGGREGATOR")!, "LINEUP_PIN_AGGREGATOR")
    : [];
  if (pinAggregators.length > 1) throw new Error("LINEUP_PIN_AGGREGATOR must contain exactly one model id");
  const modelChain = values.has("FACTORY_MODEL_CHAIN")
    ? parseModelIds(values.get("FACTORY_MODEL_CHAIN")!, "FACTORY_MODEL_CHAIN")
    : [];

  return {
    tier,
    pin_proposers: pinProposers,
    pin_aggregator: pinAggregators[0] ?? null,
    role_chains: values.has("LINEUP_ROLE_CHAINS")
      ? parseRoleChains(values.get("LINEUP_ROLE_CHAINS")!)
      : null,
    model_chain: modelChain,
    review_level: tier === "Reasoning" ? "consensus" : "deterministic",
    moa_lineup_path: values.has("ZO_MOA_LINEUP_PATH")
      ? parseMoaLineupPath(values.get("ZO_MOA_LINEUP_PATH")!)
      : null,
    gate_lineup_profile: values.has("GATE_LINEUP_PROFILE")
      ? parseGateLineupProfile(values.get("GATE_LINEUP_PROFILE")!)
      : null,
  };
}

export function policyEnvironment(
  policy: ExecutionPolicy,
  options: { modelReviewAuthorized?: boolean } = {},
): Partial<Record<PolicyEnvKey, string>> {
  const includeModelReview = options.modelReviewAuthorized ?? false;
  return {
    ...(includeModelReview && policy.pin_proposers.length > 0 ? { LINEUP_PIN_PROPOSERS: policy.pin_proposers.join(",") } : {}),
    ...(includeModelReview && policy.pin_aggregator ? { LINEUP_PIN_AGGREGATOR: policy.pin_aggregator } : {}),
    ...(includeModelReview && policy.role_chains ? { LINEUP_ROLE_CHAINS: policy.role_chains } : {}),
    ...(policy.model_chain.length > 0 ? { FACTORY_MODEL_CHAIN: policy.model_chain.join(",") } : {}),
    ...(policy.moa_lineup_path ? { ZO_MOA_LINEUP_PATH: policy.moa_lineup_path } : {}),
    ...(policy.gate_lineup_profile ? { GATE_LINEUP_PROFILE: policy.gate_lineup_profile } : {}),
  };
}

let activePolicyScope: symbol | null = null;

type PriorPolicyValue = { present: boolean; value: string | undefined };
type PriorPolicyEnvironment = Record<PolicyEnvKey, PriorPolicyValue>;

function snapshotPolicyEnvironment(env: Record<string, string | undefined>): PriorPolicyEnvironment {
  return Object.fromEntries(POLICY_ENV_KEYS.map((key) => [
    key,
    { present: Object.prototype.hasOwnProperty.call(env, key), value: env[key] },
  ])) as PriorPolicyEnvironment;
}

function restorePolicyEnvironment(
  env: Record<string, string | undefined>,
  prior: PriorPolicyEnvironment,
): void {
  const errors: unknown[] = [];
  for (const key of POLICY_ENV_KEYS) {
    try {
      if (!prior[key].present) delete env[key];
      else env[key] = prior[key].value;
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "policy environment restore failed for multiple keys");
}

export function applyModelPolicy(
  policy: ExecutionPolicy,
  env: Record<string, string | undefined> = process.env,
): AppliedPolicy {
  if (activePolicyScope !== null) throw new Error("model policy scope already active");
  const applied = policyEnvironment(policy, { modelReviewAuthorized: modelReviewAuthorized(env) });
  const prior = snapshotPolicyEnvironment(env);
  const scope = Symbol("model-policy-scope");
  activePolicyScope = scope;
  try {
    for (const key of POLICY_ENV_KEYS) {
      if (applied[key] === undefined) delete env[key];
      else env[key] = applied[key];
    }
  } catch (error) {
    try {
      restorePolicyEnvironment(env, prior);
    } catch (rollbackError) {
      if (activePolicyScope === scope) activePolicyScope = null;
      throw new AggregateError([error, rollbackError], "model policy apply and rollback both failed");
    }
    if (activePolicyScope === scope) activePolicyScope = null;
    throw error;
  }
  let restored = false;
  return {
    policy,
    applied,
    restore: () => {
      if (restored) return;
      if (activePolicyScope !== null && activePolicyScope !== scope) {
        throw new Error("another model policy scope is active");
      }
      activePolicyScope = scope;
      try {
        restorePolicyEnvironment(env, prior);
        restored = true;
      } finally {
        if (activePolicyScope === scope) activePolicyScope = null;
      }
    },
  };
}

export function modelChainForPolicy(policy: ExecutionPolicy | null | undefined, fallback: readonly string[]): string[] {
  return policy?.model_chain.length ? [...policy.model_chain] : [...fallback];
}

export function formatPolicy(policy: ExecutionPolicy | null): string {
  if (!policy) return "default";
  const authorized = modelReviewAuthorized();
  const env = policyEnvironment(policy, { modelReviewAuthorized: authorized });
  const review = authorized ? policy.review_level : "operator-only/inactive";
  return `${policy.tier}/${review} ${Object.entries(env).map(([key, value]) => `${key}=${value}`).join(" ")}`.trim();
}
