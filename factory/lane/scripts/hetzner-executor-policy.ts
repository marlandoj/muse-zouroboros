import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type HetznerProfileName = "small" | "medium" | "large";

export interface HetznerProfile {
  server_type: string;
  vcpus: number;
  memory_gib: number;
  cpu: "shared" | "dedicated";
  ttl_minutes: number;
  max_cost_usd: number;
}

export interface HetznerExecutorConfig {
  version: 1;
  enabled: boolean;
  provider: "hetzner";
  location: string;
  image: string;
  default_profile: HetznerProfileName;
  max_profile: HetznerProfileName;
  max_in_flight: 1;
  profiles: Record<HetznerProfileName, HetznerProfile>;
  kill_switch: string;
}

export interface HetznerExecutionRoute {
  requested: boolean;
  binding: boolean;
  supported: boolean;
  reason: string;
  matched_text: string | null;
  profile_name: HetznerProfileName | null;
  profile: HetznerProfile | null;
  location: string | null;
  image: string | null;
}

const FACTORY_ROOT = join(import.meta.dir, "..");
const DEFAULT_CONFIG_PATH = join(FACTORY_ROOT, "config", "hetzner-executor.json");
const PROFILE_ORDER: HetznerProfileName[] = ["small", "medium", "large"];

const NEGATED_HETZNER = [
  /\bdo\s+not\s+(?:use|run|execute|dispatch|build|provision)[^\n.]{0,48}\bhetzner\b/i,
  /\bwithout\s+(?:using\s+)?hetzner\b/i,
  /\bhetzner\b[^\n.]{0,32}\b(?:not\s+required|must\s+not|should\s+not|isn['’]?t\s+to\s+be\s+used)\b/i,
  /\bno\s+hetzner\b/i,
];

const BINDING_HETZNER = [
  /\bexecution[_ -]?target\s*[:=]\s*`?hetzner(?:-ephemeral)?`?/i,
  /\b(?:use|run|execute|dispatch|build|provision)\s+(?:this\s+|the\s+)?hetzner\b/i,
  /\b(?:use|run|execute|dispatch|build|provision)\b[^\n.]{0,64}\b(?:on|with|using)\s+hetzner\b/i,
  /\bhetzner\b[^\n.]{0,48}\b(?:worker|executor|compute|execution)\b[^\n.]{0,32}\b(?:required|mandatory|must|only)\b/i,
  /\bhetzner\s+(?:is\s+to\s+be|is|must\s+be|should\s+be|shall\s+be)\s+(?:used|required)\b/i,
  /\b(?:must|required|mandatory)\b[^\n.]{0,48}\bhetzner\b/i,
  /\b(?:hetzner\s+)?(?:worker|executor|compute)\s*[:=]\s*`?hetzner`?/i,
];

const GPU_TERMS = /\b(?:gpu|cuda|vram|nvidia|rtx|a100|h100|l40s?)\b/i;
const LARGE_TERMS = /\b(?:webgpu|playwright|browser\s+matrix|chromium|graphics|3d|babylon(?:\.js)?|three(?:\.js)?|monorepo|end-to-end|e2e|large\s+build|parallel\s+test|video\s+render)\b/i;
const SMALL_TERMS = /\b(?:documentation-only|docs-only|lint-only|format-only|small\s+patch|single-file)\b/i;

function isProfileName(value: unknown): value is HetznerProfileName {
  return typeof value === "string" && PROFILE_ORDER.includes(value as HetznerProfileName);
}

function requirePositiveNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive number`);
  }
  return value;
}

export function validateHetznerExecutorConfig(input: unknown): HetznerExecutorConfig {
  if (!input || typeof input !== "object") throw new Error("Hetzner executor config must be an object");
  const value = input as Partial<HetznerExecutorConfig>;
  if (value.version !== 1) throw new Error("Hetzner executor config version must be 1");
  if (value.provider !== "hetzner") throw new Error("Hetzner executor provider must be hetzner");
  if (typeof value.enabled !== "boolean") throw new Error("Hetzner executor enabled must be boolean");
  if (!isProfileName(value.default_profile) || !isProfileName(value.max_profile)) {
    throw new Error("Hetzner executor profile names must be small, medium, or large");
  }
  if (value.max_in_flight !== 1) throw new Error("Hetzner executor max_in_flight must be exactly 1");
  if (!value.profiles || typeof value.profiles !== "object") throw new Error("Hetzner executor profiles are required");
  if (PROFILE_ORDER.indexOf(value.default_profile) > PROFILE_ORDER.indexOf(value.max_profile)) {
    throw new Error("Hetzner executor default_profile cannot exceed max_profile");
  }

  const profiles = {} as Record<HetznerProfileName, HetznerProfile>;
  const seenServerTypes = new Set<string>();
  for (const name of PROFILE_ORDER) {
    const profile = value.profiles[name];
    if (!profile || typeof profile !== "object") throw new Error(`Hetzner profile ${name} is required`);
    const serverType = String(profile.server_type ?? "").trim();
    if (!/^[a-z0-9-]+$/.test(serverType)) throw new Error(`Hetzner profile ${name} has invalid server_type`);
    if (seenServerTypes.has(serverType)) throw new Error(`Hetzner server_type ${serverType} is duplicated`);
    seenServerTypes.add(serverType);
    if (profile.cpu !== "shared" && profile.cpu !== "dedicated") throw new Error(`Hetzner profile ${name} has invalid cpu`);
    const ttl = requirePositiveNumber(profile.ttl_minutes, `${name}.ttl_minutes`);
    if (!Number.isInteger(ttl) || ttl > 120) throw new Error(`${name}.ttl_minutes must be an integer no greater than 120`);
    profiles[name] = {
      server_type: serverType,
      vcpus: requirePositiveNumber(profile.vcpus, `${name}.vcpus`),
      memory_gib: requirePositiveNumber(profile.memory_gib, `${name}.memory_gib`),
      cpu: profile.cpu,
      ttl_minutes: ttl,
      max_cost_usd: requirePositiveNumber(profile.max_cost_usd, `${name}.max_cost_usd`),
    };
  }

  const location = String(value.location ?? "").trim();
  const image = String(value.image ?? "").trim();
  if (!/^[a-z0-9-]+$/.test(location)) throw new Error("Hetzner executor location is invalid");
  if (!/^[A-Za-z0-9._-]+$/.test(image)) throw new Error("Hetzner executor image is invalid");
  return {
    version: 1,
    enabled: value.enabled,
    provider: "hetzner",
    location,
    image,
    default_profile: value.default_profile,
    max_profile: value.max_profile,
    max_in_flight: 1,
    profiles,
    kill_switch: String(value.kill_switch ?? "SF_HETZNER_EXECUTOR=0"),
  };
}

export function loadHetznerExecutorConfig(
  env: Record<string, string | undefined> = process.env,
): HetznerExecutorConfig {
  const path = env.SF_HETZNER_EXECUTOR_CONFIG || DEFAULT_CONFIG_PATH;
  if (!existsSync(path)) throw new Error(`Hetzner executor config not found: ${path}`);
  return validateHetznerExecutorConfig(JSON.parse(readFileSync(path, "utf8")));
}

export function hetznerExecutorEnabled(
  env: Record<string, string | undefined> = process.env,
  config = loadHetznerExecutorConfig(env),
): boolean {
  if (env.SF_HETZNER_EXECUTOR !== undefined) return env.SF_HETZNER_EXECUTOR === "1";
  return config.enabled;
}

function explicitProfile(text: string, config: HetznerExecutorConfig): HetznerProfileName | null {
  const profileMatch = text.match(/\bhetzner(?:[_ -]?(?:size|profile))?\s*[:=]\s*`?(small|medium|large|[a-z0-9-]+)`?/i);
  if (!profileMatch) return null;
  const requested = profileMatch[1].toLowerCase();
  if (isProfileName(requested)) return requested;
  const entry = PROFILE_ORDER.find((name) => config.profiles[name].server_type === requested);
  if (!entry) throw new Error(`Hetzner server type ${requested} is not in the approved profile allowlist`);
  return entry;
}

function boundedProfile(name: HetznerProfileName, config: HetznerExecutorConfig): HetznerProfileName {
  if (PROFILE_ORDER.indexOf(name) > PROFILE_ORDER.indexOf(config.max_profile)) {
    throw new Error(`Hetzner profile ${name} exceeds configured maximum ${config.max_profile}`);
  }
  return name;
}

export function resolveHetznerExecutionRoute(
  input: { title?: string; description?: string },
  env: Record<string, string | undefined> = process.env,
  config = loadHetznerExecutorConfig(env),
): HetznerExecutionRoute {
  const text = `${input.title ?? ""}\n${input.description ?? ""}`;
  const negated = NEGATED_HETZNER.find((pattern) => pattern.test(text));
  if (negated) {
    return {
      requested: false,
      binding: false,
      supported: true,
      reason: "explicit Hetzner negation takes precedence",
      matched_text: text.match(negated)?.[0] ?? null,
      profile_name: null,
      profile: null,
      location: null,
      image: null,
    };
  }
  const binding = BINDING_HETZNER.find((pattern) => pattern.test(text));
  if (!binding) {
    return {
      requested: false,
      binding: false,
      supported: true,
      reason: "no binding Hetzner execution instruction",
      matched_text: null,
      profile_name: null,
      profile: null,
      location: null,
      image: null,
    };
  }
  const matchedText = text.match(binding)?.[0] ?? "Hetzner execution requested";
  if (GPU_TERMS.test(text)) {
    return {
      requested: true,
      binding: true,
      supported: false,
      reason: "GPU execution requested, but the approved Hetzner Cloud profiles are CPU-only",
      matched_text: matchedText,
      profile_name: null,
      profile: null,
      location: config.location,
      image: config.image,
    };
  }

  let selected: HetznerProfileName;
  try {
    selected = explicitProfile(text, config)
      ?? (LARGE_TERMS.test(text) ? "large" : SMALL_TERMS.test(text) ? "small" : config.default_profile);
    selected = boundedProfile(selected, config);
  } catch (error) {
    return {
      requested: true,
      binding: true,
      supported: false,
      reason: error instanceof Error ? error.message : String(error),
      matched_text: matchedText,
      profile_name: null,
      profile: null,
      location: config.location,
      image: config.image,
    };
  }

  const enabled = hetznerExecutorEnabled(env, config);
  return {
    requested: true,
    binding: true,
    supported: enabled,
    reason: enabled
      ? `binding Hetzner instruction selected ${selected} (${config.profiles[selected].server_type})`
      : "Hetzner execution was requested but the executor kill switch is active",
    matched_text: matchedText,
    profile_name: selected,
    profile: config.profiles[selected],
    location: config.location,
    image: config.image,
  };
}
