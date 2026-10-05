#!/usr/bin/env bun
/**
 * SF-012 T5 — Survivability & Decision-Signal Feedback Self-Test Harness
 *
 * Sandboxed: every fixture lives in mkdtemp dirs reached via the
 * SF012_CONFIG_PATH / SF012_LEDGER_PATH / SF012_SIGNALS_PATH /
 * SF012_EXEC_STATE_DIR / SF012_QUEUE_PATH overrides or injected paths;
 * subprocess runs get a scrubbed env. Real state/ is never written.
 *
 * Sections:
 *   1. config (fail-loud, defaults-on-absent, shipped ≡ defaults hash)
 *   2. fate ledger (torn tolerance, last-row-per-pr_ref supersede)
 *   3. scoring honesty (n=0, below-min ⇒ null rate, by-archetype buckets)
 *   4. fate classification (pure: revert/hotfix/survived, windows, churn)
 *   5. probe orchestration (fake runner: skip-on-failure, idempotent append)
 *   6. candidate discovery (exec > intake/audit precedence, torn tolerance)
 *   7. decision signals (3-source derivation, idempotent harvest, torn lines)
 *   8. λ blend (cold-start λ=0 exact equality, ramp, cap, null guards)
 *   9. verdict sidecar (consensus_dissent optional — absent ⇒ byte-parity)
 *  10. sf012Snapshot (never throws, counted degradation, env redirect)
 *  11. never-writes + wiring guards (source checks)
 *  12. flags-off identity (all CLIs silent exit-0, zero files created)
 *
 * Exit 0 = all green.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LedgerEntry } from "./approval-ledger";
import {
  DEFAULT_SURVIVABILITY_CONFIG,
  type FateRecord,
  blendReputation,
  computeSurvivability,
  latestFates,
  loadSurvivabilityConfig,
  readFateLedger,
  resolveSf012ProjectDir,
  survivabilityConfigPath,
  validateSurvivabilityConfig,
} from "./survivability-core";
import {
  type CommitInfo,
  type MergeCandidate,
  type ProbeRunner,
  type PrView,
  appendFateIfChanged,
  classifyFate,
  discoverCandidates,
  harvestFates,
  probeCandidate,
  probeCandidateWindows,
  resolveRepoSlug,
  slugFromPrUrl,
} from "./survivability-probe";
import {
  deriveDecisionSignals,
  harvestSignals,
  readSignals,
  sf012Snapshot,
} from "./decision-signals";
import { parseVerdict, writeVerdict } from "./factory-verdict";
import { evaluateSurvivabilityFeedback } from "./survivability-feedback-eval";

const SCRIPT_DIR = import.meta.dir;

let passed = 0;
let failed = 0;
function checkT(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const throws = (fn: () => unknown): boolean => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

function sh(cmd: string): void {
  const r = spawnSync("bash", ["-c", cmd], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`fixture command failed: ${cmd}\n${r.stderr}`);
}

const sandbox = mkdtempSync(join(tmpdir(), "sf012-test-"));
const CFG = DEFAULT_SURVIVABILITY_CONFIG;

try {
  // ─── 1. config ───────────────────────────────────────────────────────────────
  section("1. config (fail-loud, defaults-on-absent, hash witness)");
  {
    const absent = loadSurvivabilityConfig(join(sandbox, "no-such.json"));
    checkT("absent file → built-in defaults", absent.source === "defaults" && absent.config.min_sample === 5);
    const shipped = loadSurvivabilityConfig(survivabilityConfigPath());
    checkT("shipped survivability-config.json loads from file", shipped.source === "file");
    checkT("shipped JSON ≡ defaults (hash witness)", shipped.hash === absent.hash);

    const tornPath = join(sandbox, "torn-config.json");
    writeFileSync(tornPath, '{"min_sample": ');
    checkT("torn JSON throws, error names the path", (() => {
      try {
        loadSurvivabilityConfig(tornPath);
        return false;
      } catch (err) {
        return err instanceof Error && err.message.includes(tornPath);
      }
    })());
    checkT("unknown key throws (typo could loosen honesty knobs)",
      throws(() => validateSurvivabilityConfig({ ...CFG, min_samples: 1 }, "p")));
    checkT("missing key throws", throws(() => validateSurvivabilityConfig({ min_sample: 5 }, "p")));
    checkT("non-integer window throws", throws(() => validateSurvivabilityConfig({ ...CFG, revert_window_days: 1.5 }, "p")));
    checkT("min_sample < 1 throws", throws(() => validateSurvivabilityConfig({ ...CFG, min_sample: 0 }, "p")));
    checkT("lambda_max > 1 throws", throws(() => validateSurvivabilityConfig({ ...CFG, lambda_max: 1.1 }, "p")));
    checkT("array root throws", throws(() => validateSurvivabilityConfig([CFG], "p")));
    checkT("rotated conveyor copies resolve SF-012 evidence to the canonical project root",
      resolveSf012ProjectDir(
        "/home/workspace/.runtime/factory-conveyor-operator-gates-20260806/Projects/zouroboros-software-factory",
        undefined,
      ) === "/home/workspace/Projects/zouroboros-software-factory");
  }

  // ─── 2. fate ledger ──────────────────────────────────────────────────────────
  section("2. fate ledger (torn tolerance, last-row-per-pr_ref)");
  const rec = (pr: string, fate: FateRecord["fate"], archetype = "bugfix", probed = "2026-07-01T00:00:00Z"): FateRecord => ({
    pr_ref: pr,
    repository: "example/repo",
    ticket_id: `ZOU-${pr}`,
    archetype,
    merged_at: "2026-06-01T00:00:00Z",
    fate,
    time_to_first_hotfix_hours: null,
    churn_commits_14d: null,
    probed_at: probed,
    observation_window_hours: 336,
  });
  {
    const ledgerPath = join(sandbox, "fate-ledger.jsonl");
    writeFileSync(
      ledgerPath,
      [
        JSON.stringify(rec("42", "survived")),
        "{torn line",
        JSON.stringify({ pr_ref: "43", fate: "exploded" }), // invalid fate
        JSON.stringify(rec("42", "reverted", "bugfix", "2026-07-02T00:00:00Z")), // supersedes
        JSON.stringify(rec("44", "hotfixed", "docs")),
        "",
      ].join("\n"),
    );
    const ledger = readFateLedger(ledgerPath);
    checkT("torn + invalid rows counted, never thrown", ledger.torn_lines === 2 && ledger.records.length === 3);
    const latest = latestFates(ledger.records);
    checkT("last row per (repository, pr_ref) wins (supersede)", latest.get("example/repo#42")?.fate === "reverted" && latest.size === 2);
    checkT("absent ledger → empty, zero torn", readFateLedger(join(sandbox, "no-ledger.jsonl")).records.length === 0);

    const legacy: FateRecord = { ...rec("9", "survived"), repository: undefined };
    const crossRepo = [rec("9", "survived"), { ...rec("9", "reverted"), repository: "other/repo" }];
    checkT("same pr number in different repos are distinct keys", latestFates(crossRepo).size === 2);
    const withLegacy = computeSurvivability([legacy, rec("10", "survived")], CFG);
    checkT("legacy unqualified rows are excluded from scoring, counted honestly",
      withLegacy.excluded_unqualified === 1 && withLegacy.distinct_prs === 1 && withLegacy.global.n === 1);
  }

  // ─── 3. scoring honesty ──────────────────────────────────────────────────────
  section("3. scoring honesty (min-sample, n=0, by-archetype)");
  {
    const empty = computeSurvivability([], CFG);
    checkT("n=0: insufficient_data, rate null, no invented buckets",
      empty.global.n === 0 && empty.global.insufficient_data && empty.global.survival_rate === null && empty.distinct_prs === 0);

    const four = ["1", "2", "3", "4"].map((p) => rec(p, "survived"));
    const below = computeSurvivability(four, CFG);
    checkT("n=4 < min_sample=5: rate NEVER renders", below.global.insufficient_data && below.global.survival_rate === null && below.global.n === 4);

    const five = [...four, rec("5", "reverted")];
    const at = computeSurvivability(five, CFG);
    checkT("n=5 ≥ min_sample: rate renders (4/5 = 0.8)", !at.global.insufficient_data && at.global.survival_rate === 0.8);
    checkT("by-archetype bucket below threshold stays honest even when global is sufficient",
      at.by_archetype.bugfix.n === 5 ? !at.by_archetype.bugfix.insufficient_data : true);

    const mixed = [...five, rec("6", "hotfixed", "docs")];
    const m = computeSurvivability(mixed, CFG);
    checkT("archetype slice n=1 → insufficient, global n=6 → sufficient",
      m.by_archetype.docs.insufficient_data && m.by_archetype.docs.survival_rate === null && !m.global.insufficient_data);
    checkT("fate counts tally", m.global.survived === 4 && m.global.reverted === 1 && m.global.hotfixed === 1);

    const superseded = [rec("7", "survived"), rec("7", "reverted")];
    const s = computeSurvivability(superseded, CFG);
    checkT("scoring uses latest fate only (supersede, distinct_prs=1)",
      s.distinct_prs === 1 && s.global.reverted === 1 && s.global.survived === 0);
  }

  // ─── 4. fate classification (pure) ──────────────────────────────────────────
  section("4. fate classification (revert/hotfix/survived, windows, churn)");
  const cand: MergeCandidate = { pr_ref: "42", repository: "example/repo", repo_path: sandbox, ticket_id: "ZOU-777", identifier: "ZOU-777", archetype: "bugfix" };
  const mergedView: PrView = {
    state: "MERGED",
    merged_at: "2026-06-01T00:00:00Z",
    merge_sha: "abcdef1234567890aaaaaaaabbbbbbbbcccccccc",
    files: ["src/a.ts", "src/b.ts"],
  };
  const commit = (iso: string, subject: string, body = "", sha = "1111111111111111111111111111111111111111"): CommitInfo => ({ sha, iso, subject, body });
  const now = "2026-06-20T00:00:00Z";
  {
    const revertByPr = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [commit("2026-06-03T00:00:00Z", 'Revert "feat: thing" (#42)')],
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("revert via subject ^Revert + #pr", revertByPr.fate === "reverted");

    const revertBySha = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [commit("2026-06-03T00:00:00Z", "Revert bad change", "This reverts commit abcdef1234567890.")],
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("revert via body citing merge sha 7-prefix", revertBySha.fate === "reverted");

    const hotfix = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [commit("2026-06-02T12:00:00Z", "fix: null guard for ZOU-777")],
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("hotfix via fix-subject + identifier reference", hotfix.fate === "hotfixed");
    checkT("time_to_first_hotfix_hours = 36", hotfix.time_to_first_hotfix_hours === 36);

    const both = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [
        commit("2026-06-02T12:00:00Z", "fix: null guard for ZOU-777"),
        commit("2026-06-03T00:00:00Z", 'Revert "feat: thing" (#42)'),
      ],
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("precedence: revert > hotfix", both.fate === "reverted");

    const outside = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [commit("2026-06-16T00:00:00Z", 'Revert "feat: thing" (#42)')], // day 15 > 14d window
      churnCommits: null,
      config: CFG,
      nowIso: "2026-06-30T00:00:00Z",
    });
    checkT("revert OUTSIDE revert_window_days ignored → survived", outside.fate === "survived");

    const atMerge = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [commit("2026-06-01T00:00:00Z", 'Revert "feat: thing" (#42)')], // t === mergedMs excluded
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("commit at exactly merged_at excluded (t > mergedMs)", atMerge.fate === "survived");

    const beyondNow = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [commit("2026-06-10T00:00:00Z", 'Revert "feat: thing" (#42)')],
      churnCommits: null,
      config: CFG,
      nowIso: "2026-06-05T00:00:00Z", // probe-time clamp
    });
    checkT("knowledge-at-probe-time: commits after nowIso excluded", beyondNow.fate === "survived");

    const churned = classifyFate({
      candidate: cand,
      view: mergedView,
      commits: [],
      churnCommits: [
        commit("2026-06-02T00:00:00Z", "chore: a", "", "2222222222222222222222222222222222222222"),
        commit("2026-06-03T00:00:00Z", "chore: b", "", mergedView.merge_sha as string), // merge commit excluded
        commit("2026-06-20T00:00:00Z", "chore: c", "", "3333333333333333333333333333333333333333"), // outside churn window
      ],
      config: CFG,
      nowIso: "2026-06-30T00:00:00Z",
    });
    checkT("churn counts window-filtered file-touching commits, merge sha excluded", churned.churn_commits_14d === 1);

    const noFiles = classifyFate({
      candidate: cand,
      view: { ...mergedView, files: null },
      commits: [],
      churnCommits: [commit("2026-06-02T00:00:00Z", "chore: a")],
      config: CFG,
      nowIso: now,
    });
    checkT("files unknown → churn null, never guessed", noFiles.churn_commits_14d === null);

    checkT("non-MERGED view throws (callers pre-filter)",
      throws(() => classifyFate({ candidate: cand, view: { ...mergedView, state: "OPEN" }, commits: [], churnCommits: null, config: CFG, nowIso: now })));

    // Consensus regression locks (cg-1783030832568-qa6zro): digit-bounded refs —
    // #4 must not match #42; ZOU-77 must not match ZOU-777.
    const prefixCand: MergeCandidate = { pr_ref: "4", repository: "example/repo", repo_path: sandbox, ticket_id: "ZOU-77", identifier: "ZOU-77", archetype: "bugfix" };
    const prefixRevert = classifyFate({
      candidate: prefixCand,
      view: mergedView,
      commits: [commit("2026-06-03T00:00:00Z", 'Revert "feat: thing" (#42)')],
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("PR #4 does NOT match revert of #42 (digit-bounded)", prefixRevert.fate === "survived");

    const prefixHotfix = classifyFate({
      candidate: prefixCand,
      view: { ...mergedView, merge_sha: null },
      commits: [commit("2026-06-02T12:00:00Z", "fix: patch for #42 in ZOU-777")],
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("identifier ZOU-77 does NOT match hotfix citing ZOU-777 (digit-bounded)", prefixHotfix.fate === "survived");

    const eosHotfix = classifyFate({
      candidate: { ...cand, identifier: null },
      view: { ...mergedView, merge_sha: null },
      commits: [commit("2026-06-02T12:00:00Z", "fix: follow-up for #42")],
      churnCommits: null,
      config: CFG,
      nowIso: now,
    });
    checkT("bounded ref still matches #42 at end-of-subject (positive control)", eosHotfix.fate === "hotfixed");
  }

  // ─── 5. probe orchestration ──────────────────────────────────────────────────
  section("5. probe orchestration (fake runner, skip-on-failure, idempotent append)");
  {
    const failView: ProbeRunner = { prView: async () => null, commitsSince: async () => [] };
    const r1 = await probeCandidate(cand, failView, CFG);
    checkT("gh failure → skipped, never classified", r1.status === "skipped" && r1.reason === "gh pr view failed");

    const openPr: ProbeRunner = { prView: async () => ({ ...mergedView, state: "OPEN" }), commitsSince: async () => [] };
    checkT("non-merged PR → not_merged", (await probeCandidate(cand, openPr, CFG)).status === "not_merged");

    const failLog: ProbeRunner = { prView: async () => mergedView, commitsSince: async () => null };
    const r3 = await probeCandidate(cand, failLog, CFG);
    checkT("git log failure → skipped", r3.status === "skipped" && r3.reason === "git log failed");

    const churnFail: ProbeRunner = {
      prView: async () => mergedView,
      commitsSince: async (_repoPath, _since, paths) => (paths ? null : []),
    };
    const r4 = await probeCandidate(cand, churnFail, CFG);
    checkT("churn probe failure degrades churn to null, fate still probed",
      r4.status === "probed" && r4.record.churn_commits_14d === null && r4.record.fate === "survived");
    checkT("probed record carries the repo qualification",
      r4.status === "probed" && r4.record.repository === "example/repo");

    const okRunner: ProbeRunner = { prView: async () => mergedView, commitsSince: async () => [] };
    const noRepo = await probeCandidate({ ...cand, repository: null }, okRunner, CFG);
    checkT("unresolved repository → skipped, gh never invoked with a bare number",
      noRepo.status === "skipped" && noRepo.reason.includes("repository unresolved"));
    const noPath = await probeCandidate({ ...cand, repo_path: join(sandbox, "missing-checkout") }, okRunner, CFG);
    checkT("missing local checkout → skipped, history never fabricated",
      noPath.status === "skipped" && noPath.reason.includes("no local checkout"));

    const pending = await probeCandidateWindows(cand, okRunner, CFG, "2026-06-01T12:00:00Z");
    checkT("window probe before 24h is pending and emits no survived row",
      pending.status === "pending" && pending.next_window_hours === 24);
    const dayEight = await probeCandidateWindows(cand, okRunner, CFG, "2026-06-09T00:00:00Z");
    checkT("window probe reconstructs exactly 24h and 7d cutoffs at day 8",
      dayEight.status === "probed" &&
      dayEight.records.map((r) => r.observation_window_hours).join(",") === "24,168" &&
      dayEight.records.every((r) => r.probed_at === "2026-06-09T00:00:00Z"));

    // idempotent superseding append
    const ledgerPath = join(sandbox, "probe-ledger.jsonl");
    const survived = { ...rec("42", "survived"), probed_at: "2026-07-01T00:00:00Z" };
    checkT("first probe appends", appendFateIfChanged(survived, ledgerPath) === "appended");
    const reProbe = { ...survived, probed_at: "2026-07-02T00:00:00Z" }; // only probed_at differs
    checkT("re-probe with identical material content appends NOTHING", appendFateIfChanged(reProbe, ledgerPath) === "unchanged");
    const earlierWindow = { ...survived, observation_window_hours: 168 as const, probed_at: "2026-07-02T00:00:00Z" };
    checkT("same fate at a distinct milestone appends independent evidence", appendFateIfChanged(earlierWindow, ledgerPath) === "appended");
    const flipped = { ...survived, fate: "reverted" as const, probed_at: "2026-07-03T00:00:00Z" };
    checkT("fate flip supersedes (appends)", appendFateIfChanged(flipped, ledgerPath) === "appended");
    checkT("reads resolve to the superseding row",
      latestFates(readFateLedger(ledgerPath).records).get("example/repo#42")?.fate === "reverted");

    const enriched = { ...flipped, archetype: "docs", probed_at: "2026-07-04T00:00:00Z" };
    checkT("archetype enrichment supersedes unknown-stamped history", appendFateIfChanged(enriched, ledgerPath) === "appended");
    const unknownReProbe = { ...flipped, archetype: "unknown", probed_at: "2026-07-05T00:00:00Z" };
    checkT("an unknown-archetype re-probe inherits enrichment (idempotent, no flip-flop)",
      appendFateIfChanged(unknownReProbe, ledgerPath) === "unchanged" &&
      latestFates(readFateLedger(ledgerPath).records).get("example/repo#42")?.archetype === "docs");
  }

  // ─── 6. candidate discovery ──────────────────────────────────────────────────
  section("6. candidate discovery (exec wins, torn tolerance)");
  {
    const srcDir = join(sandbox, "discover");
    const stateDir = join(srcDir, "state");
    const rotatedDir = join(srcDir, "rotated-state");
    const auditDir = join(stateDir, "auto-merge-audit");
    mkdirSync(auditDir, { recursive: true });
    mkdirSync(rotatedDir, { recursive: true });
    writeFileSync(join(stateDir, "exec-aaaa0001.json"),
      JSON.stringify({ execution_id: "aaaa0001", ticket_id: "ZOU-1", identifier: "ZOU-1", pr_number: 42, archetype: { line: "bugfix" }, pr_url: "https://github.com/example/repo/pull/42", repo_path: sandbox }));
    writeFileSync(join(stateDir, "exec-aaaa0002.json"), JSON.stringify({ execution_id: "aaaa0002", ticket_id: "ZOU-2" })); // no pr_number
    writeFileSync(join(stateDir, "exec-aaaa0003.json"), "{torn");
    // Rotated conveyor root — conveyor roots rotate per operator activation; any single-dir scan under-counts.
    writeFileSync(join(rotatedDir, "exec-bbbb0001.json"),
      JSON.stringify({ execution_id: "bbbb0001", ticket_id: "ZOU-9", identifier: "ZOU-9", pr_number: 45, archetype: { line: "feature" }, pr_url: "https://github.com/example/other/pull/45", repo_path: sandbox }));
    const intakePath = join(stateDir, "intake-ledger.jsonl");
    writeFileSync(intakePath, [
      JSON.stringify({ ticket_id: "ZOU-STALE", identifier: "ZOU-STALE", pr_number: 42 }), // loses to exec
      JSON.stringify({ ticket_id: "ZOU-3", identifier: "ZOU-3", pr_number: 43 }),
      "{torn",
    ].join("\n"));
    writeFileSync(join(auditDir, "audit-1.json"), JSON.stringify({ pr_ref: "43", archetype: "docs" })); // loses to intake
    writeFileSync(join(auditDir, "audit-2.json"), JSON.stringify({ pr_ref: "44", archetype: "dependency" }));
    writeFileSync(join(auditDir, "audit-3.json"), JSON.stringify({ pr_ref: "exec-not-a-pr", archetype: "docs" }));

    const sources = { stateDirs: [stateDir, rotatedDir], intakeLedgerPaths: [intakePath], auditDir };
    const cands = discoverCandidates(sources);
    checkT("4 distinct PRs discovered across both state dirs, torn rows skipped", cands.length === 4);
    const pr42 = cands.find((c) => c.pr_ref === "42");
    checkT("exec record wins for PR identity (ticket + archetype stamp)",
      pr42?.ticket_id === "ZOU-1" && pr42?.archetype === "bugfix");
    checkT("repository resolved from pr_url", pr42?.repository === "example/repo" && pr42?.repo_path === sandbox);
    checkT("rotated-root exec record discovered (union, FR-03 lesson)",
      cands.find((c) => c.pr_ref === "45")?.repository === "example/other");
    const pr43 = cands.find((c) => c.pr_ref === "43");
    checkT("intake beats audit for the same PR (first non-exec wins)", pr43?.ticket_id === "ZOU-3");
    checkT("intake/audit rows without pr_url stay unresolved (never guessed)",
      pr43?.repository === null && cands.find((c) => c.pr_ref === "44")?.repository === null);
    checkT("legacy audit execution ids are not admitted as PR references",
      !cands.some((c) => c.pr_ref.startsWith("exec-")));

    // full harvest with a fake runner, sandboxed ledger: 42+45 resolved and probed;
    // 43+44 skipped as repository-unresolved BEFORE any gh call.
    const runner: ProbeRunner = {
      prView: async () => ({ state: "MERGED", merged_at: "2026-06-01T00:00:00Z", merge_sha: null, files: null }),
      commitsSince: async () => [],
    };
    const ledgerPath = join(sandbox, "harvest-ledger.jsonl");
    const h1 = await harvestFates(runner, sources, ledgerPath);
    checkT("harvest: 2 candidates × 3 mature windows appended, 2 unresolved skipped",
      h1.candidates === 4 && h1.probed === 2 && h1.appended === 6 && h1.skipped.length === 2 &&
      h1.skipped.every((s) => s.reason.includes("repository unresolved")));
    const h2 = await harvestFates(runner, sources, ledgerPath);
    checkT("re-harvest idempotent: 0 appended, 6 milestone rows unchanged", h2.appended === 0 && h2.unchanged === 6);
  }

  // ─── 6b. repository resolution ───────────────────────────────────────────────
  section("6b. repository resolution (pr_url, local remotes, zbr preference)");
  {
    checkT("slugFromPrUrl parses a pull URL", slugFromPrUrl("https://github.com/owner/name/pull/398") === "owner/name");
    checkT("slugFromPrUrl rejects non-PR urls and garbage",
      slugFromPrUrl("https://github.com/owner/name") === null && slugFromPrUrl(undefined) === null);

    const originRepo = join(sandbox, "repo-origin");
    mkdirSync(originRepo, { recursive: true });
    sh(`git init -q ${originRepo} && git -C ${originRepo} remote add origin https://github.com/acme/site.git`);
    checkT("resolveRepoSlug reads origin", resolveRepoSlug(originRepo) === "acme/site");

    const zbrRepo = join(sandbox, "repo-zbr");
    mkdirSync(zbrRepo, { recursive: true });
    sh(`git init -q ${zbrRepo} && git -C ${zbrRepo} remote add origin https://github.com/wrong/meta.git && git -C ${zbrRepo} remote add zbr https://github.com/right/ship.git`);
    checkT("resolveRepoSlug prefers zbr over origin (meta-repo ship destination)", resolveRepoSlug(zbrRepo) === "right/ship");

    checkT("resolveRepoSlug returns null for a non-repo path", resolveRepoSlug(join(sandbox, "not-a-repo")) === null);
  }

  // ─── 7. decision signals ─────────────────────────────────────────────────────
  section("7. decision signals (3 sources, idempotent harvest)");
  {
    const approvals = [
      {
        verdict: { verdict_id: "v-1", ticket_id: "ZOU-9", tier: "low" },
        operator_verdict: "rejected",
        agreement: false,
        appended_at: "2026-07-01T00:00:00Z",
      },
      {
        verdict: { verdict_id: "v-2", ticket_id: "ZOU-10", tier: "high" },
        operator_verdict: "approved",
        agreement: true, // agreement → NOT a signal
        appended_at: "2026-07-01T00:00:00Z",
      },
    ] as unknown as LedgerEntry[];

    const derived = deriveDecisionSignals({
      execs: [
        { execution_id: "e1", ticket_id: "ZOU-8", identifier: "ZOU-8", started_at: "2026-07-01T00:00:00Z", archetype: { line: "docs", source: "declared", fine: null, disagreement: true } },
        { execution_id: "e2", ticket_id: "ZOU-8b", identifier: null, started_at: "2026-07-01T00:00:00Z", archetype: { line: "bugfix", source: "declared", fine: null, disagreement: false } },
        { execution_id: "e3", ticket_id: "ZOU-8c", identifier: null, started_at: "2026-07-01T00:00:00Z" }, // unstamped
      ],
      approvals,
      queueRows: [
        {
          pr_ref: "51",
          archetype: "bugfix",
          ts: "2026-07-01T01:00:00Z",
          gates: [
            { gate: "tests", passed: false, reason: "2 failing" },
            { gate: "tsc", passed: true, reason: "" },
            { gate: "postflight", passed: false, reason: "missing sidecar" },
          ],
        },
      ],
    });
    checkT("derives exactly the real signals: 1 classifier + 1 approval + 2 gate",
      derived.length === 4 &&
        derived.filter((s) => s.source === "classifier_disagreement").length === 1 &&
        derived.filter((s) => s.source === "approval_disagreement").length === 1 &&
        derived.filter((s) => s.source === "gate_failure").length === 2);
    checkT("agreement=true and disagreement=false rows emit nothing",
      !derived.some((s) => s.source_key === "v-2" || s.source_key === "e2"));
    checkT("gate keys are per-gate unique",
      new Set(derived.filter((s) => s.source === "gate_failure").map((s) => s.source_key)).size === 2);

    const sigPath = join(sandbox, "signals.jsonl");
    const s1 = harvestSignals(derived, sigPath);
    checkT("harvest appends all fresh signals", s1.appended === 4 && s1.duplicates === 0);
    const s2 = harvestSignals(derived, sigPath);
    checkT("re-harvest appends ZERO duplicates", s2.appended === 0 && s2.duplicates === 4);
    const s3 = harvestSignals([...derived.slice(0, 1), ...derived.slice(0, 1)], sigPath);
    checkT("in-batch duplicate deduped too", s3.appended === 0 && s3.duplicates === 2);

    writeFileSync(sigPath, readFileSync(sigPath, "utf-8") + "{torn\n" + JSON.stringify({ source: "bogus", source_key: "x" }) + "\n");
    const ledger = readSignals(sigPath);
    checkT("torn + unknown-source lines counted, never thrown", ledger.torn_lines === 2 && ledger.records.length === 4);
  }

  // ─── 8. λ blend ──────────────────────────────────────────────────────────────
  section("8. λ blend (cold-start, ramp, cap, null guards)");
  {
    const bucket = (n: number, survived: number) => ({
      n,
      survived,
      reverted: n - survived,
      hotfixed: 0,
      survival_rate: n >= CFG.min_sample ? Math.round((survived / n) * 10000) / 10000 : null,
      insufficient_data: n < CFG.min_sample,
    });

    const cold = blendReputation({ rate: 0.9, resolved: 20 }, bucket(4, 4), CFG);
    checkT("below min_sample: λ HARD 0, cold_start flagged", cold.lambda === 0 && cold.cold_start);
    checkT("cold-start blended === agreement-only EXACTLY (zero regression)", cold.blended === 0.9);

    const zero = blendReputation({ rate: 0.9, resolved: 20 }, bucket(0, 0), CFG);
    checkT("n=0: cold-start, blended = agreement", zero.cold_start && zero.blended === 0.9);

    const atMin = blendReputation({ rate: 0.9, resolved: 20 }, bucket(5, 4), CFG);
    checkT("n=min_sample: λ = lambda_max/2 = 0.25", atMin.lambda === 0.25 && !atMin.cold_start);
    checkT("blend math: 0.75·0.9 + 0.25·0.8 = 0.875", atMin.blended === 0.875);

    const atCap = blendReputation({ rate: 0.9, resolved: 20 }, bucket(10, 8), CFG);
    checkT("n=2×min_sample: λ caps at lambda_max=0.5", atCap.lambda === 0.5);
    const beyond = blendReputation({ rate: 0.9, resolved: 20 }, bucket(40, 32), CFG);
    checkT("λ never exceeds lambda_max", beyond.lambda === 0.5);

    const noAgreement = blendReputation({ rate: null, resolved: 0 }, bucket(10, 8), CFG);
    checkT("no agreement baseline → blended null (nothing to blend into)", noAgreement.blended === null);

    const nullRate = blendReputation({ rate: 0.9, resolved: 20 }, { ...bucket(10, 8), survival_rate: null }, CFG);
    checkT("survival_rate null guard → agreement-only", nullRate.blended === 0.9);
  }

  section("8b. held-out feedback evaluation (improvement + no-suppression gate)");
  {
    const entry = (ticket: string, operator: "approved" | "rejected"): LedgerEntry => ({
      verdict: {
        verdict_id: `v-${ticket}`,
        execution_id: `e-${ticket}`,
        ticket_id: ticket,
        identifier: ticket,
        tier: "low",
        score: 0.1,
        reasons: [],
        inputs: {
          archetype: "docs",
          target_repo: "example/repo",
          repro: "fixture",
          acceptance_criteria: "fixture",
          gate_decision: "DIRECT",
          files_touched_estimate: 1,
          schema_contact: false,
          secret_contact: false,
          infra_contact: false,
          reversibility: "easy",
          seed_eval_score: null,
        },
        classified_at: "2026-07-01T00:00:00Z",
        mode: "shadow",
        acted: false,
      },
      operator_verdict: operator,
      harvested_at: "2026-07-02T00:00:00Z",
      harvest_source: "pr",
      agreement: operator === "approved",
      flags: { SF002_CLASSIFY: true, SF002_ENFORCE: false, SF002_AUTO_PROMOTE: false },
      appended_at: "2026-07-02T00:00:00Z",
    });
    const entries = new Map<string, LedgerEntry>();
    for (let i = 0; i < 8; i++) entries.set(`v-T${i}`, entry(`T${i}`, "approved"));
    entries.set("v-H1", entry("H1", "rejected"));
    const mature = [
      rec("501", "survived", "docs"),
      rec("502", "survived", "docs"),
      rec("503", "hotfixed", "docs"),
      rec("504", "hotfixed", "docs"),
      rec("505", "hotfixed", "docs"),
    ];
    const improved = evaluateSurvivabilityFeedback(entries, mature, CFG, {
      minHoldout: 1,
      holdoutSelector: (ticket) => ticket.startsWith("H"),
    });
    checkT("held-out promotion requires fewer errors, a changed decision, and zero valid suppression",
      improved.promotion_eligible && improved.baseline_errors === 1 && improved.candidate_errors === 0 &&
      improved.changed_decisions === 1 && improved.valid_work_suppressed === 0);

    entries.set("v-H1", entry("H1", "approved"));
    const suppressed = evaluateSurvivabilityFeedback(entries, mature, CFG, {
      minHoldout: 1,
      holdoutSelector: (ticket) => ticket.startsWith("H"),
    });
    checkT("operator-approved work suppression blocks promotion",
      !suppressed.promotion_eligible && suppressed.valid_work_suppressed === 1);

    const thin = evaluateSurvivabilityFeedback(entries, mature.slice(0, 4), CFG, {
      minHoldout: 1,
      holdoutSelector: (ticket) => ticket.startsWith("H"),
    });
    checkT("below-minimum 14-day fate sample is insufficient_data and stays advisory",
      thin.status === "insufficient_data" && !thin.promotion_eligible);
  }

  // ─── 9. verdict sidecar (consensus_dissent additive) ─────────────────────────
  section("9. verdict sidecar (absent dissent ⇒ byte-parity)");
  {
    const base = { ticket: "SF-012", execution_id: null, verdict: "pass", rework: false, evidence: "selftest", decided_at: "2026-07-02T00:00:00Z" };
    const noDissent = parseVerdict(base);
    checkT("verdict without dissent parses ok", noDissent.ok);
    checkT("absent dissent NEVER serializes (pre-SF-012 byte-parity)",
      noDissent.ok && !JSON.stringify(noDissent.verdict).includes("consensus_dissent"));
    const nullDissent = parseVerdict({ ...base, consensus_dissent: null });
    checkT("null dissent treated as absent", nullDissent.ok && !JSON.stringify(nullDissent.verdict).includes("consensus_dissent"));
    const withDissent = parseVerdict({ ...base, consensus_dissent: "  panel flagged X  " });
    checkT("present dissent kept + trimmed",
      withDissent.ok && withDissent.verdict.consensus_dissent === "panel flagged X");
    checkT("empty-string dissent rejected", !parseVerdict({ ...base, consensus_dissent: "" }).ok);
    checkT("non-string dissent rejected", !parseVerdict({ ...base, consensus_dissent: 42 }).ok);

    const vDir = join(sandbox, "evals");
    if (noDissent.ok) {
      const p1 = writeVerdict("sf012-selftest", noDissent.verdict, { dir: vDir });
      checkT("written sidecar file carries no dissent key", !readFileSync(p1, "utf-8").includes("consensus_dissent"));
      checkT("writer refuses to clobber without force",
        throws(() => writeVerdict("sf012-selftest", noDissent.verdict, { dir: vDir })));
    } else {
      checkT("written sidecar file carries no dissent key", false, "parse failed");
      checkT("writer refuses to clobber without force", false, "parse failed");
    }
  }

  // ─── 10. sf012Snapshot ───────────────────────────────────────────────────────
  section("10. sf012Snapshot (never throws, counted degradation)");
  {
    const snapEnv = (over: Record<string, string>, fn: () => void) => {
      const saved: Record<string, string | undefined> = {};
      for (const k of Object.keys(over)) {
        saved[k] = process.env[k];
        process.env[k] = over[k];
      }
      try {
        fn();
      } finally {
        for (const k of Object.keys(over)) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
      }
    };

    const fatePath = join(sandbox, "snap-fates.jsonl");
    writeFileSync(fatePath, JSON.stringify(rec("42", "survived")) + "\n{torn\n");
    const sigPath = join(sandbox, "snap-signals.jsonl");
    writeFileSync(sigPath, JSON.stringify({ source: "gate_failure", source_key: "k", ticket_id: null, archetype: null, detail: "d", ts: "t" }) + "\n{torn\n");

    snapEnv({ SF012_CONFIG_PATH: join(sandbox, "absent.json"), SF012_LEDGER_PATH: fatePath, SF012_SIGNALS_PATH: sigPath }, () => {
      const snap = sf012Snapshot();
      checkT("counts fates + torn lines from env-redirected ledger",
        snap.distinct_prs === 1 && snap.fate_torn_lines === 1 && snap.by_fate.survived === 1);
      checkT("global_sufficient honest at n=1 < min_sample", !snap.global_sufficient);
      checkT("signals counted by source + torn", snap.signals_total === 1 && snap.signals_by_source.gate_failure === 1 && snap.signal_torn_lines === 1);
      checkT("absent config surfaces as defaults + hash", snap.config_source === "defaults" && snap.config_hash !== null);
      checkT("flags reflected (off in this test env)", !snap.flag_survival || process.env.SF012_SURVIVAL === "1");
    });

    snapEnv({ SF012_CONFIG_PATH: join(sandbox, "torn-config.json"), SF012_LEDGER_PATH: fatePath, SF012_SIGNALS_PATH: sigPath }, () => {
      const snap = sf012Snapshot();
      checkT("corrupt config degrades to counted error, snapshot survives",
        snap.config_source === "invalid" && snap.config_error !== null);
      checkT("signals still gathered despite config failure", snap.signals_total === 1);
    });

    snapEnv({ SF012_CONFIG_PATH: join(sandbox, "absent.json"), SF012_LEDGER_PATH: join(sandbox, "none.jsonl"), SF012_SIGNALS_PATH: join(sandbox, "none2.jsonl") }, () => {
      const snap = sf012Snapshot();
      checkT("all-absent → zero counts, no throw", snap.distinct_prs === 0 && snap.signals_total === 0 && !snap.global_sufficient);
    });
  }

  // ─── 11. never-writes + wiring guards ────────────────────────────────────────
  section("11. never-writes + wiring guards (source checks)");
  {
    const coreSrc = readFileSync(join(SCRIPT_DIR, "survivability-core.ts"), "utf-8");
    checkT("survivability-core.ts contains NO fs write calls (blend can never write)",
      !/writeFileSync|appendFileSync|mkdirSync|renameSync|unlinkSync/.test(coreSrc));
    checkT("core touches approval-ledger only via dynamic import in the CLI blend path",
      coreSrc.includes('await import("./approval-ledger")') && !/^import[^;]*from "\.\/approval-ledger"/m.test(coreSrc));

    const probeSrc = readFileSync(join(SCRIPT_DIR, "survivability-probe.ts"), "utf-8");
    checkT("probe writes ONLY via the single superseding append",
      (probeSrc.match(/appendFileSync\(/g) ?? []).length === 1 && !probeSrc.includes("writeFileSync"));
    checkT("probe CLI gates the flag BEFORE any read/write",
      probeSrc.includes("if (!sf012Flags().survival) process.exit(0);") &&
        probeSrc.indexOf("if (!sf012Flags().survival) process.exit(0);") < probeSrc.indexOf("await harvestFates()"));
    checkT("probe spawns never pipe stderr (unread pipe = deadlock hazard; cg-1783030832568)",
      !probeSrc.includes('stderr: "pipe"'));

    const signalsSrc = readFileSync(join(SCRIPT_DIR, "decision-signals.ts"), "utf-8");
    checkT("signals module writes ONLY via the single harvest append",
      (signalsSrc.match(/appendFileSync\(/g) ?? []).length === 1 && !signalsSrc.includes("writeFileSync"));
    checkT("signals CLI gates the flag BEFORE any read/write",
      signalsSrc.includes("if (!sf012Flags().survival) process.exit(0);"));

    const metricsSrc = readFileSync(join(SCRIPT_DIR, "factory-metrics.ts"), "utf-8");
    checkT("trailing-quality section gated on SF012_SURVIVAL", metricsSrc.includes("if (sf012Flags().survival)"));
    checkT("trailing quality labeled distinct from first-pass yield", metricsSrc.includes("distinct from first-pass yield"));

    const shadowSrc = readFileSync(join(SCRIPT_DIR, "shadow-validate.ts"), "utf-8");
    checkT("shadow-validate embeds sf012Snapshot at both report sites",
      (shadowSrc.match(/sf012: sf012Snapshot\(\),/g) ?? []).length === 2);

    const collectSrc = readFileSync(join(SCRIPT_DIR, "factory-collect.ts"), "utf-8");
    checkT("factory-collect copies only verdict/rework — dissent never enters canonical() (zero supersede churn)",
      !collectSrc.includes("consensus_dissent"));

    // The executor now carries canonical lifecycle survivability fields, but
    // remains free of SF-012 feature-specific wiring.
    const swarmExecSrc = readFileSync(join(SCRIPT_DIR, "swarm-exec.ts"), "utf-8");
    checkT("swarm-exec.ts remains free of SF-012 feature coupling", !/sf012/i.test(swarmExecSrc));

    // Other frozen modules stay byte-free of SF-012 and survivability changes.
    for (const frozen of ["approval-ledger.ts", "auto-merge-lane.ts", "archetype-classifier.ts"]) {
      const src = readFileSync(join(SCRIPT_DIR, frozen), "utf-8");
      checkT(`${frozen} untouched by SF-012 (no sf012 references)`, !/sf012|SF012|survivability/i.test(src));
    }
  }

  // ─── 12. flags-off identity (subprocess) ─────────────────────────────────────
  section("12. flags-off identity (silent exit-0, zero files created)");
  {
    const offDir = join(sandbox, "off");
    mkdirSync(offDir, { recursive: true });
    const env = {
      ...process.env,
      SF012_LEDGER_PATH: join(offDir, "fates.jsonl"),
      SF012_SIGNALS_PATH: join(offDir, "signals.jsonl"),
      SF012_CONFIG_PATH: join(offDir, "config.json"),
    } as Record<string, string | undefined>;
    delete env.SF012_SURVIVAL;
    delete env.SF012_FEEDBACK;

    const run = (script: string, ...args: string[]) =>
      spawnSync("bun", [join(SCRIPT_DIR, script), ...args], { encoding: "utf-8", env: env as NodeJS.ProcessEnv });

    const results = [
      ["survivability-core.ts show", run("survivability-core.ts", "show")],
      ["survivability-core.ts blend", run("survivability-core.ts", "blend")],
      ["survivability-probe.ts harvest", run("survivability-probe.ts", "harvest")],
      ["survivability-feedback-eval.ts", run("survivability-feedback-eval.ts")],
      ["decision-signals.ts harvest", run("decision-signals.ts", "harvest")],
      ["decision-signals.ts show", run("decision-signals.ts", "show")],
    ] as const;
    for (const [name, r] of results) {
      checkT(`${name}: flag off → exit 0, ZERO output`, r.status === 0 && r.stdout === "" && r.stderr === "");
    }
    checkT("no sf012 files created with flags off",
      !existsSync(join(offDir, "fates.jsonl")) && !existsSync(join(offDir, "signals.jsonl")));

    // factory-metrics: off-run carries no trailing section; on-run (sandboxed empty ledger) renders it honestly
    const mOff = run("factory-metrics.ts", "report");
    checkT("factory-metrics off: exit 0, no trailing-quality section, no [sf012]",
      mOff.status === 0 && !mOff.stdout.includes("Trailing quality") && !`${mOff.stdout}${mOff.stderr}`.includes("sf012"));
    const mOff2 = run("factory-metrics.ts", "report");
    const norm = (s: string) => s.replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z?/g, "T");
    checkT("factory-metrics off-runs byte-identical (modulo timestamps)", norm(mOff.stdout) === norm(mOff2.stdout));

    const envOn = { ...env, SF012_SURVIVAL: "1" } as NodeJS.ProcessEnv;
    const mOn = spawnSync("bun", [join(SCRIPT_DIR, "factory-metrics.ts"), "report"], { encoding: "utf-8", env: envOn });
    checkT("factory-metrics on: trailing section renders with honest empty state",
      mOn.status === 0 && mOn.stdout.includes("Trailing quality") && mOn.stdout.includes("No merged agent PRs probed yet"));
    checkT("on-output = off-output + trailing section ONLY", norm(mOn.stdout).startsWith(norm(mOff.stdout).trimEnd()));

    // flag-on CLI honest-empty (sandboxed, no gh/git needed — core show reads ledger only)
    const showOn = spawnSync("bun", [join(SCRIPT_DIR, "survivability-core.ts"), "show"], { encoding: "utf-8", env: envOn });
    checkT("core show on: honest n=0 empty state, defaults config",
      showOn.status === 0 && showOn.stdout.includes("no merged agent PRs probed yet") && showOn.stdout.includes("source=defaults"));

    const sigDir = join(sandbox, "sig-on");
    mkdirSync(join(sigDir, "state"), { recursive: true });
    writeFileSync(join(sigDir, "state", "exec-bbbb0001.json"),
      JSON.stringify({ execution_id: "bbbb0001", ticket_id: "ZOU-77", identifier: "ZOU-77", started_at: "2026-07-01T00:00:00Z", archetype: { line: "docs", source: "declared", fine: null, disagreement: true } }));
    const envSig = {
      ...envOn,
      SF012_EXEC_STATE_DIR: join(sigDir, "state"),
      SF012_QUEUE_PATH: join(sigDir, "queue.jsonl"),
      SF012_SIGNALS_PATH: join(sigDir, "signals.jsonl"),
      SF012_APPROVAL_LEDGER_PATH: join(sigDir, "approval-ledger.jsonl"),
    } as NodeJS.ProcessEnv;
    const sigOn = spawnSync("bun", [join(SCRIPT_DIR, "decision-signals.ts"), "harvest"], { encoding: "utf-8", env: envSig });
    checkT("signals harvest on: derives the classifier disagreement from sandboxed exec state",
      sigOn.status === 0 && sigOn.stdout.includes("appended=1") && existsSync(join(sigDir, "signals.jsonl")));
    const sigOn2 = spawnSync("bun", [join(SCRIPT_DIR, "decision-signals.ts"), "harvest"], { encoding: "utf-8", env: envSig });
    checkT("subprocess re-harvest idempotent (duplicates=1, appended=0)",
      sigOn2.status === 0 && sigOn2.stdout.includes("appended=0") && sigOn2.stdout.includes("duplicates=1"));

    // blend (SF012_FEEDBACK) is advisory + read-only over the REAL approval ledger
    const approvalPath = join(SCRIPT_DIR, "..", "state", "approval-ledger.jsonl");
    const approvalBefore = existsSync(approvalPath) ? readFileSync(approvalPath, "utf-8") : null;
    const blendOn = spawnSync("bun", [join(SCRIPT_DIR, "survivability-core.ts"), "blend"], {
      encoding: "utf-8",
      env: { ...env, SF012_FEEDBACK: "1" } as NodeJS.ProcessEnv,
    });
    const approvalAfter = existsSync(approvalPath) ? readFileSync(approvalPath, "utf-8") : null;
    checkT("blend on: advisory log renders, exit 0",
      blendOn.status === 0 && blendOn.stdout.includes("[sf012] reputation blend (advisory)"));
    checkT("blend NEVER mutates the approval ledger (byte compare)", approvalBefore === approvalAfter);
  }
} finally {
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\n${"─".repeat(60)}`);
if (failed === 0) {
  console.log(`✓ All ${passed} checks passed`);
  process.exit(0);
} else {
  console.log(`✗ ${failed} of ${passed + failed} checks failed`);
  process.exit(1);
}
