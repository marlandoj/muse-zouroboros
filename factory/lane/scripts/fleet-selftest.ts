#!/usr/bin/env bun
/**
 * SF-008 T5 — Fleet selftest (sandboxed).
 *
 * Everything runs against a mkdtemp sandbox via SF003_POOL_STATE_DIR +
 * SF008_PARKS_PATH + SF008_AUDIT_PATH with injected RepoProbe/GateScorer —
 * no real pool state, no real gate spawns, no network.
 *
 * Sections: spec fail-loud · slug · park taxonomy · compile+idempotency ·
 * scorer-failure=unscored · retry-parked re-entry · dry-writes-nothing ·
 * rollup math · snapshot never-throws · flags-off zero-files CLI identity ·
 * pool-modules-untouched guard · consensus regression locks (§12: planFleet
 * one-bucket invariant, injected-assignments N+1 fix, rendered honesty caveat,
 * execFileSync no-shell gate spawn).
 *
 * Run: bun fleet-selftest.ts   (exit 0 = all green)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendPark,
  type FleetPark,
  materializeContract,
  parseFleetSpec,
  planFleet,
  PR_ONLY_CONSTRAINT,
  readJsonlTolerant,
  type RepoProbe,
  repoSlug,
} from "./fleet-spec.ts";
import { compileFleet, fleetCampaignId, type GateScorer, realGateScorer } from "./fleet-campaign.ts";
import { PR_CLAIM_PATTERN, readFleetResults, renderRollupTable, ROLLUP_CAVEAT, rollupFleet, sf008Snapshot, type TaskResult } from "./fleet-status.ts";
import { type Campaign, loadCampaigns, loadQueue, markItem, type WorkItem } from "./pool-queue.ts";
import type { Assignment } from "./pool-worker.ts";

// ─── Harness ──────────────────────────────────────────────────────────────────

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = ""): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
function throws(fn: () => unknown): boolean {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
}

const ROOT = mkdtempSync(join(tmpdir(), "fleet-selftest-"));
const SAVED = {
  pool: process.env.SF003_POOL_STATE_DIR,
  parks: process.env.SF008_PARKS_PATH,
  audit: process.env.SF008_AUDIT_PATH,
  flag: process.env.SF008_FLEET,
};
function sandbox(name: string): { pool: string; parks: string; audit: string } {
  const dir = join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  const paths = { pool: join(dir, "pool"), parks: join(dir, "parks.jsonl"), audit: join(dir, "audit.jsonl") };
  process.env.SF003_POOL_STATE_DIR = paths.pool;
  process.env.SF008_PARKS_PATH = paths.parks;
  process.env.SF008_AUDIT_PATH = paths.audit;
  return paths;
}

const GOOD_TEMPLATE = [
  "## Acceptance Criteria",
  "- Report exists in {repo} at {repo_path}/OUT.md",
  "## Target Repo",
  "{repo_path}",
  "## Archetype",
  "audit",
  "## Repro",
  "ls {repo_path}",
].join("\n");

function specOf(fleetId: string, repos: string[], template = GOOD_TEMPLATE) {
  return {
    fleet_id: fleetId,
    intent: "Audit repository hygiene across the estate",
    target_repos: repos,
    contract_template: template,
    cost_ceiling_usd: 3,
  };
}

/** Probe backed by a mutable map — flip validity mid-test for retry-parked. */
function mapProbe(map: Record<string, { exists: boolean; is_git_repo: boolean }>): RepoProbe {
  return (p) => map[p] ?? { exists: false, is_git_repo: false };
}
const okScorer: GateScorer = () => ({ decision: "SWARM", score: 0.5 });
const boomScorer: GateScorer = () => {
  throw new Error("scorer exploded");
};
const T0 = "2026-07-02T00:00:00.000Z";
const deps = (probe: RepoProbe, scorer: GateScorer, over: Partial<{ dry: boolean; retryParked: boolean }> = {}) => ({
  probe,
  scorer,
  now: () => T0,
  dry: over.dry ?? false,
  retryParked: over.retryParked ?? false,
});

try {
  // ─── §1 spec parsing fail-loud ─────────────────────────────────────────────
  console.log("§1 spec parse (fail-loud)");
  const specDir = join(ROOT, "specs");
  mkdirSync(specDir, { recursive: true });
  const writeSpec = (name: string, body: string): string => {
    const p = join(specDir, name);
    writeFileSync(p, body);
    return p;
  };
  const goodYaml = [
    "fleet_id: good-fleet",
    "intent: Audit repository hygiene across the estate",
    "target_repos:",
    "  - /home/workspace/Projects/gitingest",
    "cost_ceiling_usd: 2",
    "contract_template: |",
    ...GOOD_TEMPLATE.split("\n").map((l) => `  ${l}`),
  ].join("\n");
  const goodPath = writeSpec("good.yaml", goodYaml);
  const parsed = parseFleetSpec(goodPath);
  check("valid spec parses", parsed.fleet_id === "good-fleet" && parsed.target_repos.length === 1 && parsed.cost_ceiling_usd === 2);
  check("missing file throws", throws(() => parseFleetSpec(join(specDir, "nope.yaml"))));
  check("bad fleet_id throws", throws(() => parseFleetSpec(writeSpec("badid.yaml", goodYaml.replace("good-fleet", "BAD ID!")))));
  check("short intent throws", throws(() => parseFleetSpec(writeSpec("shortintent.yaml", goodYaml.replace(/^intent:.*$/m, "intent: nope")))));
  check("empty target_repos throws", throws(() => parseFleetSpec(writeSpec("norepos.yaml", goodYaml.replace(/target_repos:[\s\S]*?cost_ceiling/, "target_repos: []\ncost_ceiling")))));
  check(
    "duplicate repos throws",
    throws(() => parseFleetSpec(writeSpec("dup.yaml", goodYaml.replace("- /home/workspace/Projects/gitingest", "- /a\n  - /a"))))
  );
  check("missing template throws", throws(() => parseFleetSpec(writeSpec("notmpl.yaml", goodYaml.split("contract_template:")[0]))));
  check("bad ceiling throws", throws(() => parseFleetSpec(writeSpec("badceil.yaml", goodYaml.replace("cost_ceiling_usd: 2", "cost_ceiling_usd: -1")))));

  // ─── §2 repo slug ──────────────────────────────────────────────────────────
  console.log("§2 repo slug");
  check("workspace root slug", repoSlug("/home/workspace") === "workspace-root");
  check("estate-relative slug", repoSlug("/home/workspace/Projects/zo-linear-agent") === "Projects-zo-linear-agent");
  check("trailing slash trimmed", repoSlug("/home/workspace/Skills/") === "Skills");
  check("outside-workspace path sanitized", repoSlug("/tmp/some repo!") === "tmp-some-repo");

  // ─── §3 park taxonomy (pure planFleet, injected probe) ────────────────────
  console.log("§3 park taxonomy");
  const taxSpec = specOf("tax", ["/r/ok", "/r/missing", "/r/notgit", "/r/boom"]);
  const taxProbe = mapProbe({
    "/r/ok": { exists: true, is_git_repo: true },
    "/r/missing": { exists: false, is_git_repo: false },
    "/r/notgit": { exists: true, is_git_repo: false },
  });
  const throwingProbe: RepoProbe = (p) => {
    if (p === "/r/boom") throw new Error("probe crashed");
    return taxProbe(p);
  };
  const taxPlan = planFleet(taxSpec, throwingProbe, T0);
  check("1 ready of 4", taxPlan.ready.length === 1 && taxPlan.ready[0].repo === "/r/ok");
  check(
    "missing repo → park_repo_invalid (path)",
    taxPlan.parks.some((p) => p.repo === "/r/missing" && p.reason === "park_repo_invalid" && p.detail === "path does not exist")
  );
  check(
    "non-git repo → park_repo_invalid (git)",
    taxPlan.parks.some((p) => p.repo === "/r/notgit" && p.reason === "park_repo_invalid" && p.detail === "not a git repository")
  );
  check("throwing probe → park not crash", taxPlan.parks.some((p) => p.repo === "/r/boom" && p.reason === "park_repo_invalid"));
  const badTmplPlan = planFleet(specOf("tax2", ["/r/ok"], "just prose, no contract sections"), taxProbe, T0);
  check(
    "bad template → park_contract_invalid listing fields",
    badTmplPlan.ready.length === 0 &&
      badTmplPlan.parks[0].reason === "park_contract_invalid" &&
      badTmplPlan.parks[0].detail.includes("acceptance_criteria") &&
      badTmplPlan.parks[0].detail.includes("target_repo")
  );
  const mat = materializeContract(taxSpec, "/r/ok", T0);
  check("materialization interpolates {repo}/{repo_path}", mat.description.includes("r-ok") && mat.description.includes("/r/ok") && !mat.description.includes("{repo"));
  check("PR-only constraint embedded in description", mat.description.includes(PR_ONLY_CONSTRAINT));

  // ─── §4 compile + idempotency ─────────────────────────────────────────────
  console.log("§4 compile + idempotency");
  const s4 = sandbox("s4");
  const spec4 = specOf("alpha", ["/r/a", "/r/b", "/r/missing"]);
  const probe4 = mapProbe({
    "/r/a": { exists: true, is_git_repo: true },
    "/r/b": { exists: true, is_git_repo: true },
  });
  const out1 = compileFleet(spec4, "spec4.yaml", deps(probe4, okScorer));
  check("first compile enqueues 2, parks 1", out1.enqueued.length === 2 && out1.parks.length === 1 && !out1.already_existed);
  const camp4 = loadCampaigns()[fleetCampaignId(spec4)];
  check("ONE campaign, task_id = repo slug, dep-free", camp4 !== undefined && camp4.tasks.join(",") === "r-a,r-b" && loadQueue().every((i) => i.deps.length === 0));
  check("campaign ceiling from spec", camp4.cost_ceiling_usd === 3);
  check(
    "item description = contract + PR-only constraint",
    loadQueue().every((i) => i.description.includes(PR_ONLY_CONSTRAINT) && i.description.includes("## Acceptance Criteria"))
  );
  check("park row on disk with reason", readJsonlTolerant<FleetPark>(s4.parks).rows.length === 1 && readJsonlTolerant<FleetPark>(s4.parks).rows[0].reason === "park_repo_invalid");
  const audits1 = readJsonlTolerant<Record<string, unknown>>(s4.audit).rows;
  check("2 audit rows with gate stamp", audits1.length === 2 && audits1.every((a) => a.gate_decision === "SWARM" && a.gate_score === 0.5 && a.contract_ok === true));

  const out2 = compileFleet(spec4, "spec4.yaml", deps(probe4, okScorer));
  check("re-compile: 0 dupes, 0 new ledger rows", out2.already_existed && out2.enqueued.length === 0 && loadQueue().length === 2 && readJsonlTolerant(s4.parks).rows.length === 1 && readJsonlTolerant(s4.audit).rows.length === 2);

  // ─── §5 scorer failure ⇒ unscored, never blocks ───────────────────────────
  console.log("§5 scorer failure");
  const s5 = sandbox("s5");
  const out5 = compileFleet(specOf("beta", ["/r/a"]), "spec5.yaml", deps(probe4, boomScorer));
  check("throwing scorer: compile still enqueues", out5.enqueued.length === 1);
  const audits5 = readJsonlTolerant<Record<string, unknown>>(s5.audit).rows;
  check("audit stamped unscored, score null", audits5.length === 1 && audits5[0].gate_decision === "unscored" && audits5[0].gate_score === null);

  // ─── §6 retry-parked re-entry ─────────────────────────────────────────────
  console.log("§6 retry-parked");
  const s6 = sandbox("s6");
  const probeMap6: Record<string, { exists: boolean; is_git_repo: boolean }> = {
    "/r/a": { exists: true, is_git_repo: true },
    "/r/fix": { exists: false, is_git_repo: false },
  };
  const spec6 = specOf("gamma", ["/r/a", "/r/fix", "/r/never"]);
  compileFleet(spec6, "spec6.yaml", deps(mapProbe(probeMap6), okScorer));
  markItem(fleetCampaignId(spec6), "r-a", "done");
  const noRetry = compileFleet(spec6, "spec6.yaml", deps(mapProbe(probeMap6), okScorer));
  check("without --retry-parked: parked repos stay out", noRetry.already_existed && noRetry.enqueued.length === 0 && loadQueue().length === 1);
  probeMap6["/r/fix"] = { exists: true, is_git_repo: true }; // repo fixed
  const retry = compileFleet(spec6, "spec6.yaml", deps(mapProbe(probeMap6), okScorer, { retryParked: true }));
  check("retry re-enters ONLY the fixed repo", retry.enqueued.join(",") === "r-fix");
  // ledger: 2 rows from first compile (/r/fix, /r/never) + 1 fresh re-park = 3
  check("still-invalid repo re-parks (fresh row)", retry.parks.length === 1 && retry.parks[0].repo === "/r/never" && readJsonlTolerant(s6.parks).rows.length === 3);
  const q6 = loadQueue();
  check("done item untouched, new item ready", q6.find((i) => i.task_id === "r-a")!.state === "done" && q6.find((i) => i.task_id === "r-fix")!.state === "ready");
  check("campaign.tasks grew to include re-entry", loadCampaigns()[fleetCampaignId(spec6)].tasks.join(",") === "r-a,r-fix");
  const specGrown = specOf("gamma", ["/r/a", "/r/fix", "/r/never", "/r/new-repo"]);
  const grown = compileFleet(specGrown, "spec6.yaml", deps(mapProbe(probeMap6), okScorer, { retryParked: true }));
  check("spec-added repo without park row: warned, not enqueued", grown.enqueued.length === 0 && grown.warnings.some((w) => w.includes("/r/new-repo")));

  // ─── §7 dry writes nothing ────────────────────────────────────────────────
  console.log("§7 dry mode");
  const s7 = sandbox("s7");
  const dryOut = compileFleet(specOf("delta", ["/r/a", "/r/missing"]), "spec7.yaml", deps(probe4, okScorer, { dry: true }));
  check("dry reports plan (1 ready, 1 park)", dryOut.enqueued.length === 1 && dryOut.parks.length === 1 && dryOut.dry);
  check("dry writes NOTHING", !existsSync(s7.pool) && !existsSync(s7.parks) && !existsSync(s7.audit));

  // ─── §8 rollup math (pure) ────────────────────────────────────────────────
  console.log("§8 rollup math");
  const mkItem = (task: string, state: WorkItem["state"]): WorkItem => ({
    campaign_id: "fleet-roll",
    task_id: task,
    name: task,
    description: "d",
    deps: [],
    state,
    attempts: 1,
    park_reason: state === "parked" ? "ceiling" : null,
    created_at: T0,
    updated_at: T0,
  });
  const rollCampaigns: Record<string, Campaign> = {
    "fleet-roll": {
      campaign_id: "fleet-roll",
      ticket_id: "roll",
      identifier: "FLEET-roll",
      seed_path: null,
      tasks: ["r-a", "r-b", "r-c", "r-d"],
      cost_ceiling_usd: 5,
      cost_spent_usd: 1,
      state: "active",
      created_at: T0,
    },
  };
  const rollQueue = [mkItem("r-a", "done"), mkItem("r-b", "in-flight"), mkItem("r-c", "failed"), mkItem("r-d", "parked")];
  const rollResults: TaskResult[] = [
    { task_id: "r-a", outcome: "success", summary: "Opened pull request #12 with the fix." },
    { task_id: "r-c", outcome: "failure", summary: "Could not finish; no PR." },
    { task_id: "r-zz", outcome: "success", summary: "pull request #9 for a task not in this fleet" },
  ];
  const rollParks: FleetPark[] = [
    { fleet_id: "roll", repo: "/r/parked1", reason: "park_repo_invalid", detail: "path does not exist", ts: T0 },
    { fleet_id: "roll", repo: "/r/parked1", reason: "park_repo_invalid", detail: "path does not exist", ts: T0 }, // re-attempt row
    { fleet_id: "roll", repo: "/home/workspace/Projects/gitingest", reason: "park_contract_invalid", detail: "x", ts: T0 },
    { fleet_id: "other", repo: "/r/other", reason: "park_repo_invalid", detail: "x", ts: T0 },
  ];
  // gitingest parked once but later re-entered: give it an enqueued item
  rollQueue.push(mkItem("Projects-gitingest", "done"));
  rollCampaigns["fleet-roll"].tasks.push("Projects-gitingest");
  const roll = rollupFleet("roll", rollCampaigns, rollQueue, rollResults, rollParks);
  check("repos_total = enqueued + still-parked", roll.repos_total === 6 && roll.enqueued === 5 && roll.parked_compile === 1);
  check("state counts exact", roll.in_flight === 1 && roll.done === 2 && roll.failed === 1 && roll.parked_pool === 1);
  check("PR claims: only in-fleet matching summaries", roll.prs_opened === 1);
  check("passed = pool-harvested done", roll.passed_postflight === 2);
  check("parks_by_reason cumulative (rows not repos)", roll.parks_by_reason.park_repo_invalid === 2 && roll.parks_by_reason.park_contract_invalid === 1);
  check("other fleet's parks excluded", !JSON.stringify(roll).includes("/r/other"));
  check("PR pattern: negatives stay negative", !PR_CLAIM_PATTERN.test("respect the PR-only constraint") && !PR_CLAIM_PATTERN.test("all tests pass"));
  check("PR pattern: positives", PR_CLAIM_PATTERN.test("delivered a patch artifact at /tmp/x.patch") && PR_CLAIM_PATTERN.test("see https://github.com/x/y/pull/44"));
  const rollNoCampaign = rollupFleet("ghost", {}, [], [], [{ fleet_id: "ghost", repo: "/r/g", reason: "park_repo_invalid", detail: "x", ts: T0 }]);
  check("fleet with zero-ready compile: parked-only rollup", rollNoCampaign.repos_total === 1 && rollNoCampaign.enqueued === 0 && rollNoCampaign.campaign_id.includes("not compiled"));

  // ─── §9 snapshot never throws ─────────────────────────────────────────────
  console.log("§9 sf008Snapshot (corrupt-tolerant)");
  const s9 = sandbox("s9");
  mkdirSync(s9.pool, { recursive: true });
  writeFileSync(join(s9.pool, "campaigns.json"), "{{{ not json");
  writeFileSync(s9.parks, `${JSON.stringify({ fleet_id: "x", repo: "/r", reason: "park_repo_invalid", detail: "d", ts: T0 })}\n{torn`);
  appendFileSync(s9.audit, "also torn\n");
  const snap = sf008Snapshot();
  check("corrupt campaigns.json → INVALID note, no throw", snap.invalid.some((i) => i.includes("campaigns.json")));
  check("torn ledger lines counted", snap.torn_park_lines === 1 && snap.torn_audit_lines === 1 && snap.park_rows === 1);
  const s9b = sandbox("s9b");
  appendPark({ fleet_id: "solo", repo: "/r/solo", reason: "park_repo_invalid", detail: "d", ts: T0 }, s9b.parks);
  const snapB = sf008Snapshot();
  check("park-only fleet discovered in snapshot", snapB.fleets.length === 1 && snapB.fleets[0].fleet_id === "solo" && snapB.invalid.length === 0);

  // ─── §10 flags-off zero-files CLI identity ────────────────────────────────
  console.log("§10 flags-off CLI identity");
  const s10 = join(ROOT, "s10");
  mkdirSync(s10, { recursive: true });
  const offEnv = {
    ...process.env,
    SF003_POOL_STATE_DIR: join(s10, "pool"),
    SF008_PARKS_PATH: join(s10, "parks.jsonl"),
    SF008_AUDIT_PATH: join(s10, "audit.jsonl"),
  } as Record<string, string>;
  delete offEnv.SF008_FLEET;
  const clis = [
    `bun ${join(import.meta.dir, "fleet-spec.ts")} validate --spec ${goodPath}`,
    `bun ${join(import.meta.dir, "fleet-campaign.ts")} compile --spec ${goodPath}`,
    `bun ${join(import.meta.dir, "fleet-status.ts")}`,
  ];
  let offOk = true;
  for (const cmd of clis) {
    const out = execSync(cmd, { encoding: "utf-8", env: offEnv });
    if (out.trim() !== "") offOk = false;
    const outZero = execSync(cmd, { encoding: "utf-8", env: { ...offEnv, SF008_FLEET: "0" } });
    if (outZero.trim() !== "") offOk = false;
  }
  check("all 3 CLIs exit 0 silently with flag unset AND =0", offOk);
  check("flags-off created zero files", readdirSync(s10).length === 0);

  // ─── §11 pool modules byte-untouched ──────────────────────────────────────
  console.log("§11 pool modules untouched");
  const poolDiff = execSync(
    "git status --porcelain -- scripts/pool-queue.ts scripts/pool-manager.ts scripts/pool-worker.ts",
    { encoding: "utf-8", cwd: join(import.meta.dir, "..") }
  ).trim();
  check("pool-queue/manager/worker have no working-tree changes", poolDiff === "", poolDiff);

  // ─── §12 consensus regression locks (cg-1783009452481, cg-1783009752895) ──
  console.log("§12 consensus regression locks");
  // Lock the invariant the retry path's rePlan.ready[0] depends on: planFleet
  // places EVERY repo in exactly one bucket (ready xor parks), so a single-repo
  // plan with parks.length === 0 always has ready[0].
  const oneBucket = (repo: string, probe: RepoProbe, tmpl = GOOD_TEMPLATE): boolean => {
    const p = planFleet(specOf("inv", [repo], tmpl), probe, T0);
    return p.ready.length + p.parks.length === 1;
  };
  check(
    "planFleet invariant: single repo → exactly one bucket (valid/missing/throwing)",
    oneBucket("/r/a", probe4) && oneBucket("/r/missing", probe4) && oneBucket("/r/boom", throwingProbe)
  );
  check("planFleet invariant holds for contract-invalid too", oneBucket("/r/a", probe4, "prose, no sections"));
  // N+1 fix: readFleetResults consumes the injected assignments (no dir rescan per fleet).
  const s12 = join(ROOT, "s12");
  mkdirSync(s12, { recursive: true });
  const resPath = join(s12, "res.json");
  writeFileSync(resPath, JSON.stringify({ assignment_id: "a1", outcome: "success", summary: "opened a PR", completed_at: T0 }));
  const injAssign: Assignment = {
    assignment_id: "a1",
    campaign_id: "fleet-inj",
    task_id: "r-a",
    model: "m",
    attempt: 1,
    started_at: T0,
    heartbeat_path: join(s12, "hb"),
    result_path: resPath,
    timeout_min: 5,
    completed_at: T0,
    outcome: null,
    mock: true,
  };
  const injResults = readFleetResults("fleet-inj", [injAssign]);
  check("readFleetResults uses injected assignments", injResults.length === 1 && injResults[0].summary === "opened a PR");
  check("injected assignments filtered by campaign", readFleetResults("fleet-other", [injAssign]).length === 0);
  // Rendered rollup carries the honesty caveat (passed === done in v1; PR claims unverified).
  check(
    "rollup table renders honesty caveat",
    renderRollupTable([roll]).includes(ROLLUP_CAVEAT) && ROLLUP_CAVEAT.includes("passed === done"),
    "caveat line missing from rendered table"
  );
  // realGateScorer spawns via execFileSync arg array — hostile summaries are inert text.
  const pwn = join(s12, "pwned");
  const hostile = `'; touch ${pwn}; echo '$(touch ${pwn})\`touch ${pwn}\``;
  const hostileScore = realGateScorer(hostile);
  check("realGateScorer: hostile summary returns a GateScore", typeof hostileScore.decision === "string" && hostileScore.decision.length > 0);
  check("realGateScorer: no shell — injection side-effect absent", !existsSync(pwn));
} finally {
  rmSync(ROOT, { recursive: true, force: true });
  for (const [k, v] of [
    ["SF003_POOL_STATE_DIR", SAVED.pool],
    ["SF008_PARKS_PATH", SAVED.parks],
    ["SF008_AUDIT_PATH", SAVED.audit],
    ["SF008_FLEET", SAVED.flag],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

console.log(`\n[fleet-selftest] ${pass}/${pass + fail} pass`);
process.exit(fail === 0 ? 0 : 1);
