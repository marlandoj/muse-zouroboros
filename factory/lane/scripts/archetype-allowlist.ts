#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * SF-010 T1 — Archetype Allowlist Manager
 *
 * Maintains the set of low-risk archetypes eligible for auto-merge. The
 * allowlist is a JSON file (state/archetype-allowlist.json) so operators can
 * audit it in git. The built-in defaults are conservative; every addition
 * requires an explicit operator action.
 *
 * Invariants:
 *  - Built-in defaults are always considered allowed even if the file is absent.
 *  - Custom additions persist across restarts in state/archetype-allowlist.json.
 *  - Unknown archetypes are rejected by default (fail-closed).
 *  - The allowlist file is append-tracked: entries carry the operator who added
 *    them and a timestamp, so the audit trail is reconstructible.
 *
 * CLI (requires SF010_AUTOMERGE=1):
 *   bun archetype-allowlist.ts list
 *   bun archetype-allowlist.ts check <archetype>
 *   bun archetype-allowlist.ts add <archetype> --by <operator>
 *   bun archetype-allowlist.ts remove <archetype> --by <operator>
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

// ─── Types ────────────────────────────────────────────────────────────────────

export const BUILTIN_ARCHETYPES = [
  "dependency_bump",
  "lint_codemod",
  "doc_fix",
  "test_addition",
] as const;

export type BuiltinArchetype = (typeof BUILTIN_ARCHETYPES)[number];

export interface AllowlistEntry {
  archetype: string;
  added_by: string;
  added_at: string;
  builtin: boolean;
}

export interface AllowlistFile {
  version: 1;
  entries: AllowlistEntry[];
}

export interface AllowlistDecision {
  allowed: boolean;
  archetype: string;
  reason: string;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

const PROJECT_DIR = join(import.meta.dir, "..");

export function allowlistPath(base = PROJECT_DIR): string {
  return factoryStatePathForProject(base, "archetype-allowlist.json");
}

// ─── Read / write ─────────────────────────────────────────────────────────────

export function readAllowlistFile(path: string): AllowlistFile | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as AllowlistFile;
    if (raw.version !== 1 || !Array.isArray(raw.entries)) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeAllowlistFile(path: string, file: AllowlistFile): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`);
}

// ─── Core logic (injectable for tests) ───────────────────────────────────────

/** Returns all currently allowed archetypes (builtins + custom). */
export function getAllowedArchetypes(listPath = allowlistPath()): string[] {
  const file = readAllowlistFile(listPath);
  const builtins = BUILTIN_ARCHETYPES as readonly string[];
  if (!file) return [...builtins];
  const custom = file.entries.filter((e) => !e.builtin).map((e) => e.archetype);
  return [...new Set([...builtins, ...custom])];
}

/** Pure check — no I/O side-effects. */
export function checkArchetypeAllowlist(
  archetype: string,
  allowedList: string[],
): AllowlistDecision {
  const norm = archetype.trim().toLowerCase();
  const allowed = allowedList.map((a) => a.toLowerCase());
  if (allowed.includes(norm)) {
    const isBuiltin = (BUILTIN_ARCHETYPES as readonly string[]).includes(norm);
    return {
      allowed: true,
      archetype: norm,
      reason: isBuiltin ? `builtin low-risk archetype` : `operator-approved archetype`,
    };
  }
  return {
    allowed: false,
    archetype: norm,
    reason: `archetype '${norm}' not on allowlist — auto-merge restricted; operator must add it explicitly`,
  };
}

/** Add an archetype to the persistent allowlist. Idempotent. */
export function addArchetype(
  archetype: string,
  operator: string,
  listPath = allowlistPath(),
): { added: boolean; reason: string } {
  const norm = archetype.trim().toLowerCase();
  if (!norm || !/^[a-z0-9_-]+$/.test(norm)) {
    return { added: false, reason: `invalid archetype name '${norm}' — only lowercase letters, digits, underscores, hyphens` };
  }
  const file = readAllowlistFile(listPath) ?? { version: 1 as const, entries: [] };
  const existing = file.entries.find((e) => e.archetype === norm);
  if (existing) {
    return { added: false, reason: `'${norm}' already on allowlist (added by ${existing.added_by} at ${existing.added_at})` };
  }
  if ((BUILTIN_ARCHETYPES as readonly string[]).includes(norm)) {
    return { added: false, reason: `'${norm}' is a builtin archetype — always allowed, no explicit entry needed` };
  }
  file.entries.push({ archetype: norm, added_by: operator, added_at: new Date().toISOString(), builtin: false });
  writeAllowlistFile(listPath, file);
  return { added: true, reason: `'${norm}' added by ${operator}` };
}

/** Remove an archetype from the persistent allowlist. Builtins cannot be removed. */
export function removeArchetype(
  archetype: string,
  operator: string,
  listPath = allowlistPath(),
): { removed: boolean; reason: string } {
  const norm = archetype.trim().toLowerCase();
  if ((BUILTIN_ARCHETYPES as readonly string[]).includes(norm)) {
    return { removed: false, reason: `'${norm}' is a builtin — cannot be removed; builtins are always eligible` };
  }
  const file = readAllowlistFile(listPath);
  if (!file) return { removed: false, reason: `no custom allowlist file; '${norm}' was not a custom entry` };
  const before = file.entries.length;
  file.entries = file.entries.filter((e) => e.archetype !== norm);
  if (file.entries.length === before) {
    return { removed: false, reason: `'${norm}' was not in the custom allowlist` };
  }
  writeAllowlistFile(listPath, file);
  return { removed: true, reason: `'${norm}' removed by ${operator}` };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, arg] = process.argv.slice(2);
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { by: { type: "string" }, json: { type: "boolean" } },
    strict: false,
  });

  if (cmd === "list") {
    const allowed = getAllowedArchetypes();
    if (values.json) {
      console.log(JSON.stringify({ allowed }, null, 2));
    } else {
      console.log("Allowed archetypes:");
      for (const a of allowed) {
        const builtin = (BUILTIN_ARCHETYPES as readonly string[]).includes(a);
        console.log(`  ${a}${builtin ? " (builtin)" : " (custom)"}`);
      }
    }
  } else if (cmd === "check") {
    if (!arg) { console.error("Usage: check <archetype>"); process.exit(1); }
    const result = checkArchetypeAllowlist(arg, getAllowedArchetypes());
    if (values.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(`${result.allowed ? "✓ allowed" : "✗ blocked"}: ${result.reason}`);
    }
    process.exit(result.allowed ? 0 : 1);
  } else if (cmd === "add") {
    if (!arg) { console.error("Usage: add <archetype> --by <operator>"); process.exit(1); }
    const op = String(values.by ?? "operator");
    const result = addArchetype(arg, op);
    console.log(result.added ? `Added: ${result.reason}` : `Skipped: ${result.reason}`);
    process.exit(result.added ? 0 : 1);
  } else if (cmd === "remove") {
    if (!arg) { console.error("Usage: remove <archetype> --by <operator>"); process.exit(1); }
    const op = String(values.by ?? "operator");
    const result = removeArchetype(arg, op);
    console.log(result.removed ? `Removed: ${result.reason}` : `Skipped: ${result.reason}`);
    process.exit(result.removed ? 0 : 1);
  } else {
    console.log("Usage: bun archetype-allowlist.ts <list|check|add|remove> [archetype] [--by operator] [--json]");
    process.exit(0);
  }
}
