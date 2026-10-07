import * as fs from "fs";
import * as path from "path";

export type ModelProvider = "zo-byok" | "synthetic" | "opencode" | "openrouter" | "xai" | "kimi" | "unknown";

export interface IdentityInput {
  id: string;
  label?: string;
  family?: string;
}

export interface ModelIdentity {
  requestedId: string;
  resolvedId: string;
  provider: ModelProvider;
  family: string;
  model: string;
  displayName: string;
}

export interface ByokRegistryEntryLike {
  id: string | null;
  label: string;
  family: string;
}

const DEFAULT_REGISTRY_PATH = path.resolve(__dirname, "../assets/byok-registry.json");

const FAMILY_ALIASES: Record<string, string> = {
  anthropic: "claude",
  claude: "claude",
  codex: "gpt",
  openai: "gpt",
  gpt: "gpt",
  "z-ai": "glm",
  zai: "glm",
  "zai-org": "glm",
  glm: "glm",
  moonshot: "kimi",
  moonshotai: "kimi",
  kimi: "kimi",
  "x-ai": "grok",
  xai: "grok",
  grok: "grok",
  minimaxai: "minimax",
  minimax: "minimax",
  nvidia: "nvidia",
  nemotron: "nvidia",
  google: "gemini",
  gemini: "gemini",
  "deepseek-ai": "deepseek",
  deepseek: "deepseek",
  alibaba: "qwen",
  qwen: "qwen",
};

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");
}

export function stableByokAlias(label: string): string {
  return `byok:${slug(label.replace(/^claude\s+code\s+/i, "claude ").replace(/^codex\s+/i, ""))}`;
}

export function loadByokRegistry(registryPath = DEFAULT_REGISTRY_PATH): ByokRegistryEntryLike[] {
  try {
    const raw = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as { models?: ByokRegistryEntryLike[] };
    return Array.isArray(raw.models) ? raw.models : [];
  } catch {
    return [];
  }
}

export function resolveByokAlias(
  id: string,
  registry: ByokRegistryEntryLike[] = loadByokRegistry(),
): string | null {
  if (!id.startsWith("byok:")) return id;
  const exact = registry.find((entry) => entry.id === id);
  if (exact?.id) return exact.id;
  const alias = registry.find((entry) => stableByokAlias(entry.label) === id);
  return alias?.id ?? null;
}

export function providerForModelId(id: string): ModelProvider {
  if (id.startsWith("byok:")) return "zo-byok";
  if (id.startsWith("hf:") || id.startsWith("syn:")) return "synthetic";
  if (id.startsWith("oc:")) return "opencode";
  if (id.startsWith("or:")) return "openrouter";
  if (id.startsWith("xai:")) return "xai";
  if (id.startsWith("kimi:")) return "kimi";
  if (/^[^/]+\/[a-z0-9]/i.test(id)) return "openrouter";
  return "unknown";
}

function stripRoute(id: string): string {
  return id.replace(/^(byok:|hf:|syn:|oc:|or:|xai:|kimi:)/, "");
}

function modelPart(id: string): string {
  const bare = stripRoute(id);
  return bare.includes("/") ? bare.slice(bare.indexOf("/") + 1) : bare;
}

export function canonicalModelFamily(input: IdentityInput | string): string {
  const record = typeof input === "string" ? { id: input } : input;
  const candidates = [record.family ?? "", stripRoute(record.id).split("/")[0], record.label ?? "", modelPart(record.id)];
  for (const candidate of candidates) {
    const tokens = slug(candidate).split("-").filter(Boolean);
    const joined = tokens.slice(0, 2).join("-");
    if (FAMILY_ALIASES[joined]) return FAMILY_ALIASES[joined];
    for (const token of tokens) {
      if (FAMILY_ALIASES[token]) return FAMILY_ALIASES[token];
    }
  }
  return slug(record.family || stripRoute(record.id).split("/")[0] || "unknown") || "unknown";
}

export function canonicalModelName(input: IdentityInput | string): string {
  const record = typeof input === "string" ? { id: input } : input;
  const source = record.label || modelPart(record.id);
  let normalized = slug(source)
    .replace(/^claude-code-/, "claude-")
    .replace(/^codex-/, "")
    .replace(/^anthropic-/, "")
    .replace(/^openai-/, "")
    .replace(/^z-ai-/, "")
    .replace(/^zai-org-/, "")
    .replace(/^moonshotai-/, "")
    .replace(/^minimaxai-/, "minimax-");
  const family = canonicalModelFamily(record);
  const expectedPrefix: Record<string, string> = {
    claude: "claude-",
    gpt: "gpt-",
    glm: "glm-",
    kimi: "kimi-",
    grok: "grok-",
    minimax: "minimax-",
    nvidia: "nemotron-",
    gemini: "gemini-",
    deepseek: "deepseek-",
    qwen: "qwen",
  };
  const prefix = expectedPrefix[family];
  if (prefix && !normalized.startsWith(prefix)) {
    normalized = `${prefix}${normalized}`;
  }
  return normalized || family;
}

export function displayModelName(input: IdentityInput | string): string {
  const record = typeof input === "string" ? { id: input } : input;
  if (record.label) return record.label;
  const base = modelPart(record.id);
  return base.replace(/^([a-z]+)/i, (_match, prefix: string) => {
    const family = prefix.toLowerCase();
    if (["glm", "qwen", "llama", "gpt"].includes(family)) return family.toUpperCase();
    return family.charAt(0).toUpperCase() + family.slice(1);
  });
}

export function resolveModelIdentity(
  input: IdentityInput | string,
  registry: ByokRegistryEntryLike[] = loadByokRegistry(),
): ModelIdentity {
  const record = typeof input === "string" ? { id: input } : input;
  const resolvedId = record.id.startsWith("byok:") ? resolveByokAlias(record.id, registry) ?? record.id : record.id;
  const registryEntry = registry.find((entry) => entry.id === resolvedId || stableByokAlias(entry.label) === record.id);
  const enriched = {
    id: resolvedId,
    label: record.label || registryEntry?.label,
    family: record.family || registryEntry?.family,
  };
  return {
    requestedId: record.id,
    resolvedId,
    provider: providerForModelId(resolvedId),
    family: canonicalModelFamily(enriched),
    model: canonicalModelName(enriched),
    displayName: displayModelName(enriched),
  };
}

export function sameCanonicalModel(a: IdentityInput | string, b: IdentityInput | string): boolean {
  const left = resolveModelIdentity(a);
  const right = resolveModelIdentity(b);
  return left.family === right.family && left.model === right.model;
}
