#!/usr/bin/env bun
/**
 * SF-003 T3 — Fail-closed live Zo persona directory adapter.
 *
 * Injected, timeout-bounded adapter for the Zo MCP `list_personas` tool.
 *
 * - Pure parser: no side effects, no persistence of prompts/secrets.
 * - Normalizes only id, exact name, model metadata, scopes, and updated_at.
 * - Hashes canonical normalized snapshots.
 * - Resolves exact persona-name selectors deterministically.
 * - Returns typed missing, duplicate, renamed, unavailable, and under-scoped failures.
 *
 * Modes:
 *   off     — no directory call, empty result.
 *   shadow  — resolves and stamps would-invoke evidence; never fails closed.
 *   enforce — required failures fail closed before task dispatch.
 */

import { createHash } from "node:crypto";

// ── Types ───────────────────────────────────────────────────────────────────

export interface ZoPersonaDirectoryEntry {
  id: string;
  name: string;
  model: string | null;
  scopes: string[];
  updated_at: string | null;
}

export interface PersonaAssociationRole {
  role_id: string;
  selector: string; // exact persona name expected in the live directory
  required: boolean;
  required_scopes?: string[];
}

export type PersonaResolutionMode = "off" | "shadow" | "enforce";

export type PersonaFailureKind =
  | "missing"
  | "duplicate"
  | "renamed"
  | "unavailable"
  | "under_scoped";

export interface PersonaResolutionFailure {
  kind: PersonaFailureKind;
  role_id: string;
  selector: string;
  required: boolean;
  message: string;
  candidates?: string[];
  actual_name?: string;
  actual_scopes?: string[];
  required_scopes?: string[];
  missing_scopes?: string[];
}

export interface ResolvedPersona {
  role_id: string;
  selector: string;
  persona_id: string;
  name: string;
  model: string | null;
  scopes: string[];
  updated_at: string | null;
}

export interface PersonaOmission {
  role_id: string;
  selector: string;
  reason: string;
}

export interface NormalizedSnapshot {
  personas: ZoPersonaDirectoryEntry[];
  snapshot_hash: string;
  captured_at: string;
}

export interface PersonaResolutionResult {
  ok: boolean;
  mode: PersonaResolutionMode;
  snapshot: NormalizedSnapshot | null;
  resolved: ResolvedPersona[];
  omitted: PersonaOmission[];
  failures: PersonaResolutionFailure[];
  would_invoke?: boolean;
}

export interface ResolvePersonasOptions {
  mode: PersonaResolutionMode;
  roles: PersonaAssociationRole[];
  listPersonas: () => Promise<unknown>;
  timeoutMs: number;
  now?: string;
}

// ── Pure parser ─────────────────────────────────────────────────────────────

class PersonaDirectoryError extends Error {
  constructor(
    readonly kind: PersonaFailureKind,
    message: string,
  ) {
    super(message);
    this.name = "PersonaDirectoryError";
  }
}

const PYTHON_STRING_RE = /'((?:[^'\\]|\\.)*)'/;
const DATETIME_RE =
  /datetime\.datetime\(\s*(\d{4})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*,\s*(\d{1,2})\s*(?:,\s*(\d+)\s*)?(?:,\s*tzinfo=[^)]+)?\)/;

function unescapePythonString(raw: string): string {
  return raw
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
    .replace(/\\r/g, "\r");
}

function parseDatetimeToIso(value: string): string | null {
  const m = DATETIME_RE.exec(value);
  if (!m) return null;
  const [_, year, month, day, hour, minute, second, micros] = m;
  const pad2 = (n: string) => n.padStart(2, "0");
  const base = `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}`;
  if (micros) {
    const padded = micros.padStart(6, "0").slice(0, 6);
    return `${base}.${padded}Z`;
  }
  return `${base}Z`;
}

function extractKey(
  repr: string,
  key: string,
): { value: string; end: number } | null {
  const re = new RegExp(`\\b${key}=`, "g");
  const match = re.exec(repr);
  if (!match) return null;
  const start = match.index + match[0].length;
  let end = start;

  if (repr.startsWith("None", end)) {
    return { value: "None", end: end + 4 };
  }

  if (repr.startsWith("datetime.", end)) {
    const dm = DATETIME_RE.exec(repr.slice(end));
    if (!dm) return null;
    return { value: repr.slice(end, end + dm[0].length), end: end + dm[0].length };
  }

  if (repr.startsWith("[", end)) {
    let depth = 1;
    end = end + 1;
    while (end < repr.length && depth > 0) {
      const ch = repr[end];
      if (ch === "'") {
        // skip string literal
        end++;
        while (end < repr.length) {
          const c = repr[end];
          if (c === "\\") {
            end += 2;
          } else if (c === "'") {
            end++;
            break;
          } else {
            end++;
          }
        }
      } else {
        if (ch === "[") depth++;
        if (ch === "]") depth--;
        end++;
      }
    }
    return { value: repr.slice(start, end), end };
  }

  if (repr.startsWith("'", end)) {
    const sm = PYTHON_STRING_RE.exec(repr.slice(end));
    if (!sm) return null;
    return { value: repr.slice(end, end + sm[0].length), end: end + sm[0].length };
  }

  return null;
}

function stripPrompt(repr: string): string {
  // Remove the entire prompt='...' field so that content inside the prompt
  // cannot be mistaken for top-level keys (name=, id=, etc.).
  const promptMatch = extractKey(repr, "prompt");
  if (!promptMatch) return repr;
  const before = repr.slice(0, promptMatch.end - promptMatch.value.length - "prompt=".length);
  const after = repr.slice(promptMatch.end);
  return `${before}${after}`.replace(/\s+/g, " ").trim();
}

function parseScopes(value: string): string[] {
  const scopes: string[] = [];
  const re = /'((?:[^'\\]|\\.)*)'/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    scopes.push(unescapePythonString(m[1]));
  }
  return scopes;
}

export function parsePythonReprPersona(repr: string): ZoPersonaDirectoryEntry | null {
  const cleaned = stripPrompt(repr);

  const idMatch = extractKey(cleaned, "id");
  const nameMatch = extractKey(cleaned, "name");
  const modelMatch = extractKey(cleaned, "model");
  const scopesMatch = extractKey(cleaned, "scopes");
  const updatedAtMatch = extractKey(cleaned, "updated_at");

  if (!idMatch || !nameMatch) return null;

  const id = PYTHON_STRING_RE.exec(idMatch.value)?.[1];
  const name = PYTHON_STRING_RE.exec(nameMatch.value)?.[1];
  if (!id || !name) return null;

  const model = modelMatch
    ? modelMatch.value === "None"
      ? null
      : (PYTHON_STRING_RE.exec(modelMatch.value)?.[1] ?? null)
    : null;

  const scopes = scopesMatch ? parseScopes(scopesMatch.value) : [];

  let updated_at: string | null = null;
  if (updatedAtMatch) {
    if (updatedAtMatch.value === "None") {
      updated_at = null;
    } else {
      updated_at = parseDatetimeToIso(updatedAtMatch.value);
    }
  }

  return {
    id: unescapePythonString(id),
    name: unescapePythonString(name),
    model,
    scopes,
    updated_at,
  };
}

export function extractPersonaText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    try {
      return JSON.stringify(raw);
    } catch {
      return null;
    }
  }
  if (raw && typeof raw === "object") {
    const anyRaw = raw as Record<string, unknown>;
    const result = anyRaw.result ?? anyRaw;
    if (result && typeof result === "object") {
      const content = (result as Record<string, unknown>).content;
      if (Array.isArray(content) && content.length > 0) {
        const first = content[0];
        if (first && typeof first === "object") {
          const text = (first as Record<string, unknown>).text;
          if (typeof text === "string") return text;
        }
      }
    }
  }
  return null;
}

export function parseListPersonasResponse(raw: unknown): ZoPersonaDirectoryEntry[] {
  // Native VPS directories are structured records, never Zo repr strings.
  // Keep this explicit tag so malformed native data cannot silently fall back
  // to the legacy parser and appear as an empty but healthy directory.
  if (raw && typeof raw === "object" && !Array.isArray(raw)
      && (raw as Record<string, unknown>).schema === "native-persona-directory/v1") {
    const record = raw as Record<string, unknown>;
    if (Object.keys(record).sort().join(",") !== "personas,schema"
        || !Array.isArray(record.personas) || record.personas.length > 128) {
      throw new Error("invalid native persona directory envelope");
    }
    const ids = new Set<string>();
    const entries = record.personas.map((candidate) => {
      if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
        throw new Error("invalid native persona entry");
      }
      const entry = candidate as Record<string, unknown>;
      if (Object.keys(entry).sort().join(",") !== "id,model,name,scopes,updated_at"
          || typeof entry.id !== "string" || !/^native:[a-z0-9][a-z0-9:-]{2,127}$/.test(entry.id)
          || typeof entry.name !== "string" || entry.name.trim() !== entry.name
          || entry.name.length < 2 || entry.name.length > 128
          || !(entry.model === null || typeof entry.model === "string" && entry.model.length > 0)
          || !Array.isArray(entry.scopes) || entry.scopes.length < 1 || entry.scopes.length > 32
          || entry.scopes.some((scope) => typeof scope !== "string" || !/^[a-z][a-z0-9:*-]{0,63}$/.test(scope))
          || new Set(entry.scopes).size !== entry.scopes.length
          || !(entry.updated_at === null || typeof entry.updated_at === "string"
            && !Number.isNaN(Date.parse(entry.updated_at)))) {
        throw new Error("invalid native persona entry");
      }
      if (ids.has(entry.id)) throw new Error("duplicate native persona identity");
      ids.add(entry.id);
      return entry as unknown as ZoPersonaDirectoryEntry;
    });
    entries.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    return entries;
  }
  const text = extractPersonaText(raw);
  if (!text) return [];

  let arr: unknown[];
  if (text.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      arr = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      arr = [text];
    }
  } else {
    arr = [text];
  }

  const entries: ZoPersonaDirectoryEntry[] = [];
  for (const item of arr) {
    if (typeof item !== "string") continue;
    const entry = parsePythonReprPersona(item);
    if (entry) entries.push(entry);
  }

  // Deterministic order: by name, then id.
  entries.sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.id.localeCompare(b.id);
  });

  return entries;
}

// ── Snapshot hashing ────────────────────────────────────────────────────────

function canonicalPersona(entry: ZoPersonaDirectoryEntry): unknown {
  return {
    id: entry.id,
    name: entry.name,
    model: entry.model,
    scopes: [...entry.scopes].sort(),
    updated_at: entry.updated_at,
  };
}

export function hashSnapshot(personas: ZoPersonaDirectoryEntry[]): string {
  const sorted = [...personas].sort((a, b) => {
    if (a.name !== b.name) return a.name.localeCompare(b.name);
    return a.id.localeCompare(b.id);
  });
  const canonical = JSON.stringify(sorted.map(canonicalPersona));
  return createHash("sha256").update(canonical).digest("hex");
}

export function normalizeSnapshot(
  entries: ZoPersonaDirectoryEntry[],
  captured_at = new Date().toISOString(),
): NormalizedSnapshot {
  return {
    personas: entries,
    snapshot_hash: hashSnapshot(entries),
    captured_at,
  };
}

// ── Resolver ────────────────────────────────────────────────────────────────

function hasAllScopes(personaScopes: string[], required: string[]): boolean {
  if (personaScopes.includes("all")) return true;
  const set = new Set(personaScopes);
  return required.every((s) => set.has(s));
}

function findByExactName(
  entries: ZoPersonaDirectoryEntry[],
  selector: string,
): ZoPersonaDirectoryEntry[] {
  return entries.filter((e) => e.name === selector);
}

function findByNormalizedName(
  entries: ZoPersonaDirectoryEntry[],
  selector: string,
): ZoPersonaDirectoryEntry[] {
  const normalized = selector.toLowerCase().replace(/\s+/g, " ").trim();
  return entries.filter(
    (e) => e.name.toLowerCase().replace(/\s+/g, " ").trim() === normalized,
  );
}

export function resolveAgainstSnapshot(options: {
  mode: PersonaResolutionMode;
  roles: PersonaAssociationRole[];
  snapshot: NormalizedSnapshot;
}): PersonaResolutionResult {
  const { mode, roles, snapshot } = options;
  const resolved: ResolvedPersona[] = [];
  const omitted: PersonaOmission[] = [];
  const failures: PersonaResolutionFailure[] = [];

  for (const role of roles) {
    const exactMatches = findByExactName(snapshot.personas, role.selector);

    if (exactMatches.length === 1) {
      const entry = exactMatches[0];
      const requiredScopes = role.required_scopes ?? [];
      if (requiredScopes.length > 0 && !hasAllScopes(entry.scopes, requiredScopes)) {
        const missing = requiredScopes.filter((s) => !entry.scopes.includes(s) && !entry.scopes.includes("all"));
        const message = `Persona "${role.selector}" is missing required scopes: ${missing.join(", ")}`;
        if (mode === "enforce" && role.required) {
          failures.push({
            kind: "under_scoped",
            role_id: role.role_id,
            selector: role.selector,
            required: true,
            message,
            actual_scopes: [...entry.scopes],
            required_scopes: [...requiredScopes],
            missing_scopes: missing,
          });
        } else {
          omitted.push({
            role_id: role.role_id,
            selector: role.selector,
            reason: message,
          });
        }
        continue;
      }

      resolved.push({
        role_id: role.role_id,
        selector: role.selector,
        persona_id: entry.id,
        name: entry.name,
        model: entry.model,
        scopes: [...entry.scopes],
        updated_at: entry.updated_at,
      });
      continue;
    }

    if (exactMatches.length > 1) {
      const message = `Multiple personas match exact name "${role.selector}"`;
      if (mode === "enforce" && role.required) {
        failures.push({
          kind: "duplicate",
          role_id: role.role_id,
          selector: role.selector,
          required: true,
          message,
          candidates: exactMatches.map((e) => e.id),
        });
      } else {
        omitted.push({
          role_id: role.role_id,
          selector: role.selector,
          reason: message,
        });
      }
      continue;
    }

    // No exact match — check for renamed candidates.
    const renamedMatches = findByNormalizedName(snapshot.personas, role.selector);
    if (renamedMatches.length > 0) {
      const message = `Persona "${role.selector}" not found by exact name; possible rename`;
      if (mode === "enforce" && role.required) {
        failures.push({
          kind: "renamed",
          role_id: role.role_id,
          selector: role.selector,
          required: true,
          message,
          candidates: renamedMatches.map((e) => e.name),
        });
      } else {
        omitted.push({
          role_id: role.role_id,
          selector: role.selector,
          reason: message,
        });
      }
      continue;
    }

    // Missing.
    const message = `Persona "${role.selector}" not found in directory`;
    if (mode === "enforce" && role.required) {
      failures.push({
        kind: "missing",
        role_id: role.role_id,
        selector: role.selector,
        required: true,
        message,
      });
    } else {
      omitted.push({
        role_id: role.role_id,
        selector: role.selector,
        reason: message,
      });
    }
  }

  const ok = mode !== "enforce" || failures.length === 0;

  return {
    ok,
    mode,
    snapshot,
    resolved,
    omitted,
    failures,
    ...(mode === "shadow" ? { would_invoke: true } : {}),
  };
}

// ── Timeout-bounded live adapter ────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((_, reject) =>
    setTimeout(
      () => reject(new PersonaDirectoryError("unavailable", `list_personas timed out after ${ms}ms`)),
      ms,
    ),
  );
}

export async function resolvePersonas(
  options: ResolvePersonasOptions,
): Promise<PersonaResolutionResult> {
  const { mode, roles, listPersonas, timeoutMs, now = new Date().toISOString() } = options;

  if (mode === "off") {
    return {
      ok: true,
      mode,
      snapshot: null,
      resolved: [],
      omitted: [],
      failures: [],
    };
  }

  let entries: ZoPersonaDirectoryEntry[];
  try {
    const raw = await Promise.race([listPersonas(), sleep(timeoutMs)]);
    entries = parseListPersonasResponse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hasRequired = roles.some((r) => r.required);
    const failure: PersonaResolutionFailure = {
      kind: "unavailable",
      role_id: "directory",
      selector: "",
      required: hasRequired,
      message: `Persona directory unavailable: ${message}`,
    };

    if (mode === "enforce") {
      return {
        ok: false,
        mode,
        snapshot: null,
        resolved: [],
        omitted: [],
        failures: hasRequired ? [failure] : [],
      };
    }

    return {
      ok: true,
      mode,
      snapshot: null,
      resolved: [],
      omitted: [],
      failures: [],
      would_invoke: true,
    };
  }

  const snapshot = normalizeSnapshot(entries, now);
  const result = resolveAgainstSnapshot({ mode, roles, snapshot });
  return result;
}

// Live MCP caller for production wiring (T4/T5). Not invoked by tests.
export interface ZoMcpCallerOptions {
  endpoint?: string;
  apiKey?: string;
  authorization?: string;
  fetch_impl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
}

export function resolveZoMcpAuthorization(
  options: Pick<ZoMcpCallerOptions, "apiKey" | "authorization"> = {},
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (options.authorization !== undefined) return options.authorization;
  if (options.apiKey !== undefined) return `Bearer ${options.apiKey}`;
  if (env.ZO_CLIENT_IDENTITY_TOKEN) return env.ZO_CLIENT_IDENTITY_TOKEN;
  if (env.ZO_API_KEY) return `Bearer ${env.ZO_API_KEY}`;
  return undefined;
}

export function createZoMcpListPersonasCaller(
  options: ZoMcpCallerOptions = {},
): () => Promise<unknown> {
  const endpoint = options.endpoint ?? process.env.ZO_MCP_ENDPOINT ?? "https://api.zo.computer/mcp";
  const authorization = resolveZoMcpAuthorization(options);
  const fetchImpl = options.fetch_impl ?? fetch;

  return async () => {
    if (!authorization?.trim()) {
      throw new PersonaDirectoryError("unavailable",
        "Zo specialist routing requires ZO_CLIENT_IDENTITY_TOKEN or ZO_API_KEY. Local persona files are not Zo directory identities; use shadow/off or an explicitly supplied directory and invocation adapter.");
    }
    const resp = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        ...(authorization ? { authorization } : {}),
        connection: "close",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        id: Date.now(),
        params: { name: "list_personas", arguments: {} },
      }),
    });
    if (!resp.ok) {
      throw new PersonaDirectoryError("unavailable", `HTTP ${resp.status}`);
    }
    const payload = await resp.json() as Record<string, unknown>;
    if (payload.error && typeof payload.error === "object") {
      const error = payload.error as Record<string, unknown>;
      const code = typeof error.code === "number" || typeof error.code === "string" ? String(error.code) : "unknown";
      const message = typeof error.message === "string" ? error.message : "unknown MCP error";
      throw new PersonaDirectoryError("unavailable", `MCP ${code}: ${message}`);
    }
    return payload;
  };
}
