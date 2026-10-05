#!/usr/bin/env bun
import { loadFactoryPathProfile } from "../../../packages/swarm/src/transport/factory-path-profile";
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride, validateFactoryStateMarker } from "./factory-state-root";
import { conveyorReleaseManifestPath, readConveyorReleaseManifest, type ConveyorReleaseManifest } from "./factory-conveyor-release";
/**
 * FR-02 (ZOU-1111) — Authoritative Typed Runtime Configuration
 *
 * One typed, versioned source of truth for factory runtime flags:
 * config/runtime-flags.json. Replaces documentation-only drift between
 * state/factory-flags.env (docs) and the conveyor automation instruction
 * (live shell exports).
 *
 * Fail-closed: missing, invalid, or divergent configuration is an error,
 * never a silent default. Rollback is atomic (previous known-good file is
 * kept and swapped by rename).
 *
 * Usage:
 *   bun runtime-config.ts validate            # Parse+validate, print version/hash
 *   bun runtime-config.ts export-env          # Emit `export K=V` lines (eval-able)
 *   bun runtime-config.ts check               # Fail (exit 1) on env divergence
 *   bun runtime-config.ts record-tick [--source <s>]  # Append hash+effective values to state/config-ticks.jsonl
 *   bun runtime-config.ts set KEY VALUE --by <who>    # Versioned, validated, atomic update
 *   bun runtime-config.ts activate-receipt-shadow --config <path> --by <who>
 *   bun runtime-config.ts rollback-receipt-shadow --by <who>
 *   bun runtime-config.ts activate-conveyor-parity-shadow --manifest <path> --by <who>
 *   bun runtime-config.ts rollback-conveyor-parity-shadow --by <who>
 *   bun runtime-config.ts conveyor-parity-status
 *   bun runtime-config.ts rollback --by <who>         # Atomic swap to previous known-good
 *   bun runtime-config.ts status              # Human summary
 *
 * Exit codes: 0 ok · 1 divergence/rollback-unavailable · 2 usage · 3 invalid/missing config
 */

import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");
export const CONFIG_PATH = join(PROJECT_DIR, "config", "runtime-flags.json");
export const PREVIOUS_PATH = join(PROJECT_DIR, "config", "runtime-flags.previous.json");
export const CONVEYOR_PARITY_PREIMAGE_PATH = factoryStatePath("conveyor-runner", "releases", "activation-preimage.json");
export const TICKS_PATH = factoryStatePath("config-ticks.jsonl");
export const TRANSITIONS_PATH = factoryStatePath("config-transitions.log");

// ─── Schema ───────────────────────────────────────────────────────────────────

export type FlagSpec =
  | { kind: "bool01" }
  | { kind: "enum"; values: string[] }
  | { kind: "int"; min: number; max: number }
  | { kind: "sha256" }
  | { kind: "gitsha" }
  | { kind: "releaseid" }
  | { kind: "uuid" }
  | { kind: "path" };

/**
 * Every runtime flag the conveyor exports, typed. Unknown keys are rejected —
 * a typo'd flag must fail closed, not silently no-op. No secret material
 * belongs here; key names matching the secret pattern are rejected outright.
 */
export const FLAG_SCHEMA: Record<string, FlagSpec> = {
  SF_LINEAR_SYNC: { kind: "bool01" },
  SF_PR_OPEN: { kind: "bool01" },
  SF002_CLASSIFY: { kind: "bool01" },
  SF002_ENFORCE: { kind: "bool01" },
  SF002_REPUTATION: { kind: "bool01" },
  SF002_REPUTATION_ENFORCE: { kind: "bool01" },
  SF002_AUTO_PROMOTE: { kind: "bool01" },
  SF003_POOL: { kind: "bool01" },
  SF003_POOL_MODE: { kind: "enum", values: ["off", "shadow", "act"] },
  SF003_POOL_MAX_DISPATCH: { kind: "int", min: 0, max: 16 },
  SF004_METRICS: { kind: "bool01" },
  SF005_SLO: { kind: "bool01" },
  SF006_DEDUP: { kind: "bool01" },
  SF006_ENFORCE: { kind: "bool01" },
  SF007_SIGNALS: { kind: "bool01" },
  SF007_AUTOFILE: { kind: "enum", values: ["off", "unlabeled", "labeled"] },
  SF008_FLEET: { kind: "bool01" },
  SF009_SCENARIOS: { kind: "bool01" },
  SF010_CERTIFY: { kind: "bool01" },
  SF010_AUTOMERGE: { kind: "bool01" },
  SF011_LINES: { kind: "bool01" },
  SF011_ENFORCE: { kind: "bool01" },
  SF012_SURVIVAL: { kind: "bool01" },
  SF012_FEEDBACK: { kind: "bool01" },
  SF_PRESPEC: { kind: "bool01" },
  SF_PRESPEC_TOP_N: { kind: "int", min: 0, max: 10 },
  SF_PRESPEC_COOLDOWN_HOURS: { kind: "int", min: 0, max: 720 },
  SF_HETZNER_EXECUTOR: { kind: "bool01" },
  SF_EXEC_ISOLATED_WORKTREE: { kind: "bool01" },
  SF_EXEC_HARNESS_CHAIN: { kind: "enum", values: ["claude-code,opencode,codex,gemini,pi,kimi", "claude-code,codex,gemini"] },
  SF_FACTORY_CONSENSUS: { kind: "bool01" },
  FACTORY_HOLD_NOTIFY_ENFORCE: { kind: "bool01" },
  FACTORY_MODEL_REVIEW: { kind: "enum", values: ["off", "advisory", "enforce"] },
  FACTORY_SERIAL_PROMOTION: { kind: "enum", values: ["off", "shadow", "enforce"] },
  FACTORY_REVIEW_GATE_MODE: { kind: "enum", values: ["off", "shadow", "enforce"] },
  FACTORY_PERSONA_ROUTING_MODE: { kind: "enum", values: ["off", "shadow", "enforce"] },
  FACTORY_CODING_CASCADE: { kind: "enum", values: ["off", "enforce"] },
  FACTORY_PRODUCT_GATE: { kind: "bool01" },
  FACTORY_PRODUCT_GATE_ENFORCE: { kind: "bool01" },
  OUTCOME_EVIDENCE_MODE: { kind: "enum", values: ["off", "shadow", "advisory", "bounded_canary", "enforce"] },
  FACTORY_INFLIGHT_CAP: { kind: "int", min: 1, max: 3 },
  FACTORY_STATE_MUTATION_EVIDENCE: { kind: "enum", values: ["off", "shadow", "enforce"] },
  FACTORY_CONVEYOR_RUNNER_MODE: { kind: "enum", values: ["off", "parity_shadow"] },
  FACTORY_CONVEYOR_INCUMBENT_COMMIT: { kind: "gitsha" },
  FACTORY_CONVEYOR_RUNNER_RELEASE_ID: { kind: "releaseid" },
  FACTORY_RECEIPT_SHADOW_MODE: { kind: "enum", values: ["off", "shadow"] },
  FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: { kind: "sha256" },
  FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH: { kind: "sha256" },
  FACTORY_RECEIPT_SHADOW_AUTOMATION_ID: { kind: "uuid" },
  FACTORY_RECEIPT_SHADOW_DB_PATH: { kind: "path" },
  FACTORY_RECEIPT_SHADOW_REGISTRY_PATH: { kind: "path" },
  PLAN_GATE_MODE: { kind: "enum", values: ["off", "shadow", "enforce"] },
  PLAN_GATE_LEDGER_PATH: { kind: "path" },
  PLAN_GATE_EVIDENCE_STATUS_PATH: { kind: "path" },
  ZOUROBOROS_PLAN_GATE_MODULE: { kind: "path" },
};

const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;
const OPTIONAL_FLAG_SCHEMA: Record<string, FlagSpec> = {
  FACTORY_PATH_PROFILE: { kind: "path" },
  FACTORY_PATH_PROFILE_SHA256: { kind: "sha256" },
};
const FLAG_MIGRATION_PREIMAGES: Partial<Record<string, string>> = {
  SF_EXEC_HARNESS_CHAIN: "claude-code,codex,gemini",
  OUTCOME_EVIDENCE_MODE: "off",
};

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RuntimeConfigFile {
  version: number;
  updated_at: string;
  updated_by: string;
  flags: Record<string, string>;
}

export type LoadResult =
  | { ok: true; config: RuntimeConfigFile; hash: string }
  | { ok: false; errors: string[] };

export const RECEIPT_SHADOW_EXTERNAL_CONFIG_CONTRACT_ID = "zouroboros-run-receipt-shadow-config/v1" as const;
export const RECEIPT_SHADOW_EXTERNAL_CONFIG_ENV = "FACTORY_RECEIPT_SHADOW_CONFIG_PATH" as const;
export const RECEIPT_SHADOW_POLICY_PATH = "/home/workspace/Skills/zouroboros-governance/config/autonomy-policy.json" as const;
export const RECEIPT_SHADOW_DATABASE_PATH = "/home/workspace/.runtime/evidence-substrate/state/run-receipt-shadow.sqlite" as const;
export const RECEIPT_SHADOW_REGISTRY_PATH = "/home/workspace/.runtime/evidence-substrate/config/run-receipt-shadow-adapters.json" as const;

export interface ReceiptShadowPathValidationOptions {
  testRoot?: string;
}

export interface ReceiptShadowExternalConfig {
  contract_id: typeof RECEIPT_SHADOW_EXTERNAL_CONFIG_CONTRACT_ID;
  version: 1;
  updated_at: string;
  updated_by: string;
  mode: "off" | "shadow";
  activation_manifest_sha256: string;
  effective_config_sha256: string;
  automation_id: string;
  runtime: "zo-native";
  policy_path: string;
  policy_sha256: string;
  database_path: string;
  registry_path: string;
  registry_sha256: string;
  cohort_amendment_sha256: string;
  qualification_window_days: number;
  required_operations_per_class: number;
  max_plans_per_harvest: number;
  max_database_bytes: number;
  write_high_water_bytes: number;
  github_readback_enabled: boolean;
}

export type ReceiptShadowExternalConfigResult =
  | { ok: true; config: ReceiptShadowExternalConfig; effectiveHash: string }
  | { ok: false; errors: string[] };

export interface DivergenceEntry {
  flag: string;
  config_value: string;
  env_value: string;
}

export interface ReceiptShadowAuthorityPaths {
  configPath?: string;
  previousPath?: string;
  externalConfigOptions?: ReceiptShadowPathValidationOptions;
}

export type ReceiptShadowAuthorityResult =
  | { ok: true; config: RuntimeConfigFile; hash: string; changed: boolean }
  | { ok: false; errors: string[] };

export interface ConveyorParityAuthorityPaths {
  configPath?: string;
  preimagePath?: string;
  previousPath?: string;
  stateDir?: string;
}

export type ConveyorParityAuthorityResult =
  | { ok: true; config: RuntimeConfigFile; hash: string; changed: boolean }
  | { ok: false; errors: string[] };

export interface ConveyorParityAuthorityStatus {
  valid: boolean;
  mode: string | null;
  incumbent_commit: string | null;
  runner_release_id: string | null;
  rollback_preimage_present: boolean;
  errors: string[];
}

const RECEIPT_SHADOW_CONFIG_KEYS = [
  "contract_id",
  "version",
  "updated_at",
  "updated_by",
  "mode",
  "activation_manifest_sha256",
  "effective_config_sha256",
  "automation_id",
  "runtime",
  "policy_path",
  "policy_sha256",
  "database_path",
  "registry_path",
  "registry_sha256",
  "cohort_amendment_sha256",
  "qualification_window_days",
  "required_operations_per_class",
  "max_plans_per_harvest",
  "max_database_bytes",
  "write_high_water_bytes",
  "github_readback_enabled",
] as const;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function receiptShadowExternalConfigHash(config: ReceiptShadowExternalConfig): string {
  const normalized = { ...config, effective_config_sha256: "0".repeat(64) };
  return createHash("sha256").update(canonicalJson(normalized)).digest("hex");
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel.length > 0 && rel !== ".." && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(rel);
}

function validReceiptPath(path: unknown, expected: string, testRoot?: string): boolean {
  if (typeof path !== "string" || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path || path === "/") return false;
  return testRoot ? isContained(testRoot, path) : path === expected;
}

export function validateReceiptShadowExternalConfig(raw: unknown, options: ReceiptShadowPathValidationOptions = {}): ReceiptShadowExternalConfigResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, errors: ["receipt shadow config root must be an object"] };
  const value = raw as Record<string, unknown>;
  const errors: string[] = [];
  const expectedKeys = new Set<string>(RECEIPT_SHADOW_CONFIG_KEYS);
  for (const key of Object.keys(value)) if (!expectedKeys.has(key)) errors.push(`${key}: unknown receipt shadow config field`);
  for (const key of RECEIPT_SHADOW_CONFIG_KEYS) if (!(key in value)) errors.push(`${key}: missing receipt shadow config field`);
  if (value.contract_id !== RECEIPT_SHADOW_EXTERNAL_CONFIG_CONTRACT_ID) errors.push("contract_id: invalid receipt shadow config contract");
  if (value.version !== 1) errors.push("version: expected 1");
  if (typeof value.updated_at !== "string" || Number.isNaN(Date.parse(value.updated_at))) errors.push("updated_at: expected RFC 3339 timestamp");
  if (typeof value.updated_by !== "string" || value.updated_by.length === 0) errors.push("updated_by: expected non-empty string");
  if (value.mode !== "off" && value.mode !== "shadow") errors.push("mode: expected off or shadow");
  for (const key of ["activation_manifest_sha256", "effective_config_sha256", "policy_sha256", "registry_sha256", "cohort_amendment_sha256"] as const) {
    if (typeof value[key] !== "string" || !/^[0-9a-f]{64}$/.test(value[key])) errors.push(`${key}: expected lowercase SHA-256`);
  }
  if (typeof value.automation_id !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.automation_id)) errors.push("automation_id: expected lowercase UUID");
  if (value.runtime !== "zo-native") errors.push("runtime: expected zo-native");
  if (!validReceiptPath(value.policy_path, RECEIPT_SHADOW_POLICY_PATH, options.testRoot)) errors.push("policy_path: expected absolute path within approved boundary");
  if (!validReceiptPath(value.database_path, RECEIPT_SHADOW_DATABASE_PATH, options.testRoot)) errors.push("database_path: expected absolute path within approved boundary");
  if (!validReceiptPath(value.registry_path, RECEIPT_SHADOW_REGISTRY_PATH, options.testRoot)) errors.push("registry_path: expected absolute path within approved boundary");
  const integerBounds: Array<[keyof ReceiptShadowExternalConfig, number, number]> = [
    ["qualification_window_days", 1, 365],
    ["required_operations_per_class", 1, 100],
    ["max_plans_per_harvest", 1, 12],
    ["max_database_bytes", 1, 64 * 1024 * 1024],
    ["write_high_water_bytes", 1, 63 * 1024 * 1024],
  ];
  for (const [key, minimum, maximum] of integerBounds) {
    const candidate = value[key];
    if (!Number.isInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) errors.push(`${key}: expected integer in [${minimum}, ${maximum}]`);
  }
  if (Number(value.write_high_water_bytes) >= Number(value.max_database_bytes)) errors.push("write_high_water_bytes: must be below max_database_bytes");
  if (typeof value.github_readback_enabled !== "boolean") errors.push("github_readback_enabled: expected boolean");
  if (errors.length > 0) return { ok: false, errors };
  const config = value as unknown as ReceiptShadowExternalConfig;
  const effectiveHash = receiptShadowExternalConfigHash(config);
  const zero = "0".repeat(64);
  if (config.mode === "off" && (config.activation_manifest_sha256 !== zero || config.effective_config_sha256 !== zero)) {
    return { ok: false, errors: ["off mode requires zero activation and effective config hashes"] };
  }
  if (config.mode === "shadow" && (config.activation_manifest_sha256 === zero || config.effective_config_sha256 !== effectiveHash)) {
    return { ok: false, errors: ["shadow mode requires nonzero activation hash and exact self-reference-free effective config hash"] };
  }
  return { ok: true, config, effectiveHash };
}

export function loadReceiptShadowExternalConfig(path: string, options: ReceiptShadowPathValidationOptions = {}): ReceiptShadowExternalConfigResult {
  if (!path || path.includes("\0") || !isAbsolute(path) || resolve(path) !== path || path === "/") {
    return { ok: false, errors: ["receipt shadow config path must be normalized and absolute"] };
  }
  if (!existsSync(path)) return { ok: false, errors: [`receipt shadow config missing: ${path}`] };
  try {
    return validateReceiptShadowExternalConfig(JSON.parse(readFileSync(path, "utf8")) as unknown, options);
  } catch (error) {
    return { ok: false, errors: [`receipt shadow config unparseable: ${error instanceof Error ? error.message : String(error)}`] };
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

export function validateFlagValue(key: string, value: string, spec: FlagSpec): string | null {
  switch (spec.kind) {
    case "bool01":
      return value === "0" || value === "1" ? null : `${key}: expected "0" or "1", got "${value}"`;
    case "enum":
      return spec.values.includes(value) ? null : `${key}: expected one of [${spec.values.join(", ")}], got "${value}"`;
    case "int": {
      const n = Number(value);
      if (!Number.isInteger(n)) return `${key}: expected an integer, got "${value}"`;
      if (n < spec.min || n > spec.max) return `${key}: ${n} outside [${spec.min}, ${spec.max}]`;
      return null;
    }
    case "sha256":
      return /^[0-9a-f]{64}$/.test(value) ? null : `${key}: expected a lowercase SHA-256 digest, got "${value}"`;
    case "gitsha":
      return /^[0-9a-f]{40}$/.test(value) ? null : `${key}: expected an exact lowercase Git commit, got "${value}"`;
    case "releaseid":
      return /^rel-[0-9a-f]{24}$/.test(value) ? null : `${key}: expected an exact runner release id, got "${value}"`;
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
        ? null
        : `${key}: expected a lowercase UUID, got "${value}"`;
    case "path":
      return value.startsWith("/") ? null : `${key}: expected an absolute path, got "${value}"`;
  }
}

export function validateConfig(raw: unknown): { errors: string[]; config?: RuntimeConfigFile } {
  const errors: string[] = [];
  if (typeof raw !== "object" || raw === null) return { errors: ["config root is not an object"] };
  const obj = raw as Record<string, unknown>;
  if (typeof obj.version !== "number" || !Number.isInteger(obj.version) || obj.version < 1) {
    errors.push("version: expected a positive integer");
  }
  if (typeof obj.updated_at !== "string" || Number.isNaN(Date.parse(obj.updated_at))) {
    errors.push("updated_at: expected an ISO timestamp");
  }
  if (typeof obj.updated_by !== "string" || obj.updated_by.length === 0) {
    errors.push("updated_by: expected a non-empty string");
  }
  if (typeof obj.flags !== "object" || obj.flags === null) {
    errors.push("flags: expected an object");
    return { errors };
  }
  const flags = obj.flags as Record<string, unknown>;
  for (const [key, value] of Object.entries(flags)) {
    if (SECRET_NAME_PATTERN.test(key)) {
      errors.push(`${key}: secret-like flag names are forbidden in runtime config`);
      continue;
    }
    const spec = FLAG_SCHEMA[key] ?? OPTIONAL_FLAG_SCHEMA[key];
    if (!spec) {
      errors.push(`${key}: unknown flag — not in the typed schema (fail closed, no silent no-op)`);
      continue;
    }
    if (typeof value !== "string") {
      errors.push(`${key}: expected a string value, got ${typeof value}`);
      continue;
    }
    const err = validateFlagValue(key, value, spec);
    if (err) errors.push(err);
  }
  for (const key of Object.keys(FLAG_SCHEMA)) {
    if (!(key in flags)) errors.push(`${key}: missing from config — every schema flag must have an explicit value`);
  }
  if ((flags.FACTORY_PATH_PROFILE === undefined) !== (flags.FACTORY_PATH_PROFILE_SHA256 === undefined)) errors.push("Factory path profile requires both path and digest");
  const receiptMode = flags.FACTORY_RECEIPT_SHADOW_MODE;
  const receiptActivationHash = flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH;
  const receiptRuntimeConfigHash = flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH;
  const zero = "0".repeat(64);
  if (receiptMode === "off" && (receiptActivationHash !== zero || receiptRuntimeConfigHash !== zero)) {
    errors.push("receipt shadow off mode requires zero activation and runtime config hashes");
  }
  if (receiptMode === "shadow" && (receiptActivationHash === zero || receiptRuntimeConfigHash === zero)) {
    errors.push("receipt shadow mode requires nonzero activation and runtime config hashes");
  }
  const runnerMode = flags.FACTORY_CONVEYOR_RUNNER_MODE;
  const incumbentCommit = flags.FACTORY_CONVEYOR_INCUMBENT_COMMIT;
  const runnerRelease = flags.FACTORY_CONVEYOR_RUNNER_RELEASE_ID;
  const zeroCommit = "0".repeat(40);
  const zeroRelease = `rel-${"0".repeat(24)}`;
  if (runnerMode === "off" && (incumbentCommit !== zeroCommit || runnerRelease !== zeroRelease)) {
    errors.push("conveyor runner off mode requires zero incumbent and runner identities");
  }
  if (runnerMode === "parity_shadow" && (incumbentCommit === zeroCommit || runnerRelease === zeroRelease)) {
    errors.push("conveyor runner parity shadow requires exact nonzero incumbent and runner identities");
  }
  if (errors.length > 0) return { errors };
  return { errors, config: obj as unknown as RuntimeConfigFile };
}

// ─── Core API ─────────────────────────────────────────────────────────────────

export function configHash(flags: Record<string, string>): string {
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(flags).sort(([a], [b]) => (a < b ? -1 : 1))));
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function receiptShadowRuntimeConfigHash(
  env: Record<string, string | undefined> = process.env,
  path = CONFIG_PATH,
): string | null {
  const loaded = loadRuntimeConfig(path);
  if (!loaded.ok) return null;
  const effective = { ...loaded.config.flags };
  for (const key of Object.keys(FLAG_SCHEMA)) {
    if (env[key] !== undefined) effective[key] = env[key]!;
  }
  const validation = validateConfig({ ...loaded.config, flags: effective });
  if (validation.errors.length > 0) return null;
  effective.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH = "0".repeat(64);
  effective.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH = "0".repeat(64);
  const canonical = JSON.stringify(Object.fromEntries(Object.entries(effective).sort(([left], [right]) => left < right ? -1 : 1)));
  return createHash("sha256").update(canonical).digest("hex");
}

export function loadRuntimeConfig(path = CONFIG_PATH): LoadResult {
  if (!existsSync(path)) {
    return { ok: false, errors: [`missing config file: ${path} — fail closed, no defaults`] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    return { ok: false, errors: [`unparseable config: ${err instanceof Error ? err.message : String(err)}`] };
  }
  const { errors, config } = validateConfig(raw);
  if (!config) return { ok: false, errors };
  try {
    const selected = loadFactoryPathProfile(process.env);
    if (selected) {
      for (const key of ["FACTORY_PATH_PROFILE", "FACTORY_PATH_PROFILE_SHA256"]) {
        if (config.flags[key] !== process.env[key]) throw new Error(`Factory profile config divergence: ${key}`);
      }
    }
    loadFactoryPathProfile(config.flags);
  }
  catch (error) { return { ok: false, errors: [String(error)] }; }
  return { ok: true, config, hash: configHash(config.flags) };
}

/** Flags where the process env holds a DIFFERENT value than the authoritative config. */
export function divergenceFrom(config: RuntimeConfigFile, env: Record<string, string | undefined> = process.env): DivergenceEntry[] {
  const out: DivergenceEntry[] = [];
  for (const key of ["FACTORY_PATH_PROFILE", "FACTORY_PATH_PROFILE_SHA256"]) {
    if (env[key] !== undefined && config.flags[key] === undefined) out.push({ flag: key, config_value: "absent", env_value: env[key]! });
  }
  for (const [flag, configValue] of Object.entries(config.flags)) {
    const envValue = env[flag];
    if (envValue !== undefined && envValue !== configValue) {
      out.push({ flag, config_value: configValue, env_value: envValue });
    }
  }
  return out;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function exportEnvLines(config: RuntimeConfigFile): string[] {
  loadFactoryPathProfile(config.flags);
  return Object.entries(config.flags)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([k, v]) => `export ${k}=${shellQuote(v)}`);
}

export interface TickRecord {
  at: string;
  source: string;
  valid: boolean;
  version: number | null;
  hash: string | null;
  effective: Record<string, string> | null;
  divergence: DivergenceEntry[];
  errors: string[];
}

/**
 * Record the effective configuration for this conveyor tick. Never throws —
 * it is called from the conveyor's fail-soft hot path. Returns the record.
 */
export function recordTick(source: string, path = CONFIG_PATH, ticksPath = TICKS_PATH): TickRecord {
  let record: TickRecord;
  const loaded = loadRuntimeConfig(path);
  if (loaded.ok) {
    record = {
      at: new Date().toISOString(),
      source,
      valid: true,
      version: loaded.config.version,
      hash: loaded.hash,
      effective: loaded.config.flags,
      divergence: divergenceFrom(loaded.config),
      errors: [],
    };
  } else {
    record = {
      at: new Date().toISOString(),
      source,
      valid: false,
      version: null,
      hash: null,
      effective: null,
      divergence: [],
      errors: loaded.errors,
    };
  }
  try {
    mkdirSync(dirname(ticksPath), { recursive: true });
    appendFileSync(ticksPath, `${JSON.stringify(record)}\n`);
  } catch {
    // fail-soft: tick recording must never break the conveyor
  }
  return record;
}

function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, content);
  renameSync(tmp, path);
}

function logTransition(line: string): void {
  try {
    mkdirSync(dirname(TRANSITIONS_PATH), { recursive: true });
    appendFileSync(TRANSITIONS_PATH, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    // advisory log only
  }
}

function explicitConveyorOff(config: RuntimeConfigFile): boolean {
  return config.flags.FACTORY_CONVEYOR_RUNNER_MODE === "off"
    && config.flags.FACTORY_CONVEYOR_INCUMBENT_COMMIT === "0".repeat(40)
    && config.flags.FACTORY_CONVEYOR_RUNNER_RELEASE_ID === `rel-${"0".repeat(24)}`;
}

export function activateConveyorParityShadow(
  manifestPath: string,
  by: string,
  paths: ConveyorParityAuthorityPaths = {},
): ConveyorParityAuthorityResult {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const preimagePath = paths.preimagePath ?? CONVEYOR_PARITY_PREIMAGE_PATH;
  const previousPath = paths.previousPath ?? PREVIOUS_PATH;
  if (!by.trim()) return { ok: false, errors: ["conveyor parity activation requires a non-empty operator identity"] };
  const loaded = loadRuntimeConfig(configPath);
  if (!loaded.ok) return { ok: false, errors: ["cannot activate conveyor parity on invalid runtime config", ...loaded.errors] };

  let manifest: ConveyorReleaseManifest;
  let stateRoot: string;
  try {
    stateRoot = resolveFactoryStateOverride(paths.stateDir);
    const marker = validateFactoryStateMarker(stateRoot);
    manifest = readConveyorReleaseManifest(manifestPath);
    if (resolve(manifestPath) !== conveyorReleaseManifestPath(manifest.release_id, stateRoot)) {
      return { ok: false, errors: ["conveyor parity activation requires the canonical recorded release manifest path"] };
    }
    if (
      manifest.state_namespace !== marker.namespace
      || manifest.state_schema_version !== marker.schema_version
      || manifest.state_root_id !== marker.root_id
      || manifest.state_generation !== marker.generation
    ) {
      return { ok: false, errors: ["conveyor release manifest does not match the active factory state identity"] };
    }
  } catch (error) {
    return { ok: false, errors: [`conveyor release manifest is invalid: ${error instanceof Error ? error.message : String(error)}`] };
  }

  const tuple: Record<string, string> = {
    FACTORY_CONVEYOR_RUNNER_MODE: "parity_shadow",
    FACTORY_CONVEYOR_INCUMBENT_COMMIT: manifest.runtime.merge_commit,
    FACTORY_CONVEYOR_RUNNER_RELEASE_ID: manifest.release_id,
  };
  const alreadyActive = Object.entries(tuple).every(([key, value]) => loaded.config.flags[key] === value);
  if (alreadyActive) {
    const preimage = loadRuntimeConfig(preimagePath);
    if (!preimage.ok || !explicitConveyorOff(preimage.config)) {
      return { ok: false, errors: ["conveyor parity is active without a valid exact off rollback preimage", ...(!preimage.ok ? preimage.errors : [])] };
    }
    return { ok: true, config: loaded.config, hash: loaded.hash, changed: false };
  }
  if (!explicitConveyorOff(loaded.config)) {
    return { ok: false, errors: ["conveyor parity activation requires an explicit off preimage with zero identities"] };
  }

  const currentBytes = readFileSync(configPath, "utf8");
  atomicWrite(preimagePath, currentBytes);
  const next: RuntimeConfigFile = {
    version: loaded.config.version + 1,
    updated_at: new Date().toISOString(),
    updated_by: by,
    flags: { ...loaded.config.flags, ...tuple },
  };
  const validation = validateConfig(next);
  if (!validation.config) return { ok: false, errors: validation.errors };
  atomicWrite(previousPath, currentBytes);
  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  const hash = configHash(next.flags);
  logTransition(`activate conveyor parity shadow ${manifest.release_id} by ${by} | v${loaded.config.version} → v${next.version} | hash ${loaded.hash} → ${hash}`);
  return { ok: true, config: next, hash, changed: true };
}

export function rollbackConveyorParityShadow(
  by: string,
  paths: Pick<ConveyorParityAuthorityPaths, "configPath" | "preimagePath" | "previousPath"> = {},
): ConveyorParityAuthorityResult {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const preimagePath = paths.preimagePath ?? CONVEYOR_PARITY_PREIMAGE_PATH;
  const previousPath = paths.previousPath ?? PREVIOUS_PATH;
  if (!by.trim()) return { ok: false, errors: ["conveyor parity rollback requires a non-empty operator identity"] };
  const current = loadRuntimeConfig(configPath);
  if (!current.ok) return { ok: false, errors: ["cannot roll back invalid conveyor parity runtime config", ...current.errors] };
  const preimage = loadRuntimeConfig(preimagePath);
  if (!preimage.ok || !explicitConveyorOff(preimage.config)) {
    return { ok: false, errors: ["no valid dedicated conveyor parity off preimage to restore", ...(!preimage.ok ? preimage.errors : [])] };
  }
  if (explicitConveyorOff(current.config)) {
    return { ok: true, config: current.config, hash: current.hash, changed: false };
  }
  if (current.config.flags.FACTORY_CONVEYOR_RUNNER_MODE !== "parity_shadow") {
    return { ok: false, errors: ["conveyor parity rollback requires current mode=parity_shadow"] };
  }
  const next: RuntimeConfigFile = {
    version: current.config.version + 1,
    updated_at: new Date().toISOString(),
    updated_by: by,
    flags: {
      ...current.config.flags,
      FACTORY_CONVEYOR_RUNNER_MODE: preimage.config.flags.FACTORY_CONVEYOR_RUNNER_MODE,
      FACTORY_CONVEYOR_INCUMBENT_COMMIT: preimage.config.flags.FACTORY_CONVEYOR_INCUMBENT_COMMIT,
      FACTORY_CONVEYOR_RUNNER_RELEASE_ID: preimage.config.flags.FACTORY_CONVEYOR_RUNNER_RELEASE_ID,
    },
  };
  const validation = validateConfig(next);
  if (!validation.config) return { ok: false, errors: validation.errors };
  atomicWrite(previousPath, readFileSync(configPath, "utf8"));
  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  const restored = loadRuntimeConfig(configPath);
  if (!restored.ok) return { ok: false, errors: ["restored conveyor parity preimage is invalid", ...restored.errors] };
  logTransition(`rollback conveyor parity shadow by ${by} | v${current.config.version} → v${restored.config.version} | restored authority tuple with hash ${restored.hash}`);
  return { ok: true, config: restored.config, hash: restored.hash, changed: true };
}

export function conveyorParityAuthorityStatus(
  paths: Pick<ConveyorParityAuthorityPaths, "configPath" | "preimagePath"> = {},
): ConveyorParityAuthorityStatus {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const preimagePath = paths.preimagePath ?? CONVEYOR_PARITY_PREIMAGE_PATH;
  const loaded = loadRuntimeConfig(configPath);
  if (!loaded.ok) {
    return {
      valid: false,
      mode: null,
      incumbent_commit: null,
      runner_release_id: null,
      rollback_preimage_present: existsSync(preimagePath),
      errors: loaded.errors,
    };
  }
  return {
    valid: true,
    mode: loaded.config.flags.FACTORY_CONVEYOR_RUNNER_MODE ?? null,
    incumbent_commit: loaded.config.flags.FACTORY_CONVEYOR_INCUMBENT_COMMIT ?? null,
    runner_release_id: loaded.config.flags.FACTORY_CONVEYOR_RUNNER_RELEASE_ID ?? null,
    rollback_preimage_present: existsSync(preimagePath),
    errors: [],
  };
}

/** Versioned, validated, atomic single-flag update. Previous config is preserved for rollback. */
export function setFlag(
  key: string,
  value: string,
  by: string,
  paths: { configPath?: string; previousPath?: string } = {}
): { ok: true; config: RuntimeConfigFile; hash: string } | { ok: false; errors: string[] } {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const previousPath = paths.previousPath ?? PREVIOUS_PATH;
  const spec = FLAG_SCHEMA[key];
  if (!spec) return { ok: false, errors: [`${key}: unknown flag — not in the typed schema`] };
  const err = validateFlagValue(key, value, spec);
  if (err) return { ok: false, errors: [err] };
  const loaded = loadRuntimeConfig(configPath);
  let base: RuntimeConfigFile;
  let baseHash: string;
  if (loaded.ok) {
    base = loaded.config;
    baseHash = loaded.hash;
  } else {
    const missingError = `${key}: missing from config — every schema flag must have an explicit value`;
    const preimageValue = FLAG_MIGRATION_PREIMAGES[key];
    if (preimageValue === undefined || loaded.errors.length !== 1 || loaded.errors[0] !== missingError) {
      return { ok: false, errors: [`cannot set on invalid config — repair or rollback first`, ...loaded.errors] };
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    } catch (parseError) {
      return { ok: false, errors: [`cannot set on invalid config — repair or rollback first`, `unparseable config: ${parseError instanceof Error ? parseError.message : String(parseError)}`] };
    }
    const parsed = raw as RuntimeConfigFile;
    const migrationPreimage = { ...parsed, flags: { ...parsed.flags, [key]: preimageValue } };
    const validation = validateConfig(migrationPreimage);
    if (!validation.config) {
      return { ok: false, errors: [`cannot construct valid rollback preimage`, ...validation.errors] };
    }
    base = validation.config;
    baseHash = configHash(base.flags);
  }
  const next: RuntimeConfigFile = {
    version: base.version + 1,
    updated_at: new Date().toISOString(),
    updated_by: by,
    flags: { ...base.flags, [key]: value },
  };
  const validation = validateConfig(next);
  if (!validation.config) return { ok: false, errors: validation.errors };
  atomicWrite(previousPath, JSON.stringify(base, null, 2) + "\n");
  atomicWrite(configPath, JSON.stringify(next, null, 2) + "\n");
  const hash = configHash(next.flags);
  logTransition(`set ${key}=${value} by ${by} | v${base.version} → v${next.version} | hash ${baseHash} → ${hash}`);
  return { ok: true, config: next, hash };
}

export function bindFactoryPathProfile(
  profilePath: string,
  profileDigest: string,
  expectedConfigHash: string,
  by: string,
  paths: { configPath?: string; previousPath?: string } = {},
): { ok: true; config: RuntimeConfigFile; hash: string; changed: boolean } | { ok: false; errors: string[] } {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const previousPath = paths.previousPath ?? PREVIOUS_PATH;
  const loaded = loadRuntimeConfig(configPath);
  if (!loaded.ok) return loaded;
  const binding = { FACTORY_PATH_PROFILE: profilePath, FACTORY_PATH_PROFILE_SHA256: profileDigest };
  try { loadFactoryPathProfile(binding); }
  catch (error) { return { ok: false, errors: [String(error)] }; }
  if (Object.entries(binding).every(([key, value]) => loaded.config.flags[key] === value)) {
    return { ...loaded, changed: false };
  }
  if (loaded.hash !== expectedConfigHash) return { ok: false, errors: ["Factory profile config preimage changed"] };
  const next = { ...loaded.config, version: loaded.config.version + 1, updated_at: new Date().toISOString(), updated_by: by, flags: { ...loaded.config.flags, ...binding } };
  const validated = validateConfig(next);
  if (!validated.config) return { ok: false, errors: validated.errors };
  atomicWrite(previousPath, JSON.stringify(loaded.config, null, 2) + "\n");
  atomicWrite(configPath, JSON.stringify(next, null, 2) + "\n");
  return { ok: true, config: next, hash: configHash(next.flags), changed: true };
}

export function activateReceiptShadowAuthority(
  externalConfigPath: string,
  by: string,
  paths: ReceiptShadowAuthorityPaths = {},
): ReceiptShadowAuthorityResult {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const previousPath = paths.previousPath ?? PREVIOUS_PATH;
  if (!by.trim()) return { ok: false, errors: ["receipt shadow authority requires a non-empty operator identity"] };
  const loaded = loadRuntimeConfig(configPath);
  if (!loaded.ok) return { ok: false, errors: ["cannot activate receipt shadow on invalid runtime config", ...loaded.errors] };
  const external = loadReceiptShadowExternalConfig(externalConfigPath, paths.externalConfigOptions);
  if (!external.ok) return { ok: false, errors: ["receipt shadow external config is invalid", ...external.errors] };
  if (external.config.mode !== "shadow") return { ok: false, errors: ["receipt shadow activation requires external config mode=shadow"] };

  const bindingErrors: string[] = [];
  const bindings: Array<[string, string, string]> = [
    ["automation id", loaded.config.flags.FACTORY_RECEIPT_SHADOW_AUTOMATION_ID!, external.config.automation_id],
    ["database path", loaded.config.flags.FACTORY_RECEIPT_SHADOW_DB_PATH!, external.config.database_path],
    ["registry path", loaded.config.flags.FACTORY_RECEIPT_SHADOW_REGISTRY_PATH!, external.config.registry_path],
  ];
  for (const [label, current, expected] of bindings) {
    if (current !== expected) bindingErrors.push(`receipt shadow ${label} does not match the external config`);
  }
  if (bindingErrors.length > 0) return { ok: false, errors: bindingErrors };

  const tuple: Record<string, string> = {
    FACTORY_RECEIPT_SHADOW_MODE: "shadow",
    FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH: external.config.activation_manifest_sha256,
    FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH: external.config.effective_config_sha256,
  };
  const alreadyActive = Object.entries(tuple).every(([key, value]) => loaded.config.flags[key] === value);
  if (alreadyActive) return { ok: true, config: loaded.config, hash: loaded.hash, changed: false };

  const zero = "0".repeat(64);
  if (
    loaded.config.flags.FACTORY_RECEIPT_SHADOW_MODE !== "off" ||
    loaded.config.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH !== zero ||
    loaded.config.flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH !== zero
  ) {
    return { ok: false, errors: ["receipt shadow activation requires an explicit off preimage with zero authority hashes"] };
  }

  const next: RuntimeConfigFile = {
    version: loaded.config.version + 1,
    updated_at: new Date().toISOString(),
    updated_by: by,
    flags: { ...loaded.config.flags, ...tuple },
  };
  const validation = validateConfig(next);
  if (!validation.config) return { ok: false, errors: validation.errors };
  const previousBytes = readFileSync(configPath, "utf8");
  atomicWrite(previousPath, previousBytes);
  atomicWrite(configPath, `${JSON.stringify(next, null, 2)}\n`);
  const hash = configHash(next.flags);
  logTransition(`activate receipt shadow by ${by} | v${loaded.config.version} → v${next.version} | hash ${loaded.hash} → ${hash}`);
  return { ok: true, config: next, hash, changed: true };
}

export function rollbackReceiptShadowAuthority(
  by: string,
  paths: Pick<ReceiptShadowAuthorityPaths, "configPath" | "previousPath"> = {},
): ReceiptShadowAuthorityResult {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const previousPath = paths.previousPath ?? PREVIOUS_PATH;
  if (!by.trim()) return { ok: false, errors: ["receipt shadow rollback requires a non-empty operator identity"] };
  const current = loadRuntimeConfig(configPath);
  if (!current.ok) return { ok: false, errors: ["cannot roll back invalid receipt shadow runtime config", ...current.errors] };
  if (current.config.flags.FACTORY_RECEIPT_SHADOW_MODE !== "shadow") {
    return { ok: false, errors: ["receipt shadow rollback requires current mode=shadow"] };
  }
  const previous = loadRuntimeConfig(previousPath);
  if (!previous.ok) return { ok: false, errors: ["no valid exact receipt shadow preimage to restore", ...previous.errors] };
  const zero = "0".repeat(64);
  if (
    previous.config.flags.FACTORY_RECEIPT_SHADOW_MODE !== "off" ||
    previous.config.flags.FACTORY_RECEIPT_SHADOW_ACTIVATION_HASH !== zero ||
    previous.config.flags.FACTORY_RECEIPT_SHADOW_RUNTIME_CONFIG_HASH !== zero
  ) {
    return { ok: false, errors: ["receipt shadow rollback preimage is not explicit off with zero authority hashes"] };
  }
  const previousBytes = readFileSync(previousPath, "utf8");
  atomicWrite(configPath, previousBytes);
  const restored = loadRuntimeConfig(configPath);
  if (!restored.ok) return { ok: false, errors: ["restored receipt shadow preimage is invalid", ...restored.errors] };
  logTransition(`rollback receipt shadow by ${by} | restored exact v${restored.config.version} preimage with hash ${restored.hash}`);
  return { ok: true, config: restored.config, hash: restored.hash, changed: true };
}

/** Atomic rollback to the previous known-good configuration. */
export function rollbackConfig(
  by: string,
  paths: { configPath?: string; previousPath?: string } = {}
): { ok: true; config: RuntimeConfigFile; hash: string } | { ok: false; errors: string[] } {
  const configPath = paths.configPath ?? CONFIG_PATH;
  const previousPath = paths.previousPath ?? PREVIOUS_PATH;
  const prev = loadRuntimeConfig(previousPath);
  if (!prev.ok) return { ok: false, errors: [`no valid previous config to roll back to`, ...prev.errors] };
  const current = loadRuntimeConfig(configPath);
  const restored: RuntimeConfigFile = {
    ...prev.config,
    version: (current.ok ? current.config.version : prev.config.version) + 1,
    updated_at: new Date().toISOString(),
    updated_by: `rollback by ${by}`,
  };
  if (current.ok) {
    atomicWrite(previousPath, JSON.stringify(current.config, null, 2) + "\n");
  }
  atomicWrite(configPath, JSON.stringify(restored, null, 2) + "\n");
  const hash = configHash(restored.flags);
  logTransition(`rollback by ${by} | restored flags from previous (now v${restored.version}, hash ${hash})`);
  return { ok: true, config: restored, hash };
}

/** Compact snapshot for status surfaces (shadow-validate, lever-board). */
export interface RuntimeConfigSnapshot {
  present: boolean;
  valid: boolean;
  version: number | null;
  hash: string | null;
  divergence_count: number;
  errors: string[];
}

export function runtimeConfigSnapshot(path = CONFIG_PATH): RuntimeConfigSnapshot {
  const loaded = loadRuntimeConfig(path);
  if (!loaded.ok) {
    return { present: existsSync(path), valid: false, version: null, hash: null, divergence_count: 0, errors: loaded.errors };
  }
  return {
    present: true,
    valid: true,
    version: loaded.config.version,
    hash: loaded.hash,
    divergence_count: divergenceFrom(loaded.config).length,
    errors: [],
  };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function fail(errors: string[], code: number): never {
  for (const e of errors) console.error(`INVALID: ${e}`);
  process.exit(code);
}

function main(): void {
  const argv = Bun.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "bind-path-profile") {
    const arg = (name: string) => argv[argv.indexOf(name) + 1];
    if (!["--path", "--sha256", "--expected-config-hash", "--by"].every(name => argv.includes(name) && arg(name))) fail(["bind-path-profile requires --path, --sha256, --expected-config-hash and --by"], 2);
    const result = bindFactoryPathProfile(arg("--path"), arg("--sha256"), arg("--expected-config-hash"), arg("--by"));
    if (!result.ok) fail(result.errors, 3);
    console.log(JSON.stringify({ changed: result.changed, hash: result.hash, version: result.config.version }));
    return;
  }

  if (cmd === "validate") {
    const loaded = loadRuntimeConfig();
    if (!loaded.ok) fail(loaded.errors, 3);
    console.log(`valid: v${loaded.config.version} hash=${loaded.hash} flags=${Object.keys(loaded.config.flags).length} updated_by="${loaded.config.updated_by}"`);
    process.exit(0);
  }

  if (cmd === "export-env") {
    const loaded = loadRuntimeConfig();
    if (!loaded.ok) fail(loaded.errors, 3);
    for (const line of exportEnvLines(loaded.config)) console.log(line);
    process.exit(0);
  }

  if (cmd === "check") {
    const loaded = loadRuntimeConfig();
    if (!loaded.ok) fail(loaded.errors, 3);
    const div = divergenceFrom(loaded.config);
    if (div.length > 0) {
      console.error(`DIVERGENT: ${div.length} flag(s) differ between env and authoritative config:`);
      for (const d of div) console.error(`  ${d.flag}: env="${d.env_value}" config="${d.config_value}"`);
      process.exit(1);
    }
    console.log(`clean: env matches v${loaded.config.version} (hash ${loaded.hash})`);
    process.exit(0);
  }

  if (cmd === "record-tick") {
    const srcIdx = argv.indexOf("--source");
    const source = srcIdx >= 0 ? (argv[srcIdx + 1] ?? "cli") : "cli";
    const record = recordTick(source);
    console.log(JSON.stringify({ valid: record.valid, version: record.version, hash: record.hash, divergence: record.divergence.length, errors: record.errors }));
    process.exit(record.valid ? 0 : 3);
  }

  if (cmd === "set") {
    const key = argv[1];
    const value = argv[2];
    const byIdx = argv.indexOf("--by");
    const by = byIdx >= 0 ? argv[byIdx + 1] : undefined;
    if (!key || value === undefined || !by) {
      console.error("Usage: runtime-config.ts set KEY VALUE --by <who>");
      process.exit(2);
    }
    const result = setFlag(key, value, by);
    if (!result.ok) fail(result.errors, 3);
    console.log(`set ${key}=${value} → v${result.config.version} hash=${result.hash} (previous preserved for rollback)`);
    process.exit(0);
  }

  if (cmd === "activate-conveyor-parity-shadow") {
    const manifestIdx = argv.indexOf("--manifest");
    const manifestPath = manifestIdx >= 0 ? argv[manifestIdx + 1] : undefined;
    const byIdx = argv.indexOf("--by");
    const by = byIdx >= 0 ? argv[byIdx + 1] : undefined;
    if (!manifestPath || !by) {
      console.error("Usage: runtime-config.ts activate-conveyor-parity-shadow --manifest <path> --by <who>");
      process.exit(2);
    }
    const result = activateConveyorParityShadow(manifestPath, by);
    if (!result.ok) fail(result.errors, 3);
    console.log(`conveyor parity shadow ${result.changed ? "activated" : "already active"} → v${result.config.version} hash=${result.hash}`);
    process.exit(0);
  }

  if (cmd === "rollback-conveyor-parity-shadow") {
    const byIdx = argv.indexOf("--by");
    const by = byIdx >= 0 ? argv[byIdx + 1] : undefined;
    if (!by) {
      console.error("Usage: runtime-config.ts rollback-conveyor-parity-shadow --by <who>");
      process.exit(2);
    }
    const result = rollbackConveyorParityShadow(by);
    if (!result.ok) fail(result.errors, 1);
    console.log(`conveyor parity shadow ${result.changed ? "rolled back" : "already rolled back"} → v${result.config.version} hash=${result.hash}`);
    process.exit(0);
  }

  if (cmd === "conveyor-parity-status") {
    const status = conveyorParityAuthorityStatus();
    console.log(JSON.stringify(status));
    process.exit(status.valid ? 0 : 3);
  }

  if (cmd === "activate-receipt-shadow") {
    const configIdx = argv.indexOf("--config");
    const externalConfigPath = configIdx >= 0 ? argv[configIdx + 1] : undefined;
    const byIdx = argv.indexOf("--by");
    const by = byIdx >= 0 ? argv[byIdx + 1] : undefined;
    if (!externalConfigPath || !by) {
      console.error("Usage: runtime-config.ts activate-receipt-shadow --config <path> --by <who>");
      process.exit(2);
    }
    const result = activateReceiptShadowAuthority(externalConfigPath, by);
    if (!result.ok) fail(result.errors, 3);
    console.log(`receipt shadow authority ${result.changed ? "activated" : "already active"} → v${result.config.version} hash=${result.hash}`);
    process.exit(0);
  }

  if (cmd === "rollback-receipt-shadow") {
    const byIdx = argv.indexOf("--by");
    const by = byIdx >= 0 ? argv[byIdx + 1] : undefined;
    if (!by) {
      console.error("Usage: runtime-config.ts rollback-receipt-shadow --by <who>");
      process.exit(2);
    }
    const result = rollbackReceiptShadowAuthority(by);
    if (!result.ok) fail(result.errors, 1);
    console.log(`receipt shadow authority rolled back to exact preimage → v${result.config.version} hash=${result.hash}`);
    process.exit(0);
  }

  if (cmd === "rollback") {
    const byIdx = argv.indexOf("--by");
    const by = byIdx >= 0 ? argv[byIdx + 1] : undefined;
    if (!by) {
      console.error("Usage: runtime-config.ts rollback --by <who>");
      process.exit(2);
    }
    const result = rollbackConfig(by);
    if (!result.ok) fail(result.errors, 1);
    console.log(`rolled back → v${result.config.version} hash=${result.hash}`);
    process.exit(0);
  }

  if (cmd === "status") {
    const snap = runtimeConfigSnapshot();
    console.log(`Runtime config : ${snap.present ? (snap.valid ? "VALID" : "INVALID") : "MISSING"}`);
    if (snap.valid) {
      console.log(`  Version   : v${snap.version}`);
      console.log(`  Hash      : ${snap.hash}`);
      console.log(`  Divergence: ${snap.divergence_count} flag(s) differ from this shell's env`);
    }
    for (const e of snap.errors) console.log(`  Error: ${e}`);
    process.exit(snap.valid ? 0 : 3);
  }

  console.error("Commands: validate | export-env | check | record-tick [--source <s>] | set KEY VALUE --by <who> | activate-conveyor-parity-shadow --manifest <path> --by <who> | rollback-conveyor-parity-shadow --by <who> | conveyor-parity-status | activate-receipt-shadow --config <path> --by <who> | rollback-receipt-shadow --by <who> | rollback --by <who> | status");
  process.exit(2);
}

if (import.meta.main) main();
