#!/usr/bin/env bun
/**
 * T1 (SF-004) — Verdict Sidecar Schema + Validator + Writer
 *
 * Machine-readable post-flight outcomes at evaluations/<id>.verdict.json.
 * These sidecars are the ONLY ground truth for first-pass yield: a run
 * without a resolvable sidecar is UNMEASURED and can never count as passed.
 * The writer is fail-loud (refuses clobber without --force). Parsing and
 * resolution are pure with injectable directories so the self-test (T6) can
 * run fully sandboxed.
 *
 * rework=true means the run needed post-gate fix cycles (consensus-mined
 * fixes, re-verification loops, post-flight amendments). Post-merge defect
 * repair is out of scope (SF-012 territory).
 *
 * Usage:
 *   bun factory-verdict.ts write --id sf001 --ticket SF-001 --verdict pass \
 *       --rework false --evidence "..." [--execution-id exec-abc] \
 *       [--decided-at ISO] [--force]
 *   bun factory-verdict.ts validate <file>... | --all
 *   bun factory-verdict.ts resolve (--execution-id exec-abc | --ticket SF-001)
 *   bun factory-verdict.ts list
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { promotionBlockers, readEvidenceManifest, type EvidenceMode } from "./factory-evidence";
import type { OutcomeActor } from "./outcome-envelope";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VerdictOutcome = "pass" | "fail";

export interface Verdict {
  ticket: string;
  execution_id: string | null;
  verdict: VerdictOutcome;
  rework: boolean;
  evidence: string;
  decided_at: string; // ISO-8601
  /** SF-012 (optional, additive): summary of dissenting consensus-panel
   * findings at post-flight. Absent on pre-SF-012 sidecars and when there was
   * no dissent — absence keeps output byte-identical to the legacy schema. */
  consensus_dissent?: string;
  evidence_manifest_path?: string;
  evidence_manifest_hash?: string;
  evidence_mode?: EvidenceMode;
  outcome_verifier?: OutcomeActor;
  commit_digest?: string;
  evidence_digest?: string;
}

export type ParseResult =
  | { ok: true; verdict: Verdict; warnings: string[] }
  | { ok: false; errors: string[] };

export type VerdictResolution =
  | { measured: true; verdict: Verdict; path: string; invalid: string[] }
  | { measured: false; verdict: null; path: null; invalid: string[] };

// ─── Paths ────────────────────────────────────────────────────────────────────

export const EVALUATIONS_DIR = join(import.meta.dir, "..", "evaluations");

const KNOWN_KEYS = new Set([
  "ticket",
  "execution_id",
  "verdict",
  "rework",
  "evidence",
  "decided_at",
  "consensus_dissent",
  "evidence_manifest_path",
  "evidence_manifest_hash",
  "evidence_mode",
  "outcome_verifier",
  "commit_digest",
  "evidence_digest",
]);

export function verdictPath(id: string, dir: string = EVALUATIONS_DIR): string {
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    throw new Error(`invalid sidecar id ${JSON.stringify(id)} — use [a-z0-9._-]`);
  }
  return join(dir, `${id}.verdict.json`);
}

// ─── Pure: parse / validate ───────────────────────────────────────────────────

export function parseVerdict(raw: unknown): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, errors: ["verdict must be a JSON object"] };
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) warnings.push(`unknown field ${JSON.stringify(key)} ignored`);
  }

  if (typeof obj.ticket !== "string" || obj.ticket.trim() === "") {
    errors.push("ticket: required non-empty string");
  }

  let execution_id: string | null = null;
  if (obj.execution_id !== undefined && obj.execution_id !== null) {
    if (typeof obj.execution_id !== "string" || obj.execution_id.trim() === "") {
      errors.push("execution_id: must be a non-empty string or null");
    } else {
      execution_id = obj.execution_id;
    }
  }

  if (obj.verdict !== "pass" && obj.verdict !== "fail") {
    errors.push(`verdict: must be "pass" or "fail" (got ${JSON.stringify(obj.verdict)})`);
  }

  if (typeof obj.rework !== "boolean") {
    errors.push(`rework: must be boolean (got ${JSON.stringify(obj.rework)})`);
  }

  if (typeof obj.evidence !== "string" || obj.evidence.trim() === "") {
    errors.push("evidence: required non-empty string");
  }

  if (
    typeof obj.decided_at !== "string" ||
    Number.isNaN(Date.parse(obj.decided_at))
  ) {
    errors.push(`decided_at: must be a valid ISO-8601 timestamp (got ${JSON.stringify(obj.decided_at)})`);
  }

  // SF-012: optional; null is treated as absent so the field never serializes
  // unless real dissent was recorded (byte-parity with pre-SF-012 sidecars).
  let consensus_dissent: string | undefined;
  if (obj.consensus_dissent !== undefined && obj.consensus_dissent !== null) {
    if (typeof obj.consensus_dissent !== "string" || obj.consensus_dissent.trim() === "") {
      errors.push("consensus_dissent: must be a non-empty string when present");
    } else {
      consensus_dissent = obj.consensus_dissent.trim();
    }
  }

  let evidence_manifest_path: string | undefined;
  let evidence_manifest_hash: string | undefined;
  let evidence_manifest_commit_digest: string | undefined;
  let evidence_mode: EvidenceMode | undefined;
  if (obj.evidence_mode !== undefined) {
    if (obj.evidence_mode !== "advisory" && obj.evidence_mode !== "blocking") errors.push("evidence_mode: must be advisory|blocking");
    else evidence_mode = obj.evidence_mode;
  }
  if (obj.evidence_manifest_path !== undefined || obj.evidence_manifest_hash !== undefined) {
    if (typeof obj.evidence_manifest_path !== "string" || obj.evidence_manifest_path.trim() === "") {
      errors.push("evidence_manifest_path: required non-empty string when evidence manifest is supplied");
    } else if (typeof obj.evidence_manifest_hash !== "string" || !/^sha256:[0-9a-f]{64}$/.test(obj.evidence_manifest_hash)) {
      errors.push("evidence_manifest_hash: must be sha256:<64 lowercase hex>");
    } else {
      try {
        const manifest = readEvidenceManifest(obj.evidence_manifest_path);
        if (manifest.content_hash !== obj.evidence_manifest_hash) errors.push("evidence manifest hash does not match sidecar");
        if (evidence_mode !== undefined && manifest.rollout_mode !== evidence_mode) errors.push("evidence mode does not match manifest rollout mode");
        for (const blocker of promotionBlockers(manifest)) errors.push(`evidence manifest blocks promotion: ${blocker}`);
        evidence_manifest_path = obj.evidence_manifest_path;
        evidence_manifest_hash = obj.evidence_manifest_hash;
        evidence_manifest_commit_digest = manifest.commit_digest;
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }
  const decidedAt = typeof obj.decided_at === "string" ? Date.parse(obj.decided_at) : Number.NaN;
  const evidenceRolloutStartedAt = Date.parse("2026-07-11T00:00:00.000Z");
  if (obj.verdict === "pass" && Number.isFinite(decidedAt) && decidedAt >= evidenceRolloutStartedAt && evidence_mode === undefined) {
    errors.push("passing verdicts created after evidence-v1 rollout must declare evidence_mode");
  }
  if (obj.verdict === "pass" && (evidence_mode === "blocking" || process.env.SF_EVIDENCE_MODE === "blocking") && evidence_manifest_path === undefined) {
    errors.push("passing verdict requires a validated evidence manifest in blocking mode");
  }

  let outcome_verifier: OutcomeActor | undefined;
  let commit_digest: string | undefined;
  let evidence_digest: string | undefined;
  const outcomeFields = [obj.outcome_verifier, obj.commit_digest, obj.evidence_digest];
  if (outcomeFields.some((value) => value !== undefined)) {
    if (outcomeFields.some((value) => value === undefined)) {
      errors.push("outcome_verifier, commit_digest, and evidence_digest must be supplied together");
    } else {
      const verifier = obj.outcome_verifier;
      if (verifier === null || typeof verifier !== "object" || Array.isArray(verifier)) {
        errors.push("outcome_verifier: must be an object");
      } else {
        const rawVerifier = verifier as Record<string, unknown>;
        const unknown = Object.keys(rawVerifier).filter((key) => !["id", "harness", "model"].includes(key));
        if (unknown.length > 0) errors.push(`outcome_verifier: unknown fields ${unknown.join(", ")}`);
        if (typeof rawVerifier.id !== "string" || rawVerifier.id.trim() === "") errors.push("outcome_verifier.id: required non-empty string");
        if (typeof rawVerifier.harness !== "string" || rawVerifier.harness.trim() === "") errors.push("outcome_verifier.harness: required non-empty string");
        if (typeof rawVerifier.model !== "string" || rawVerifier.model.trim() === "") errors.push("outcome_verifier.model: required non-empty string");
        if (typeof rawVerifier.id === "string" && rawVerifier.id.trim()
          && typeof rawVerifier.harness === "string" && rawVerifier.harness.trim()
          && typeof rawVerifier.model === "string" && rawVerifier.model.trim()) {
          outcome_verifier = {
            id: rawVerifier.id.trim(),
            harness: rawVerifier.harness.trim(),
            model: rawVerifier.model.trim(),
          };
        }
      }
      if (typeof obj.commit_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(obj.commit_digest)) {
        errors.push("commit_digest: must be sha256:<64 lowercase hex>");
      } else commit_digest = obj.commit_digest;
      if (typeof obj.evidence_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(obj.evidence_digest)) {
        errors.push("evidence_digest: must be sha256:<64 lowercase hex>");
      } else evidence_digest = obj.evidence_digest;
      if (evidence_manifest_path === undefined || evidence_manifest_hash === undefined) {
        errors.push("outcome binding requires a validated evidence manifest");
      } else {
        if (evidence_digest !== evidence_manifest_hash) errors.push("evidence_digest must match evidence_manifest_hash");
        if (evidence_manifest_commit_digest !== commit_digest) errors.push("commit_digest must match the evidence manifest commit_digest");
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  return {
    ok: true,
    warnings,
    verdict: {
      ticket: (obj.ticket as string).trim(),
      execution_id,
      verdict: obj.verdict as VerdictOutcome,
      rework: obj.rework as boolean,
      evidence: (obj.evidence as string).trim(),
      decided_at: obj.decided_at as string,
      ...(consensus_dissent !== undefined ? { consensus_dissent } : {}),
      ...(evidence_manifest_path !== undefined ? { evidence_manifest_path, evidence_manifest_hash } : {}),
      ...(evidence_mode !== undefined ? { evidence_mode } : {}),
      ...(outcome_verifier !== undefined && commit_digest !== undefined && evidence_digest !== undefined
        ? { outcome_verifier, commit_digest, evidence_digest }
        : {}),
    },
  };
}

/** First-pass = passed without any post-gate fix cycle. */
export function isFirstPass(v: Verdict): boolean {
  return v.verdict === "pass" && !v.rework;
}

// ─── Pure-ish: resolution (reads injected dir, never throws on bad files) ─────

export function listSidecarPaths(dir: string = EVALUATIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".verdict.json"))
    .sort()
    .map((f) => join(dir, f));
}

function loadSidecar(path: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    return { ok: false, errors: [`unreadable/malformed JSON: ${(e as Error).message}`] };
  }
  return parseVerdict(raw);
}

/**
 * Resolve the sidecar for a run. Match precedence: execution_id, then ticket.
 * A corrupt sidecar NEVER resolves as measured — it lands in `invalid` so the
 * collector can report it loudly while still counting the run unmeasured.
 */
export function resolveVerdict(
  query: { executionId?: string; ticket?: string },
  dir: string = EVALUATIONS_DIR,
): VerdictResolution {
  const invalid: string[] = [];
  const valid: Array<{ verdict: Verdict; path: string }> = [];

  for (const path of listSidecarPaths(dir)) {
    const parsed = loadSidecar(path);
    if (parsed.ok) valid.push({ verdict: parsed.verdict, path });
    else invalid.push(path);
  }

  if (query.executionId) {
    const hit = valid.find((v) => v.verdict.execution_id === query.executionId);
    if (hit) return { measured: true, ...hit, invalid };
  }
  if (query.ticket) {
    const hit = valid.find((v) => v.verdict.ticket === query.ticket);
    if (hit) return { measured: true, ...hit, invalid };
  }
  return { measured: false, verdict: null, path: null, invalid };
}

// ─── Writer (fail-loud) ───────────────────────────────────────────────────────

export function writeVerdict(
  id: string,
  verdict: Verdict,
  opts: { dir?: string; force?: boolean } = {},
): string {
  const dir = opts.dir ?? EVALUATIONS_DIR;
  const path = verdictPath(id, dir);
  const parsed = parseVerdict(verdict);
  if (parsed.ok === false) {
    throw new Error(`refusing to write invalid verdict:\n  ${parsed.errors.join("\n  ")}`);
  }
  if (existsSync(path) && !opts.force) {
    throw new Error(`refusing to clobber existing sidecar ${path} (use --force)`);
  }
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(parsed.verdict, null, 2) + "\n");
  return path;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function argValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args[i + 1];
}

function usage(): never {
  console.error(
    [
      "usage:",
      "  factory-verdict.ts write --id <id> --ticket <T> --verdict pass|fail --rework true|false --evidence <text> [--execution-id <exec>] [--decided-at <ISO>] [--evidence-mode advisory|blocking] [--evidence-manifest <path> --evidence-hash <sha256:...>] [--consensus-dissent <text>] [--force]",
      "  factory-verdict.ts validate <file>... | --all",
      "  factory-verdict.ts resolve (--execution-id <exec> | --ticket <T>)",
      "  factory-verdict.ts list",
    ].join("\n"),
  );
  process.exit(2);
}

function cliWrite(args: string[]): number {
  const id = argValue(args, "--id");
  const ticket = argValue(args, "--ticket");
  const outcome = argValue(args, "--verdict");
  const rework = argValue(args, "--rework");
  const evidence = argValue(args, "--evidence");
  if (!id || !ticket || !outcome || !rework || !evidence) usage();
  if (rework !== "true" && rework !== "false") {
    console.error(`--rework must be true|false (got ${JSON.stringify(rework)})`);
    return 2;
  }
  const dissent = argValue(args, "--consensus-dissent");
  const evidenceManifestPath = argValue(args, "--evidence-manifest");
  const evidenceManifestHash = argValue(args, "--evidence-hash");
  const candidate = {
    ticket,
    execution_id: argValue(args, "--execution-id") ?? null,
    verdict: outcome,
    rework: rework === "true",
    evidence,
    decided_at: argValue(args, "--decided-at") ?? new Date().toISOString(),
    ...(argValue(args, "--evidence-mode") !== undefined ? { evidence_mode: argValue(args, "--evidence-mode") } : {}),
    ...(dissent !== undefined ? { consensus_dissent: dissent } : {}),
    ...(evidenceManifestPath !== undefined || evidenceManifestHash !== undefined
      ? { evidence_manifest_path: evidenceManifestPath, evidence_manifest_hash: evidenceManifestHash }
      : {}),
  };
  const parsed = parseVerdict(candidate);
  if (parsed.ok === false) {
    console.error("invalid verdict:");
    for (const e of parsed.errors) console.error(`  - ${e}`);
    return 1;
  }
  try {
    const path = writeVerdict(id, parsed.verdict, { force: args.includes("--force") });
    console.log(`wrote ${path}`);
    return 0;
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
}

function cliValidate(args: string[]): number {
  const files = args.includes("--all")
    ? listSidecarPaths()
    : args.filter((a) => !a.startsWith("--"));
  if (files.length === 0) {
    console.error("nothing to validate (no files given / no sidecars found)");
    return 2;
  }
  let failures = 0;
  for (const file of files) {
    const parsed = loadSidecar(file);
    if (parsed.ok === true) {
      const fp = isFirstPass(parsed.verdict) ? "first-pass" : parsed.verdict.verdict === "pass" ? "pass+rework" : "fail";
      console.log(`✅ ${basename(file)} — ${parsed.verdict.ticket} ${fp}`);
      for (const w of parsed.warnings) console.log(`   ⚠ ${w}`);
    } else {
      failures++;
      console.log(`❌ ${basename(file)}`);
      for (const e of parsed.errors) console.log(`   - ${e}`);
    }
  }
  return failures === 0 ? 0 : 1;
}

function cliResolve(args: string[]): number {
  const executionId = argValue(args, "--execution-id");
  const ticket = argValue(args, "--ticket");
  if (!executionId && !ticket) usage();
  const res = resolveVerdict({ executionId, ticket });
  console.log(JSON.stringify(res, null, 2));
  return 0;
}

function cliList(): number {
  const paths = listSidecarPaths();
  if (paths.length === 0) {
    console.log("no verdict sidecars found");
    return 0;
  }
  for (const path of paths) {
    const parsed = loadSidecar(path);
    if (parsed.ok === true) {
      const v = parsed.verdict;
      console.log(
        `${basename(path)}  ticket=${v.ticket}  verdict=${v.verdict}  rework=${v.rework}  first_pass=${isFirstPass(v)}  decided_at=${v.decided_at}`,
      );
    } else {
      console.log(`${basename(path)}  INVALID (${parsed.errors.length} errors — run validate)`);
    }
  }
  return 0;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case "write":
      process.exit(cliWrite(rest));
    case "validate":
      process.exit(cliValidate(rest));
    case "resolve":
      process.exit(cliResolve(rest));
    case "list":
      process.exit(cliList());
    default:
      usage();
  }
}
