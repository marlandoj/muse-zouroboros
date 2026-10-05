#!/usr/bin/env bun
import { factoryStatePath, factoryStatePathForProject, factoryStateRoot, resolveFactoryStateOverride } from "./factory-state-root";
/**
 * T2 (SF-012) — Survivability Probe: post-merge fate via real git/gh
 *
 * Discovers merged agent PRs from the surfaces that already carry PR identity
 * (exec records, intake ledger, SF-010 audit trail) and probes their
 * post-merge fate with REAL `gh pr view` + `git log` — behind an injected
 * ProbeRunner so the classification core stays pure and offline-testable.
 *
 * Honesty invariants:
 *  - A probe failure SKIPS the candidate (logged) — it never fabricates a fate.
 *  - "survived" is knowledge-at-probe-time: a PR still inside its revert
 *    window can be superseded to reverted/hotfixed by a later re-probe
 *    (conveyor step 5h). Reads resolve last-row-per-pr_ref.
 *  - Appends are idempotent: a re-probe with identical material content
 *    (everything but probed_at) appends nothing.
 *
 * Fate rules (deterministic, v1):
 *  - reverted: within revert_window_days a commit whose subject starts with
 *    "Revert" and references #<pr> — or whose body cites the merge sha.
 *  - hotfixed: within revert_window_days a non-revert commit referencing
 *    #<pr> or the ticket identifier with a fix/hotfix/patch subject.
 *  - churn_commits_14d: commits touching the PR's files within
 *    churn_window_days (merge commit excluded); null when files unknown.
 *
 * Usage:
 *   bun survivability-probe.ts harvest [--json]   (SF012_SURVIVAL=1 only)
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { isExecutionRecordFileName } from "./execution-lifecycle";
import {
  OBSERVATION_WINDOWS_HOURS,
  type FateRecord,
  type SurvivabilityConfig,
  fateKey,
  fateObservationKey,
  fateLedgerPath,
  latestFates,
  latestFateObservations,
  loadSurvivabilityConfig,
  readFateLedger,
  resolveSf012ProjectDir,
  sf012Flags,
} from "./survivability-core";

// ─── Probe runner (injected) ─────────────────────────────────────────────────

export interface PrView {
  state: string; // "MERGED" | "OPEN" | "CLOSED"
  merged_at: string | null;
  merge_sha: string | null;
  files: string[] | null;
}

export interface CommitInfo {
  sha: string;
  iso: string;
  subject: string;
  body: string;
}

export interface ProbeRunner {
  /** null = probe failure (candidate is skipped, never classified). repository qualifies the gh lookup — a bare PR number against the default repo context classifies the WRONG repo's PR. */
  prView(prRef: string, repository: string): Promise<PrView | null>;
  /** Commits since an ISO stamp in the candidate's local checkout, optionally path-filtered. null = probe failure. */
  commitsSince(repoPath: string, sinceIso: string, paths?: string[]): Promise<CommitInfo[] | null>;
}

const PROJECT_DIR = resolveSf012ProjectDir(join(import.meta.dir, ".."));

export function realProbeRunner(): ProbeRunner {
  return {
    async prView(prRef: string, repository: string): Promise<PrView | null> {
      try {
        // stderr ignored, not piped: an unread pipe can deadlock the child on buffer fill.
        const proc = Bun.spawn(
          ["gh", "pr", "view", prRef, "--repo", repository, "--json", "state,mergedAt,mergeCommit,files"],
          { stdout: "pipe", stderr: "ignore" },
        );
        const out = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) return null;
        const j = JSON.parse(out) as {
          state?: string;
          mergedAt?: string | null;
          mergeCommit?: { oid?: string } | null;
          files?: Array<{ path?: string }>;
        };
        return {
          state: j.state ?? "",
          merged_at: j.mergedAt ?? null,
          merge_sha: j.mergeCommit?.oid ?? null,
          files: Array.isArray(j.files) ? j.files.map((f) => f.path ?? "").filter(Boolean) : null,
        };
      } catch {
        return null;
      }
    },
    async commitsSince(repoPath: string, sinceIso: string, paths?: string[]): Promise<CommitInfo[] | null> {
      try {
        // Post-merge history lives on the target's main, not whatever branch the
        // checkout happens to be on (the meta-repo sits on a feature branch).
        let ref = "HEAD";
        for (const candidate of ["zbr/main", "origin/main"]) {
          const check = Bun.spawnSync(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", candidate], { stdout: "ignore", stderr: "ignore" });
          if (check.exitCode === 0) { ref = candidate; break; }
        }
        const args = ["git", "-C", repoPath, "log", ref, `--since=${sinceIso}`, "--format=%H%x1f%cI%x1f%s%x1f%b%x1e"];
        if (paths && paths.length > 0) args.push("--", ...paths);
        const proc = Bun.spawn(args, { stdout: "pipe", stderr: "ignore" });
        const out = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) return null;
        return out
          .split("\x1e")
          .map((c) => c.replace(/^\s+/, ""))
          .filter(Boolean)
          .map((chunk) => {
            const [sha = "", iso = "", subject = "", body = ""] = chunk.split("\x1f");
            return { sha, iso, subject, body };
          })
          .filter((c) => c.sha !== "" && c.iso !== "");
      } catch {
        return null;
      }
    },
  };
}

// ─── Candidate discovery (from surfaces that already carry PR identity) ───────

export interface MergeCandidate {
  pr_ref: string;
  /** owner/repo slug — null when unresolvable; the probe then SKIPS (never guesses a repo). */
  repository: string | null;
  /** Local checkout used for post-merge history; null when unknown. */
  repo_path: string | null;
  ticket_id: string;
  identifier: string | null;
  archetype: string;
}

export interface DiscoverSources {
  /** The single canonical factory-state root. */
  stateDirs: string[];
  intakeLedgerPaths: string[];
  auditDir: string;
}

export function defaultDiscoverSources(): DiscoverSources {
  const stateDirs = [factoryStateRoot()];
  return {
    stateDirs,
    intakeLedgerPaths: stateDirs.map((dir) => join(dir, "intake-ledger.jsonl")),
    auditDir: factoryStatePath("auto-merge-audit"),
  };
}

// ─── Repository resolution (pr_url wins; else local remote; else null) ────────

const SLUG_RE = /github\.com[/:]([^/]+\/[^/.]+?)(?:\.git)?(?:\/|$)/;

export function slugFromPrUrl(prUrl: unknown): string | null {
  if (typeof prUrl !== "string") return null;
  const m = prUrl.match(/github\.com\/([^/]+\/[^/]+)\/pull\/\d+/);
  return m ? m[1] : null;
}

const repoSlugCache = new Map<string, string | null>();

/**
 * Resolve a local checkout to its GitHub slug. Prefers the `zbr` remote (the
 * meta-repo's only allowlisted push destination) over `origin` because the
 * meta-repo's origin points at a repo the factory never ships to.
 */
export function resolveRepoSlug(repoPath: string): string | null {
  const cached = repoSlugCache.get(repoPath);
  if (cached !== undefined) return cached;
  let slug: string | null = null;
  for (const remote of ["zbr", "origin"]) {
    try {
      const proc = Bun.spawnSync(["git", "-C", repoPath, "remote", "get-url", remote], { stdout: "pipe", stderr: "ignore" });
      if (proc.exitCode !== 0) continue;
      const url = proc.stdout.toString().trim();
      const m = url.match(SLUG_RE);
      if (m) { slug = m[1]; break; }
    } catch { /* no git or no remote — fall through */ }
  }
  repoSlugCache.set(repoPath, slug);
  return slug;
}

/** Torn-tolerant. Exec records win (they carry ticket + SF-011 archetype stamp). */
export function discoverCandidates(sources: DiscoverSources = defaultDiscoverSources()): MergeCandidate[] {
  const byPr = new Map<string, MergeCandidate>();
  const seenPrNumbers = new Set<string>();
  const put = (c: MergeCandidate, overwrite: boolean) => {
    const key = `${c.repository ?? "?"}#${c.pr_ref}`;
    if (overwrite || !byPr.has(key)) byPr.set(key, c);
    seenPrNumbers.add(c.pr_ref);
  };

  for (const stateDir of sources.stateDirs) {
    if (!existsSync(stateDir)) continue;
    for (const f of readdirSync(stateDir).sort()) {
      if (!isExecutionRecordFileName(f)) continue;
      try {
        const rec = JSON.parse(readFileSync(join(stateDir, f), "utf-8")) as {
          ticket_id?: string;
          identifier?: string;
          pr_number?: number | null;
          pr_url?: string;
          repo_path?: string;
          archetype?: { line?: string };
        };
        if (typeof rec.pr_number === "number") {
          const repoPath = typeof rec.repo_path === "string" && rec.repo_path ? rec.repo_path : null;
          const repository =
            slugFromPrUrl(rec.pr_url) ?? (repoPath && existsSync(repoPath) ? resolveRepoSlug(repoPath) : null);
          put(
            {
              pr_ref: String(rec.pr_number),
              repository,
              repo_path: repoPath,
              ticket_id: rec.ticket_id ?? "unknown",
              identifier: rec.identifier ?? null,
              archetype: rec.archetype?.line ?? "unknown",
            },
            true,
          );
        }
      } catch {
        // torn exec file: skip
      }
    }
  }

  for (const intakeLedgerPath of sources.intakeLedgerPaths) {
    if (!existsSync(intakeLedgerPath)) continue;
    for (const line of readFileSync(intakeLedgerPath, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line) as { ticket_id?: string; identifier?: string; pr_number?: number | null; pr_url?: string };
        if (typeof row.pr_number === "number" && !seenPrNumbers.has(String(row.pr_number))) {
          put(
            {
              pr_ref: String(row.pr_number),
              repository: slugFromPrUrl(row.pr_url),
              repo_path: null,
              ticket_id: row.ticket_id ?? "unknown",
              identifier: row.identifier ?? null,
              archetype: "unknown",
            },
            false,
          );
        }
      } catch {
        // torn line: skip
      }
    }
  }

  if (existsSync(sources.auditDir)) {
    for (const f of readdirSync(sources.auditDir).sort()) {
      if (!f.endsWith(".json")) continue;
      try {
        const audit = JSON.parse(readFileSync(join(sources.auditDir, f), "utf-8")) as {
          pr_ref?: string;
          archetype?: string;
        };
        if (typeof audit.pr_ref === "string" && /^\d+$/.test(audit.pr_ref) && !seenPrNumbers.has(audit.pr_ref)) {
          put(
            {
              pr_ref: audit.pr_ref,
              repository: null,
              repo_path: null,
              ticket_id: "unknown",
              identifier: null,
              archetype: audit.archetype ?? "unknown",
            },
            false,
          );
        }
      } catch {
        // torn audit file: skip
      }
    }
  }

  return [...byPr.values()].sort((a, b) => a.pr_ref.localeCompare(b.pr_ref));
}

// ─── Fate classification (PURE — offline-testable with fake commits) ──────────

export interface FateInputs {
  candidate: MergeCandidate;
  view: PrView;
  commits: CommitInfo[]; // commits since merged_at (unfiltered)
  churnCommits: CommitInfo[] | null; // commits since merged_at touching PR files; null = unknown
  config: SurvivabilityConfig;
  nowIso: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Digit-bounded match: `#1` must not match `#12`; `ZOU-45` must not match `ZOU-450`. */
function boundedRef(token: string): RegExp {
  return new RegExp(`${escapeRegExp(token)}(?![0-9])`);
}

function referencesPr(c: CommitInfo, prRef: string, identifier: string | null, mergeSha: string | null): boolean {
  const text = `${c.subject}\n${c.body}`;
  if (boundedRef(`#${prRef}`).test(text)) return true;
  if (identifier && boundedRef(identifier).test(text)) return true;
  if (mergeSha && mergeSha.length >= 7 && text.includes(mergeSha.slice(0, 7))) return true;
  return false;
}

function isRevertOf(c: CommitInfo, prRef: string, mergeSha: string | null): boolean {
  if (!/^revert\b/i.test(c.subject)) return false;
  if (boundedRef(`#${prRef}`).test(c.subject)) return true;
  if (mergeSha && mergeSha.length >= 7 && c.body.includes(mergeSha.slice(0, 7))) return true;
  return false;
}

function isHotfixOf(c: CommitInfo, candidate: MergeCandidate, mergeSha: string | null): boolean {
  if (/^revert\b/i.test(c.subject)) return false;
  if (!/\b(fix|hotfix|patch)\b/i.test(c.subject)) return false;
  return referencesPr(c, candidate.pr_ref, candidate.identifier, mergeSha);
}

/** Pure classification; throws only on a non-merged view (callers pre-filter). */
export function classifyFate(inputs: FateInputs): Omit<FateRecord, "probed_at"> {
  const { candidate, view, commits, churnCommits, config, nowIso } = inputs;
  if (view.state !== "MERGED" || !view.merged_at) {
    throw new Error(`classifyFate requires a MERGED view (got state=${view.state})`);
  }
  const mergedMs = Date.parse(view.merged_at);
  const revertEndMs = mergedMs + config.revert_window_days * 86_400_000;
  const churnEndMs = mergedMs + config.churn_window_days * 86_400_000;
  const nowMs = Date.parse(nowIso);

  const inWindow = (c: CommitInfo, endMs: number): boolean => {
    const t = Date.parse(c.iso);
    return !Number.isNaN(t) && t > mergedMs && t <= Math.min(endMs, nowMs);
  };

  const windowed = commits
    .filter((c) => inWindow(c, revertEndMs))
    .sort((a, b) => Date.parse(a.iso) - Date.parse(b.iso));

  const revert = windowed.find((c) => isRevertOf(c, candidate.pr_ref, view.merge_sha));
  const hotfix = windowed.find((c) => isHotfixOf(c, candidate, view.merge_sha));

  let churn: number | null = null;
  if (churnCommits !== null && view.files !== null && view.files.length > 0) {
    churn = churnCommits.filter((c) => c.sha !== view.merge_sha && inWindow(c, churnEndMs)).length;
  }

  const fate = revert ? "reverted" : hotfix ? "hotfixed" : "survived";
  return {
    pr_ref: candidate.pr_ref,
    repository: candidate.repository,
    ticket_id: candidate.ticket_id,
    archetype: candidate.archetype,
    merged_at: view.merged_at,
    fate,
    time_to_first_hotfix_hours: hotfix
      ? Math.round(((Date.parse(hotfix.iso) - mergedMs) / 3_600_000) * 100) / 100
      : null,
    churn_commits_14d: churn,
  };
}

// ─── Probe orchestration (IO — failures skip, never fabricate) ───────────────

export type ProbeOutcome =
  | { status: "probed"; record: FateRecord }
  | { status: "not_merged"; pr_ref: string }
  | { status: "skipped"; pr_ref: string; reason: string };

export type WindowProbeOutcome =
  | { status: "probed"; records: FateRecord[] }
  | { status: "pending"; pr_ref: string; next_window_hours: number }
  | { status: "not_merged"; pr_ref: string }
  | { status: "skipped"; pr_ref: string; reason: string };

export async function probeCandidate(
  candidate: MergeCandidate,
  runner: ProbeRunner,
  config: SurvivabilityConfig,
  nowIso = new Date().toISOString(),
): Promise<ProbeOutcome> {
  if (!candidate.repository) {
    return { status: "skipped", pr_ref: candidate.pr_ref, reason: "repository unresolved — refusing to probe a bare PR number against a default repo context" };
  }
  if (!candidate.repo_path || !existsSync(candidate.repo_path)) {
    return { status: "skipped", pr_ref: candidate.pr_ref, reason: `no local checkout for post-merge history (${candidate.repository})` };
  }
  const view = await runner.prView(candidate.pr_ref, candidate.repository);
  if (view === null) return { status: "skipped", pr_ref: candidate.pr_ref, reason: "gh pr view failed" };
  if (view.state !== "MERGED" || !view.merged_at) return { status: "not_merged", pr_ref: candidate.pr_ref };

  const commits = await runner.commitsSince(candidate.repo_path, view.merged_at);
  if (commits === null) return { status: "skipped", pr_ref: candidate.pr_ref, reason: "git log failed" };

  let churnCommits: CommitInfo[] | null = null;
  if (view.files !== null && view.files.length > 0) {
    // Churn probe failure degrades churn to null; fate itself stays classifiable.
    churnCommits = await runner.commitsSince(candidate.repo_path, view.merged_at, view.files);
  }

  const record: FateRecord = {
    ...classifyFate({ candidate, view, commits, churnCommits, config, nowIso }),
    probed_at: nowIso,
  };
  return { status: "probed", record };
}

export async function probeCandidateWindows(
  candidate: MergeCandidate,
  runner: ProbeRunner,
  config: SurvivabilityConfig,
  nowIso = new Date().toISOString(),
): Promise<WindowProbeOutcome> {
  if (!candidate.repository) {
    return { status: "skipped", pr_ref: candidate.pr_ref, reason: "repository unresolved — refusing to probe a bare PR number against a default repo context" };
  }
  if (!candidate.repo_path || !existsSync(candidate.repo_path)) {
    return { status: "skipped", pr_ref: candidate.pr_ref, reason: `no local checkout for post-merge history (${candidate.repository})` };
  }
  const view = await runner.prView(candidate.pr_ref, candidate.repository);
  if (view === null) return { status: "skipped", pr_ref: candidate.pr_ref, reason: "gh pr view failed" };
  if (view.state !== "MERGED" || !view.merged_at) return { status: "not_merged", pr_ref: candidate.pr_ref };

  const mergedMs = Date.parse(view.merged_at);
  const nowMs = Date.parse(nowIso);
  const due = OBSERVATION_WINDOWS_HOURS.filter((hours) => nowMs >= mergedMs + hours * 3_600_000);
  if (due.length === 0) {
    return { status: "pending", pr_ref: candidate.pr_ref, next_window_hours: 24 };
  }

  const commits = await runner.commitsSince(candidate.repo_path, view.merged_at);
  if (commits === null) return { status: "skipped", pr_ref: candidate.pr_ref, reason: "git log failed" };
  let churnCommits: CommitInfo[] | null = null;
  if (view.files !== null && view.files.length > 0) {
    churnCommits = await runner.commitsSince(candidate.repo_path, view.merged_at, view.files);
  }

  return {
    status: "probed",
    records: due.map((hours) => ({
      ...classifyFate({
        candidate,
        view,
        commits,
        churnCommits,
        config,
        nowIso: new Date(mergedMs + hours * 3_600_000).toISOString(),
      }),
      probed_at: nowIso,
      observation_window_hours: hours,
    })),
  };
}

// ─── Idempotent superseding append ────────────────────────────────────────────

function material(rec: FateRecord): string {
  const { probed_at: _ignored, ...rest } = rec;
  return JSON.stringify(Object.fromEntries(Object.entries(rest).sort(([a], [b]) => a.localeCompare(b))));
}

/** Appends only when material content differs from the current row for that PR. */
export function appendFateIfChanged(record: FateRecord, path = fateLedgerPath()): "appended" | "unchanged" {
  const records = readFateLedger(path).records;
  const current = latestFateObservations(records).get(fateObservationKey(record));
  const currentPr = latestFates(records).get(fateKey(record));
  // Archetype enrichment (contract/PR-title backfill) outlives probes whose
  // source surface has no archetype stamp — an "unknown" probe must not
  // supersede a known archetype, or every harvest flip-flops the ledger.
  if (record.archetype === "unknown" && currentPr && currentPr.archetype !== "unknown") {
    record = { ...record, archetype: currentPr.archetype };
  }
  if (current && material(current) === material(record)) return "unchanged";
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + "\n");
  return "appended";
}

// ─── Harvest ──────────────────────────────────────────────────────────────────

export interface HarvestSummary {
  candidates: number;
  probed: number;
  appended: number;
  unchanged: number;
  pending: number;
  not_merged: number;
  skipped: Array<{ pr_ref: string; reason: string }>;
}

export async function harvestFates(
  runner: ProbeRunner = realProbeRunner(),
  sources: DiscoverSources = defaultDiscoverSources(),
  ledgerPath = fateLedgerPath(),
): Promise<HarvestSummary> {
  const config = loadSurvivabilityConfig().config;
  const candidates = discoverCandidates(sources);
  const summary: HarvestSummary = {
    candidates: candidates.length,
    probed: 0,
    appended: 0,
    unchanged: 0,
    pending: 0,
    not_merged: 0,
    skipped: [],
  };
  for (const candidate of candidates) {
    const outcome = await probeCandidateWindows(candidate, runner, config);
    if (outcome.status === "not_merged") summary.not_merged++;
    else if (outcome.status === "pending") summary.pending++;
    else if (outcome.status === "skipped") summary.skipped.push({ pr_ref: outcome.pr_ref, reason: outcome.reason });
    else {
      summary.probed++;
      for (const record of outcome.records) {
        if (appendFateIfChanged(record, ledgerPath) === "appended") summary.appended++;
        else summary.unchanged++;
      }
    }
  }
  return summary;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "harvest") {
    console.error("usage: survivability-probe.ts harvest [--json]   (requires SF012_SURVIVAL=1)");
    process.exit(2);
  }
  // Flag gate BEFORE any read/write (SF-008/SF-009 precedent).
  if (!sf012Flags().survival) process.exit(0);
  const summary = await harvestFates();
  if (rest.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(
      `[sf012] fate harvest: candidates=${summary.candidates} probed=${summary.probed} appended=${summary.appended} unchanged=${summary.unchanged} pending=${summary.pending} not_merged=${summary.not_merged} skipped=${summary.skipped.length}`,
    );
    for (const s of summary.skipped) console.log(`  skipped PR#${s.pr_ref}: ${s.reason}`);
  }
  process.exit(0);
}
