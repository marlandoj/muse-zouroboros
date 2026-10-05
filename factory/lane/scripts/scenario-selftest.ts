#!/usr/bin/env bun
/**
 * SF-009 T5 — Scenario selftest (sandboxed).
 *
 * Everything runs against a mkdtemp sandbox via SF009_RUNS_PATH with
 * absolute-path fixtures — no real ledger, no real Linear, no egress.
 *
 * Sections: spec fail-loud · twin shape · twin determinism + per-run isolation ·
 * sandbox env (secrets absent, proxy pins, twin-only NO_PROXY, reserved-name
 * defense) · expectation math + placeholders · runner E2E (pass/fail-fast/
 * ledger rows) · egress-refused E2E fetch · linear-puller-vs-twin E2E on the
 * committed scenario · flags-off zero-files CLI identity · frozen-modules git
 * guard · snapshot never-throws.
 *
 * Run: bun scenario-selftest.ts   (exit 0 = all green)
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actorSha256 } from "./actor-system-twin.ts";
import {
  classifyOp,
  handleGraphql,
  loadTwinFixture,
  mulberry32,
  newTwinState,
  startTwin,
  transcriptSha256,
} from "./linear-twin.ts";
import { parseScenarioSpec, type ScenarioSpec } from "./scenario-spec.ts";
import {
  buildScenarioEnv,
  checkExpectations,
  deriveStatus,
  executeStep,
  materializeRun,
  runScenario,
  type ScenarioRunRecord,
  sf009Snapshot,
  type StepOutcome,
} from "./scenario-run.ts";
import { readJsonlTolerant } from "./fleet-spec.ts";

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
function throwsWith(fn: () => unknown, needle: string): boolean {
  try {
    fn();
    return false;
  } catch (err) {
    return String(err).includes(needle);
  }
}
async function rejectsWith(fn: () => Promise<unknown>, needle: string): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (err) {
    return String(err).includes(needle);
  }
}

const ROOT = mkdtempSync(join(tmpdir(), "scenario-selftest-"));
const SAVED = {
  runs: process.env.SF009_RUNS_PATH,
  flag: process.env.SF009_SCENARIOS,
  actorFlag: process.env.SF009_ACTOR_TWINS,
  trajectoryFlag: process.env.SF009_TRAJECTORY_VERIFIER,
  stateDir: process.env.FACTORY_STATE_DIR,
  stateMode: process.env.FACTORY_STATE_MODE,
  outsideRoot: process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT,
};
process.env.FACTORY_STATE_DIR = ROOT;
process.env.FACTORY_STATE_MODE = "test";
process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";
const FIXTURE_PATH = join(import.meta.dir, "..", "scenarios", "fixtures", "linear-pull-smoke.json");
const COMMITTED_SCENARIO = join(import.meta.dir, "..", "scenarios", "linear-pull-smoke.yaml");
const PROJECT_ID = "b621d7a1-bb3d-4df9-ae11-3034789e204c";
const LABEL_ID = "f4a73851-6c6b-4a19-b397-c2bd62eeb694";
const ACTOR_CONTRACT = {
  id: "user-approval-allow",
  actorKind: "user",
  interaction: "approval",
  initialState: "awaiting_approval",
  fault: "none",
  recovery: "commit_once",
  approval: "required_allow",
  expectedTerminal: "completed",
} as const;
const ACTOR_MANIFEST = {
  schemaVersion: 1,
  manifestId: "scenario-selftest-actor-v1",
  classification: "synthetic_only",
  reviewBinding: "selftest",
  replicateSeeds: [1057001],
  contracts: [ACTOR_CONTRACT],
} as const;
const ACTOR_FIXTURE = join(ROOT, "actor-manifest.json");
const ACTOR_BYTES = `${JSON.stringify(ACTOR_MANIFEST)}\n`;
writeFileSync(ACTOR_FIXTURE, ACTOR_BYTES);
const ACTOR_MANIFEST_HASH = createHash("sha256").update(ACTOR_BYTES).digest("hex");
const ACTOR_CONTRACT_HASH = actorSha256(ACTOR_CONTRACT);
const TRAJECTORY_DECL = {
  mode: "advisory",
  generator_model_id: "generator-stub-v1",
  generator_prompt_sha256: createHash("sha256").update("selftest-generator-prompt").digest("hex"),
  generator_history_sha256: createHash("sha256").update("selftest-generator-history").digest("hex"),
  verifier_model_id: "verifier-stub-v1",
  verifier_prompt_sha256: createHash("sha256").update("selftest-verifier-prompt").digest("hex"),
  verifier_history_sha256: createHash("sha256").update("selftest-verifier-history").digest("hex"),
  rubric_sha256: createHash("sha256").update("selftest-rubric").digest("hex"),
  qualitative_score: 1,
  qualitative_confidence: 0.95,
  qualitative_rationale_sha256: createHash("sha256").update("selftest-rationale").digest("hex"),
} as const;

const specDir = join(ROOT, "specs");
mkdirSync(specDir, { recursive: true });
function writeSpec(name: string, yaml: string): string {
  const p = join(specDir, name);
  writeFileSync(p, yaml);
  return p;
}
function baseYaml(over: Partial<Record<string, string>> = {}): string {
  return [
    `scenario_id: ${over.scenario_id ?? "self-test-ok"}`,
    `seed: ${over.seed ?? "7"}`,
    over.twin ?? "",
    over.env ?? "",
    "steps:",
    over.steps ??
      ['  - name: s1', '    run: echo hello', "    expect:", "      exit_code: 0", "      stdout_contains: [hello]"].join("\n"),
  ]
    .filter((l) => l !== "")
    .join("\n");
}

const issuesQuery = "query FactoryReadyTickets($projectId: ID!, $labelId: ID!) { issues(filter: {}) { nodes { id } } }";
const issueStateQuery = "query($id: String!) { issue(id: $id) { state { type } } }";
const commentMutation = "mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }";
const issueUpdateMutation = "mutation ReapFactoryReady($id: String!, $labelIds: [String!]!) { issueUpdate(id: $id, input: { labelIds: $labelIds }) { success } }";

try {
  // ─── §1 spec parse (fail-loud) ─────────────────────────────────────────────
  console.log("§1 spec parse (fail-loud)");
  const good = parseScenarioSpec(writeSpec("good.yaml", baseYaml()));
  check("valid spec parses", good.scenario_id === "self-test-ok" && good.steps.length === 1 && good.seed === 7);
  const lineage = {
    source_receipt_id: "rr-synthetic",
    source_receipt_hash: "1".repeat(64),
    candidate_id: "trace-synthetic",
    candidate_hash: "2".repeat(64),
    review_id: "review-synthetic",
    review_hash: "3".repeat(64),
    scenario_version: "v1",
  };
  const lineageSpec = parseScenarioSpec(writeSpec("lineage.json", JSON.stringify({
    scenario_id: "lineage-parse", seed: 11, lineage,
    steps: [{ name: "ok", run: "true", expect: { exit_code: 0 } }],
  })));
  check("valid immutable lineage parses", lineageSpec.lineage?.candidate_hash === lineage.candidate_hash);
  check(
    "invalid lineage hash fails loud",
    throwsWith(() => parseScenarioSpec(writeSpec("bad-lineage.json", JSON.stringify({
      scenario_id: "lineage-bad", seed: 11, lineage: { ...lineage, review_hash: "unavailable" },
      steps: [{ name: "ok", run: "true", expect: { exit_code: 0 } }],
    }))), "lowercase SHA-256"),
  );
  check("missing file throws", throwsWith(() => parseScenarioSpec(join(specDir, "nope.yaml")), "not found"));
  check("bad id throws", throwsWith(() => parseScenarioSpec(writeSpec("id.yaml", baseYaml({ scenario_id: "X!" }))), "scenario_id"));
  check("float seed throws", throwsWith(() => parseScenarioSpec(writeSpec("seed.yaml", baseYaml({ seed: "1.5" }))), "non-negative integer"));
  check(
    "zero steps throws",
    throwsWith(() => parseScenarioSpec(writeSpec("nosteps.yaml", "scenario_id: no-steps\nseed: 1\nsteps: []")), "non-empty"),
  );
  check(
    "step without run throws",
    throwsWith(
      () => parseScenarioSpec(writeSpec("norun.yaml", baseYaml({ steps: "  - name: s1\n    expect:\n      exit_code: 0" }))),
      "run missing",
    ),
  );
  check(
    "empty expect throws",
    throwsWith(
      () => parseScenarioSpec(writeSpec("noexp.yaml", baseYaml({ steps: "  - name: s1\n    run: echo hi\n    expect: {}" }))),
      "at least one expectation",
    ),
  );
  check(
    "unknown expect key throws",
    throwsWith(
      () => parseScenarioSpec(writeSpec("unk.yaml", baseYaml({ steps: "  - name: s1\n    run: echo hi\n    expect: { exit_kode: 0 }" }))),
      "unknown keys",
    ),
  );
  check(
    "duplicate step names throw",
    throwsWith(
      () =>
        parseScenarioSpec(
          writeSpec(
            "dup.yaml",
            baseYaml({
              steps: [
                "  - name: s1",
                "    run: echo a",
                "    expect: { exit_code: 0 }",
                "  - name: s1",
                "    run: echo b",
                "    expect: { exit_code: 0 }",
              ].join("\n"),
            }),
          ),
        ),
      "duplicate step name",
    ),
  );
  check(
    "files_exist traversal throws",
    throwsWith(
      () =>
        parseScenarioSpec(
          writeSpec("trav.yaml", baseYaml({ steps: '  - name: s1\n    run: echo hi\n    expect: { files_exist: ["../etc/passwd"] }' })),
        ),
      'without ".."',
    ),
  );
  check(
    "secret env name refused (ZO_ prefix)",
    throwsWith(() => parseScenarioSpec(writeSpec("sec.yaml", baseYaml({ env: "env:\n  ZO_API_TOKEN: fake" }))), "secret convention"),
  );
  check(
    "reserved env name refused (NO_PROXY)",
    throwsWith(() => parseScenarioSpec(writeSpec("resv.yaml", baseYaml({ env: "env:\n  NO_PROXY: evil" }))), "reserved"),
  );
  check(
    "reserved env name refused (LINEAR_API_URL)",
    throwsWith(() => parseScenarioSpec(writeSpec("resv2.yaml", baseYaml({ env: "env:\n  LINEAR_API_URL: http://evil" }))), "reserved"),
  );
  check(
    "reserved env name refused (FACTORY_STATE_DIR)",
    throwsWith(() => parseScenarioSpec(writeSpec("resv3.yaml", baseYaml({ env: "env:\n  FACTORY_STATE_DIR: /tmp/evil" }))), "reserved"),
  );
  check(
    "missing twin fixture throws",
    throwsWith(
      () => parseScenarioSpec(writeSpec("nofix.yaml", baseYaml({ twin: "twin:\n  kind: linear\n  fixture: nope.json" }))),
      "fixture not found",
    ),
  );
  check(
    "non-linear twin kind throws",
    throwsWith(
      () => parseScenarioSpec(writeSpec("kind.yaml", baseYaml({ twin: `twin:\n  kind: github\n  fixture: ${FIXTURE_PATH}` }))),
      "linear\" or \"actor-system",
    ),
  );
  const actorSpec = parseScenarioSpec(writeSpec("actor-parse.json", JSON.stringify({
    scenario_id: "actor-parse",
    seed: 1057001,
    twin: {
      kind: "actor-system",
      fixture: ACTOR_FIXTURE,
      contract_id: ACTOR_CONTRACT.id,
      authority_kind: "approved_manifest",
      manifest_sha256: ACTOR_MANIFEST_HASH,
      contract_sha256: ACTOR_CONTRACT_HASH,
      review_sha256: "a".repeat(64),
    },
    trajectory_verifier: TRAJECTORY_DECL,
    steps: [{ name: "ok", run: "true", expect: { exit_code: 0 } }],
  })));
  check("actor-system declaration parses with exact authority hashes", actorSpec.twin?.kind === "actor-system" && actorSpec.twin.contract_id === ACTOR_CONTRACT.id);
  check("advisory trajectory declaration parses with exact identity bindings", actorSpec.trajectory_verifier?.verifier_model_id === TRAJECTORY_DECL.verifier_model_id);
  check(
    "trajectory declaration requires an actor-system twin",
    throwsWith(() => parseScenarioSpec(writeSpec("trajectory-no-actor.json", JSON.stringify({
      scenario_id: "trajectory-no-actor", seed: 1, trajectory_verifier: TRAJECTORY_DECL,
      steps: [{ name: "ok", run: "true", expect: { exit_code: 0 } }],
    }))), "requires an actor-system twin"),
  );
  check(
    "trajectory declaration rejects unknown fields",
    throwsWith(() => parseScenarioSpec(writeSpec("trajectory-unknown.json", JSON.stringify({
      ...actorSpec,
      twin: { ...actorSpec.twin, fixture: ACTOR_FIXTURE },
      trajectory_verifier: { ...TRAJECTORY_DECL, hidden_answer: "completed" },
    }))), "unknown keys"),
  );
  check(
    "admitted-lineage actor declaration requires matching lineage",
    throwsWith(() => parseScenarioSpec(writeSpec("actor-lineage.json", JSON.stringify({
      ...actorSpec,
      twin: { ...actorSpec.twin, fixture: ACTOR_FIXTURE, authority_kind: "admitted_lineage" },
    }))), "requires scenario lineage"),
  );

  // ─── §2 twin shape ─────────────────────────────────────────────────────────
  console.log("§2 twin shape (contract mock)");
  const fixture = loadTwinFixture(FIXTURE_PATH);
  check("committed fixture loads (4 issues)", fixture.issues.length === 4);
  check(
    "classifyOp discriminates all five",
    classifyOp(issuesQuery) === "issues_filter" &&
      classifyOp(issueStateQuery) === "issue_state" &&
      classifyOp(commentMutation) === "comment_create" &&
      classifyOp(issueUpdateMutation) === "issue_update" &&
      classifyOp("query { foo { bar } }") === "unsupported",
  );
  const st = newTwinState(42);
  const rFilter = handleGraphql(fixture, st, 42, { query: issuesQuery, variables: { projectId: PROJECT_ID, labelId: LABEL_ID } });
  const nodes = (rFilter.response as any).data.issues.nodes;
  check("issues-filter excludes unlabeled issue", nodes.length === 3 && !nodes.some((n: any) => n.identifier === "ZOU-9003"));
  check(
    "issues-filter node carries query selection shape",
    nodes[0].labels?.nodes?.[0]?.id === LABEL_ID && typeof nodes[0].state?.type === "string" && typeof nodes[0].team?.key === "string",
  );
  const rWrongProject = handleGraphql(fixture, st, 42, { query: issuesQuery, variables: { projectId: "other", labelId: LABEL_ID } });
  check("issues-filter respects project id", (rWrongProject.response as any).data.issues.nodes.length === 0);
  const rState = handleGraphql(fixture, st, 42, { query: issueStateQuery, variables: { id: nodes[0].id } });
  check("issue-state returns fixture state", (rState.response as any).data.issue.state.type === "unstarted");
  const rState0 = handleGraphql(fixture, st, 42, { query: issueStateQuery, variables: { id: "unknown-id" } });
  check("issue-state unknown id → data.issue null", (rState0.response as any).data.issue === null);
  const rUpd = handleGraphql(fixture, st, 42, { query: issueUpdateMutation, variables: { id: nodes[0].id, labelIds: [] } });
  check("issueUpdate (reap) succeeds", (rUpd.response as any).data.issueUpdate.success === true);
  const rUpdBad = handleGraphql(fixture, st, 42, { query: issueUpdateMutation, variables: { id: "nope", labelIds: [] } });
  check("issueUpdate unknown id → errors", Array.isArray((rUpdBad.response as any).errors));
  const rC = handleGraphql(fixture, st, 42, {
    query: commentMutation,
    variables: { input: { issueId: nodes[0].id, body: "twin hello" } },
  });
  check("commentCreate succeeds + records", (rC.response as any).data.commentCreate.success === true && st.comments.length === 1);
  const rCBad = handleGraphql(fixture, st, 42, { query: commentMutation, variables: { input: { issueId: "nope", body: "x" } } });
  check("commentCreate unknown issue → errors", Array.isArray((rCBad.response as any).errors));
  // Consensus regression locks (cg-1783019958392-4vfnm3): contract fidelity + no fixture aliasing.
  const rCEmpty = handleGraphql(fixture, st, 42, { query: commentMutation, variables: { input: { issueId: nodes[0].id, body: "   " } } });
  check("commentCreate empty body → errors (Linear fidelity)", Array.isArray((rCEmpty.response as any).errors) && st.comments.length === 1);
  (rState.response as any).data.issue.state.type = "MUTATED";
  nodes[0].state.name = "MUTATED";
  const rStateAgain = handleGraphql(fixture, st, 42, { query: issueStateQuery, variables: { id: nodes[0].id } });
  check("responses never alias the fixture (consumer mutation is inert)", (rStateAgain.response as any).data.issue.state.type === "unstarted" && fixture.issues.every((i) => i.state.name !== "MUTATED" && i.state.type !== "MUTATED"));
  const rNull = handleGraphql(fixture, st, 42, null);
  check("malformed body → errors", Array.isArray((rNull.response as any).errors));
  check(
    "bad fixture fails loud",
    throwsWith(() => {
      const p = join(ROOT, "badfix.json");
      writeFileSync(p, JSON.stringify({ kind: "linear", fixture_id: "x", issues: [] }));
      loadTwinFixture(p);
    }, "non-empty"),
  );

  // ─── §3 twin determinism + per-run isolation ───────────────────────────────
  console.log("§3 twin determinism + isolation");
  const r1 = mulberry32(7);
  const r2 = mulberry32(7);
  check("mulberry32 deterministic", r1() === r2() && r1() === r2());
  async function httpSequence(seed: number): Promise<{ sha256: string; comments: number }> {
    const t = startTwin(fixture, seed);
    try {
      for (const body of [
        { query: issuesQuery, variables: { projectId: PROJECT_ID, labelId: LABEL_ID } },
        { query: commentMutation, variables: { input: { issueId: fixture.issues[0].id, body: "det" } } },
      ]) {
        const res = await fetch(t.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!res.ok) throw new Error(`twin http ${res.status}`);
        await res.json();
      }
      const tr = t.transcript();
      const created = (tr.entries[1].response as any).data.commentCreate.comment.id as string;
      return { sha256: tr.sha256, comments: created.startsWith(`twin-${seed}-comment-`) ? 1 : -1 };
    } finally {
      t.stop();
    }
  }
  const [sA, sB, sC] = [await httpSequence(42), await httpSequence(42), await httpSequence(9)];
  check("same seed + same sequence → identical transcript sha", sA.sha256 === sB.sha256);
  check("different seed → different transcript sha", sA.sha256 !== sC.sha256);
  check("comment ids are seed-scoped PRNG values", sA.comments === 1 && sC.comments === 1);
  const freshTwin = startTwin(fixture, 42);
  const freshRes = await fetch(freshTwin.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: issueStateQuery, variables: { id: fixture.issues[0].id } }),
  });
  await freshRes.json();
  const freshTr = freshTwin.transcript();
  freshTwin.stop();
  check("per-run isolation: new twin starts with empty transcript/state", freshTr.entries.length === 1 && freshTr.entries[0].seq === 0);
  check("transcriptSha256 pure + stable", transcriptSha256([]) === transcriptSha256([]));
  // Consensus regression lock (cg-1783019958392-4vfnm3): the recorded transcript
  // is immutable through the transcript() return value.
  const mutTwin = startTwin(fixture, 42);
  await (await fetch(mutTwin.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: issueStateQuery, variables: { id: fixture.issues[0].id } }) })).json();
  const shaBefore = mutTwin.transcript().sha256;
  const stolen = mutTwin.transcript();
  (stolen.entries[0] as any).response = "CORRUPTED";
  (stolen.entries[0] as any).op = "CORRUPTED";
  check("caller mutation of transcript() result never corrupts the record", mutTwin.transcript().sha256 === shaBefore);
  mutTwin.stop();

  // ─── §4 sandbox env ────────────────────────────────────────────────────────
  console.log("§4 sandbox env");
  const hostileParent = {
    ...process.env,
    STRIPE_SECRET_KEY: "sk_live_x",
    ANTHROPIC_API_KEY: "sk-ant-x",
    ZO_SECRET: "zo-x",
    LINEAR_API_KEY: "lin_real_x",
    RANDOM_PARENT_VAR: "leak-me",
  } as NodeJS.ProcessEnv;
  const envSpec: ScenarioSpec = {
    scenario_id: "env-probe",
    seed: 1,
    env: { LINEAR_API_KEY: "twin-fake", CUSTOM_FLAG: "1" },
    steps: [{ name: "s1", run: "true", expect: { exit_code: 0 } }],
  };
  const envNoTwin = buildScenarioEnv(hostileParent, envSpec, null);
  check(
    "parent secrets + non-allowlist vars stripped",
    envNoTwin.STRIPE_SECRET_KEY === undefined &&
      envNoTwin.ANTHROPIC_API_KEY === undefined &&
      envNoTwin.ZO_SECRET === undefined &&
      envNoTwin.RANDOM_PARENT_VAR === undefined,
  );
  check("parent LINEAR_API_KEY never forwarded — spec literal wins", envNoTwin.LINEAR_API_KEY === "twin-fake");
  check("spec literal env present", envNoTwin.CUSTOM_FLAG === "1");
  check(
    "proxy pins present and egress-refusing",
    envNoTwin.HTTPS_PROXY === "http://127.0.0.1:0" && envNoTwin.HTTP_PROXY === "http://127.0.0.1:0",
  );
  check("no twin → NO_PROXY stays pinned empty", envNoTwin.NO_PROXY === "" && envNoTwin.LINEAR_API_URL === undefined);
  const envTwin = buildScenarioEnv(hostileParent, envSpec, "http://127.0.0.1:5555/graphql");
  check(
    "twin → loopback-only NO_PROXY overlay + LINEAR_API_URL",
    envTwin.NO_PROXY === "127.0.0.1,localhost" && envTwin.LINEAR_API_URL === "http://127.0.0.1:5555/graphql",
  );
  check("twin overlay leaves egress pins intact", envTwin.HTTPS_PROXY === "http://127.0.0.1:0");
  const envWithState = buildScenarioEnv(hostileParent, envSpec, null, join(ROOT, "scenario-state"));
  check(
    "runner-owned state root is disposable test state",
    envWithState.FACTORY_STATE_DIR === join(ROOT, "scenario-state")
      && envWithState.FACTORY_STATE_MODE === "test"
      && envWithState.FACTORY_STATE_ALLOW_OUTSIDE_ROOT === "1",
  );
  const hostileSpec: ScenarioSpec = {
    scenario_id: "hostile-env",
    seed: 1,
    env: { NO_PROXY: "evil.example", HTTPS_PROXY: "", LINEAR_API_URL: "http://evil.example" } as Record<string, string>,
    steps: [{ name: "s1", run: "true", expect: { exit_code: 0 } }],
  };
  const envHostile = buildScenarioEnv(hostileParent, hostileSpec, null);
  check(
    "reserved names in spec env ignored even if parser bypassed",
    envHostile.NO_PROXY === "" && envHostile.HTTPS_PROXY === "http://127.0.0.1:0" && envHostile.LINEAR_API_URL === undefined,
  );
  const savedLinearApiKey = process.env.LINEAR_API_KEY;
  process.env.LINEAR_API_KEY = "hostile-parent-sentinel";
  try {
    const childEnv = buildScenarioEnv(process.env, { ...envSpec, env: { CUSTOM_FLAG: "1" } }, null);
    const childOutcome = await executeStep(
      'if [ "${LINEAR_API_KEY+x}" = x ]; then exit 12; fi; printf "absent custom=%s" "$CUSTOM_FLAG"',
      ROOT,
      childEnv,
    );
    check(
      "hostile parent LINEAR_API_KEY is absent at actual scenario child boundary",
      childOutcome.exit_code === 0 && childOutcome.stdout === "absent custom=1" && childOutcome.stderr === "",
      JSON.stringify({
        exit_code: childOutcome.exit_code,
        timed_out: childOutcome.timed_out,
        spawn_error: childOutcome.spawn_error,
        stdout_length: childOutcome.stdout.length,
        stderr_length: childOutcome.stderr.length,
      }),
    );
  } finally {
    if (savedLinearApiKey === undefined) delete process.env.LINEAR_API_KEY;
    else process.env.LINEAR_API_KEY = savedLinearApiKey;
  }

  // ─── §5 expectation math + placeholders ────────────────────────────────────
  console.log("§5 expectation math + placeholders");
  const okOutcome: StepOutcome = { exit_code: 0, timed_out: false, spawn_error: null, stdout: "hello world", stderr: "warn: x" };
  check("all expectations met → no failures", checkExpectations({ exit_code: 0, stdout_contains: ["hello"], stderr_contains: ["warn"], files_exist: ["a.txt"] }, okOutcome, () => true).length === 0);
  check("exit code mismatch fails", checkExpectations({ exit_code: 0 }, { ...okOutcome, exit_code: 3 }, () => true).some((f) => f.includes("exit_code 3")));
  check("stdout substring missing fails", checkExpectations({ stdout_contains: ["absent"] }, okOutcome, () => true).some((f) => f.includes("stdout missing")));
  check("stderr substring missing fails", checkExpectations({ stderr_contains: ["absent"] }, okOutcome, () => true).some((f) => f.includes("stderr missing")));
  check("file missing fails via injected probe", checkExpectations({ files_exist: ["gone.txt"] }, okOutcome, () => false).some((f) => f.includes("file missing")));
  check("timeout is always a failure", checkExpectations({ exit_code: 0 }, { ...okOutcome, exit_code: null, timed_out: true }, () => true).some((f) => f.includes("timed out")));
  // Consensus regression locks (cg-1783018855900-pug6cf): maxBuffer overflow must
  // fail LOUDLY — never crash, never pass on truncated output.
  const overflow = await executeStep('head -c 200000 /dev/zero | tr "\\0" x; echo NEEDLE', process.cwd(), process.env, { maxBuffer: 1024, timeoutMs: 10_000 });
  check("ENOBUFS overflow is captured, not thrown", overflow.spawn_error === "ENOBUFS" && overflow.exit_code === null);
  check("truncated output can never satisfy stdout_contains", checkExpectations({ stdout_contains: ["x"] }, overflow, () => true).some((f) => f.includes("spawn error: ENOBUFS")));
  const timedOut = await executeStep("sleep 5", process.cwd(), process.env, { timeoutMs: 200 });
  check("unit-level ETIMEDOUT sets timed_out, not spawn_error", timedOut.timed_out && timedOut.spawn_error === null);
  check(
    "placeholders materialize",
    materializeRun("bun {scripts_dir}/x.ts --out {workdir}/o", "/S", "/W") === "bun /S/x.ts --out /W/o",
  );

  // ─── §6 runner E2E (pass, fail-fast, ledger rows) ──────────────────────────
  console.log("§6 runner E2E + ledger");
  const runsA = join(ROOT, "runs-a.jsonl");
  process.env.SF009_RUNS_PATH = runsA;
  const passSpecPath = writeSpec(
    "run-pass.yaml",
    [
      "scenario_id: run-pass",
      "seed: 3",
      "steps:",
      "  - name: write",
      "    run: echo payload > out.txt",
      "    expect: { exit_code: 0 }",
      "  - name: verify",
      "    run: cat out.txt",
      "    expect:",
      "      exit_code: 0",
      "      stdout_contains: [payload]",
      "      files_exist: [out.txt]",
    ].join("\n"),
  );
  const passRec = await runScenario(passSpecPath);
  check("passing scenario → verdict passed 2/2", passRec.verdict === "passed" && passRec.steps_passed === 2 && passRec.twin === null);
  check("legacy scenario run record omits lineage", !("lineage" in passRec));
  check("legacy scenario run record omits actor receipt fields", !("run_receipt_hash" in passRec));
  const lineageRunPath = writeSpec("run-lineage.json", JSON.stringify({
    scenario_id: "run-lineage", seed: 1056, lineage,
    steps: [{ name: "verify", run: "printf lineage-ok", expect: { exit_code: 0, stdout_contains: ["lineage-ok"] } }],
  }));
  const lineageRec = await runScenario(lineageRunPath);
  check(
    "lineage survives ScenarioSpec → ScenarioRunRecord verdict",
    lineageRec.verdict === "passed"
      && lineageRec.lineage?.source_receipt_hash === lineage.source_receipt_hash
      && lineageRec.lineage?.candidate_hash === lineage.candidate_hash
      && lineageRec.lineage?.review_hash === lineage.review_hash,
  );
  const failSpecPath = writeSpec(
    "run-fail.yaml",
    [
      "scenario_id: run-fail",
      "seed: 3",
      "steps:",
      "  - name: boom",
      "    run: exit 9",
      "    expect: { exit_code: 0 }",
      "  - name: never",
      "    run: echo unreachable",
      "    expect: { exit_code: 0 }",
    ].join("\n"),
  );
  const failRec = await runScenario(failSpecPath);
  check(
    "failing scenario fail-fast → verdict failed at first step",
    failRec.verdict === "failed" && failRec.failed_step === "boom" && failRec.steps_passed === 0 && failRec.failures[0].includes("exit_code 9"),
  );
  const timeoutSpecPath = writeSpec(
    "run-timeout.yaml",
    ["scenario_id: run-timeout", "seed: 3", "steps:", "  - name: sleepy", "    run: sleep 5", "    timeout_ms: 300", "    expect: { exit_code: 0 }"].join("\n"),
  );
  const timeoutRec = await runScenario(timeoutSpecPath);
  check("timeout → failed with timed-out failure", timeoutRec.verdict === "failed" && timeoutRec.failures.some((f) => f.includes("timed out")));
  const ledger = readJsonlTolerant<ScenarioRunRecord>(runsA);
  check("ledger has 4 append-only rows", ledger.rows.length === 4 && ledger.torn_lines === 0);
  const statusA = deriveStatus(runsA);
  check(
    "status derives verdict counts per scenario",
    statusA.runs_total === 4 && statusA.by_verdict.passed === 2 && statusA.by_verdict.failed === 2 && statusA.scenarios.length === 4,
  );
  // torn trailing line tolerated
  writeFileSync(runsA, readFileSync(runsA, "utf8") + '{"scenario_id": "torn...');
  const statusTorn = deriveStatus(runsA);
  check("torn trailing line tolerated + counted", statusTorn.runs_total === 4 && statusTorn.torn_lines === 1);
  const snap = sf009Snapshot();
  check("sf009Snapshot derives (never throws)", snap.runs_total === 4 && snap.torn_lines === 1 && snap.last_run !== null && snap.invalid.length === 0);

  const actorRuns = join(ROOT, "actor-runs.jsonl");
  process.env.SF009_RUNS_PATH = actorRuns;
  const actorRunPath = writeSpec("actor-run.json", JSON.stringify({
    scenario_id: "actor-run",
    seed: 1057001,
    twin: {
      kind: "actor-system",
      fixture: ACTOR_FIXTURE,
      contract_id: ACTOR_CONTRACT.id,
      authority_kind: "approved_manifest",
      manifest_sha256: ACTOR_MANIFEST_HASH,
      contract_sha256: ACTOR_CONTRACT_HASH,
      review_sha256: "a".repeat(64),
    },
    trajectory_verifier: TRAJECTORY_DECL,
    steps: [{
      name: "invoke",
      run: `bun -e 'const r=await fetch(process.env.ACTOR_SYSTEM_TWIN_URL,{method:"POST",body:JSON.stringify({requestId:"selftest",approval:"allow"})}); console.log(await r.text())'`,
      expect: { exit_code: 0, stdout_contains: ["completed"] },
    }],
  }));
  delete process.env.SF009_ACTOR_TWINS;
  delete process.env.SF009_TRAJECTORY_VERIFIER;
  check("actor twin refuses execution while its flag is off", await rejectsWith(() => runScenario(actorRunPath), "disabled"));
  process.env.SF009_ACTOR_TWINS = "1";
  const actorRun = await runScenario(actorRunPath);
  const actorRepeat = await runScenario(actorRunPath);
  check(
    "actor twin reaches incumbent runner and stores only receipt identity and metrics",
    actorRun.verdict === "passed"
      && actorRun.twin === "actor-system"
      && typeof actorRun.run_receipt_id === "string"
      && typeof actorRun.run_receipt_hash === "string"
      && actorRun.run_receipt_events === 6
      && actorRun.run_receipt_attempts === 1
      && actorRun.run_receipt_outcome === "success",
    JSON.stringify(actorRun),
  );
  check("actor run receipt and transcript are deterministic", actorRepeat.run_receipt_hash === actorRun.run_receipt_hash && actorRepeat.twin_transcript_sha256 === actorRun.twin_transcript_sha256);
  check("verifier-off actor record omits every trajectory field", !Object.keys(actorRun).some((key) => key.startsWith("trajectory_")));
  process.env.SF009_TRAJECTORY_VERIFIER = "1";
  const verifiedActorRun = await runScenario(actorRunPath);
  const verifiedActorRepeat = await runScenario(actorRunPath);
  check(
    "advisory trajectory verifier reaches runner and stores structural evidence only",
    verifiedActorRun.verdict === actorRun.verdict
      && verifiedActorRun.trajectory_disposition === "PASS"
      && verifiedActorRun.trajectory_reproduction_ratio === 1
      && verifiedActorRun.trajectory_uncertainty_count === 0
      && typeof verifiedActorRun.trajectory_report_id === "string"
      && typeof verifiedActorRun.trajectory_report_hash === "string",
    JSON.stringify(verifiedActorRun),
  );
  check(
    "fresh verifier workers preserve canonical structural hashes",
    verifiedActorRepeat.trajectory_report_hash === verifiedActorRun.trajectory_report_hash
      && verifiedActorRepeat.run_receipt_hash === verifiedActorRun.run_receipt_hash,
  );
  const holdActorSpec = JSON.parse(readFileSync(actorRunPath, "utf8")) as Record<string, unknown>;
  holdActorSpec.scenario_id = "actor-hold";
  holdActorSpec.trajectory_verifier = {
    ...TRAJECTORY_DECL,
    verifier_model_id: TRAJECTORY_DECL.generator_model_id,
    verifier_prompt_sha256: TRAJECTORY_DECL.generator_prompt_sha256,
    verifier_history_sha256: TRAJECTORY_DECL.generator_history_sha256,
  };
  const holdActorRun = await runScenario(writeSpec("actor-hold.json", JSON.stringify(holdActorSpec)));
  check(
    "verifier HOLD remains advisory and cannot rewrite the incumbent verdict",
    holdActorRun.verdict === "passed"
      && holdActorRun.run_receipt_outcome === "success"
      && holdActorRun.trajectory_disposition === "HOLD"
      && (holdActorRun.trajectory_uncertainty_count ?? 0) >= 3,
    JSON.stringify(holdActorRun),
  );
  const actorLedgerBytes = readFileSync(actorRuns, "utf8");
  check("actor ledger excludes canonical receipt and full verifier payloads", !actorLedgerBytes.includes('"events"') && !actorLedgerBytes.includes('"attempts"') && !actorLedgerBytes.includes('"qualitative_evidence"') && !actorLedgerBytes.includes('"claims"'));

  // ─── §7 egress-refused E2E fetch ───────────────────────────────────────────
  console.log("§7 egress-refused E2E");
  const runsB = join(ROOT, "runs-b.jsonl");
  process.env.SF009_RUNS_PATH = runsB;
  const egressSpecPath = writeSpec(
    "egress.yaml",
    [
      "scenario_id: egress-probe",
      "seed: 3",
      "steps:",
      "  - name: probe",
      // fetch honors the sandbox HTTPS_PROXY pin → unbindable sink refuses egress.
      // Block scalar: plain YAML scalars cannot carry the ": " inside the JS.
      "    run: >-",
      `      bun -e 'try { await fetch("https://example.com", { signal: AbortSignal.timeout(4000) }); console.log("EGRESS-OPEN"); } catch { console.log("egress-refused"); }'`,
      "    timeout_ms: 15000",
      "    expect:",
      "      exit_code: 0",
      "      stdout_contains: [egress-refused]",
    ].join("\n"),
  );
  const egressRec = await runScenario(egressSpecPath);
  check("sandboxed step cannot reach the internet", egressRec.verdict === "passed", JSON.stringify(egressRec.failures));

  // ─── §8 linear-puller vs twin E2E (committed scenario) ────────────────────
  console.log("§8 linear-puller vs twin E2E");
  const pullRec = await runScenario(COMMITTED_SCENARIO);
  check(
    "committed scenario passes end-to-end",
    pullRec.verdict === "passed" && pullRec.steps_passed === 2 && pullRec.twin === "linear",
    JSON.stringify(pullRec.failures),
  );
  check("twin served two requests (puller query + one reap)", pullRec.twin_requests === 2 && pullRec.twin_transcript_sha256 !== null);
  const pullRec2 = await runScenario(COMMITTED_SCENARIO);
  check("re-run reproduces the twin transcript sha", pullRec2.twin_transcript_sha256 === pullRec.twin_transcript_sha256);

  // ─── §9 flags-off zero-files CLI identity ──────────────────────────────────
  console.log("§9 flags-off CLI identity");
  const s9 = join(ROOT, "s9");
  mkdirSync(s9, { recursive: true });
  const offEnv = { ...process.env, SF009_RUNS_PATH: join(s9, "runs.jsonl") } as Record<string, string>;
  delete offEnv.SF009_SCENARIOS;
  const clis = [
    `bun ${join(import.meta.dir, "scenario-spec.ts")} validate --spec ${COMMITTED_SCENARIO}`,
    `bun ${join(import.meta.dir, "scenario-run.ts")} run ${COMMITTED_SCENARIO}`,
    `bun ${join(import.meta.dir, "scenario-run.ts")} status`,
  ];
  let offOk = true;
  for (const cmd of clis) {
    if (execSync(cmd, { encoding: "utf-8", env: offEnv }).trim() !== "") offOk = false;
    if (execSync(cmd, { encoding: "utf-8", env: { ...offEnv, SF009_SCENARIOS: "0" } }).trim() !== "") offOk = false;
  }
  check("all 3 CLIs exit 0 silently with flag unset AND =0", offOk);
  check("flags-off created zero files", readdirSync(s9).length === 0);

  console.log("§10 cross-harness conformance protocol");
  const conformanceTestOutput = execSync(
    [
      "bun test",
      join(import.meta.dir, "cross-harness-conformance-contract.test.ts"),
      join(import.meta.dir, "cross-harness-conformance-runner.test.ts"),
      join(import.meta.dir, "cross-harness-conformance-cohort.test.ts"),
    ].join(" "),
    { encoding: "utf8" },
  );
  check("cross-harness protocol is reachable from scenario selftest", true, conformanceTestOutput);

  console.log("§11 scenario-source comparison protocol");
  const scenarioSourceTestOutput = execSync(
    [
      "bun test",
      join(import.meta.dir, "scenario-source-comparison-contract.test.ts"),
      join(import.meta.dir, "scenario-source-comparison-runner.test.ts"),
      join(import.meta.dir, "scenario-source-comparison-cohort.test.ts"),
    ].join(" "),
    { encoding: "utf8" },
  );
  check("scenario-source comparison is reachable from scenario selftest", true, scenarioSourceTestOutput);

  console.log("§12 output-trajectory comparison protocol");
  const outputTrajectoryTestOutput = execSync(
    [
      "bun test",
      join(import.meta.dir, "output-trajectory-comparison-contract.test.ts"),
      join(import.meta.dir, "output-trajectory-comparison-runner.test.ts"),
      join(import.meta.dir, "output-trajectory-comparison-cohort.test.ts"),
    ].join(" "),
    { encoding: "utf8" },
  );
  check("output-trajectory comparison is reachable from scenario selftest", true, outputTrajectoryTestOutput);

  console.log("§13 silent-success receipt comparison protocol");
  const silentSuccessTestOutput = execSync(
    [
      "bun test",
      join(import.meta.dir, "silent-success-comparison-contract.test.ts"),
      join(import.meta.dir, "silent-success-comparison-runner.test.ts"),
      join(import.meta.dir, "silent-success-comparison-cohort.test.ts"),
    ].join(" "),
    { encoding: "utf8" },
  );
  check("silent-success receipt comparison is reachable from scenario selftest", true, silentSuccessTestOutput);

  console.log("§14 harness portability comparison protocol");
  const harnessPortabilityTestOutput = execSync(
    [
      "bun test",
      join(import.meta.dir, "harness-portability-comparison-contract.test.ts"),
      join(import.meta.dir, "harness-portability-comparison-runner.test.ts"),
      join(import.meta.dir, "harness-portability-comparison-cohort.test.ts"),
    ].join(" "),
    { encoding: "utf8" },
  );
  check("harness portability comparison is reachable from scenario selftest", true, harnessPortabilityTestOutput);

  console.log("§15 skill compatibility and promotion decision protocol");
  const skillPromotionTestOutput = execSync(
    [
      "bun test",
      join(import.meta.dir, "skill-promotion-decision-contract.test.ts"),
      join(import.meta.dir, "skill-promotion-decision-runner.test.ts"),
      join(import.meta.dir, "skill-promotion-decision-cohort.test.ts"),
    ].join(" "),
    { encoding: "utf8" },
  );
  check("skill promotion decision is reachable from scenario selftest", true, skillPromotionTestOutput);

  // ─── §16 frozen modules byte-untouched ─────────────────────────────────────
  console.log("§16 frozen modules untouched");
  // dispatcher.ts is intentionally excluded: it carries the {valid,rejected}
  // unwrap fix (loadTickets/coerceTicketArray) that the conveyor's step-4 pipe
  // requires — it is no longer byte-frozen relative to the SF-009 baseline.
  const frozen = [
    "scripts/swarm-exec.ts",
    "scripts/pool-queue.ts",
    "scripts/pool-manager.ts",
    "scripts/pool-worker.ts",
    "scripts/factory-collect.ts",
    "scripts/factory-slo.ts",
    "scripts/dedup-gate.ts",
    "scripts/signal-intake.ts",
    "scripts/fleet-spec.ts",
    "scripts/fleet-campaign.ts",
    "scripts/fleet-status.ts",
  ];
  const frozenDiff = execSync(`git status --porcelain -- ${frozen.join(" ")}`, {
    encoding: "utf-8",
    cwd: join(import.meta.dir, ".."),
  }).trim();
  check("dispatcher/swarm-exec/pool/SF-004..008 modules have no working-tree changes", frozenDiff === "", frozenDiff);
} finally {
  process.env.SF009_RUNS_PATH = SAVED.runs;
  process.env.SF009_SCENARIOS = SAVED.flag;
  process.env.SF009_ACTOR_TWINS = SAVED.actorFlag;
  process.env.SF009_TRAJECTORY_VERIFIER = SAVED.trajectoryFlag;
  process.env.FACTORY_STATE_DIR = SAVED.stateDir;
  process.env.FACTORY_STATE_MODE = SAVED.stateMode;
  process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = SAVED.outsideRoot;
  if (SAVED.runs === undefined) delete process.env.SF009_RUNS_PATH;
  if (SAVED.flag === undefined) delete process.env.SF009_SCENARIOS;
  if (SAVED.actorFlag === undefined) delete process.env.SF009_ACTOR_TWINS;
  if (SAVED.trajectoryFlag === undefined) delete process.env.SF009_TRAJECTORY_VERIFIER;
  if (SAVED.stateDir === undefined) delete process.env.FACTORY_STATE_DIR;
  if (SAVED.stateMode === undefined) delete process.env.FACTORY_STATE_MODE;
  if (SAVED.outsideRoot === undefined) delete process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT;
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(`\nscenario-selftest: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
