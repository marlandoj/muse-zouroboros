import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkBaseBranch,
  checkConsensusSeats,
  checkContracts,
  checkModelPolicies,
  checkProviderAliases,
  checkSerialChain,
  checkTargetRepos,
  formatReport,
  runPreflight,
  type QueuedTicket,
} from "./project-preflight";
import { recordRawFailure } from "./lane-halt";
import type { ProbeCall } from "./consensus-capability";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "preflight-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

const CONTRACT = [
  "## Acceptance Criteria",
  "- it works",
  "## Target Repo",
  "zouroboros",
  "## Archetype",
  "feature",
  "## Repro",
  "n/a",
].join("\n");

function ticket(identifier: string, extra = "", overrides: Partial<QueuedTicket> = {}): QueuedTicket {
  return {
    linear_id: `id-${identifier}`,
    identifier,
    title: `Ticket ${identifier}`,
    description: `${CONTRACT}\n${extra}`,
    url: `https://linear.app/${identifier}`,
    state: "Backlog",
    labels: [],
    created_at: "2026-07-26T00:00:00.000Z",
    updated_at: "2026-07-26T00:00:00.000Z",
    ...overrides,
  };
}

/** The exact malformed block that entered the ZBRE queue. */
const BACKTICKED_POLICY = [
  "## Model Policy (project-scoped)",
  'LINEUP_ROLE_CHAINS=`{"proposers":[{"primary":"hf:a"}],"aggregator":{"primary":"xai:b"}}`',
].join("\n");

const BROKEN_POLICY = [
  "## Model Policy (project-scoped)",
  'LINEUP_ROLE_CHAINS={"proposers":[},"aggregator":1}',
].join("\n");

const verdictCall: ProbeCall = async () => ({
  ok: true, provider: "synthetic", latencyMs: 10,
  content: '{"pass": false, "issues": ["x"], "confidence": 0.8}',
});
const proseCall: ProbeCall = async () => ({
  ok: true, provider: "synthetic", latencyMs: 10,
  content: "I reviewed the diff and I do not think this is safe.",
});

describe("preflight checks (FH-01)", () => {
  test("catches the malformed role chain before the first promotion", () => {
    const result = checkModelPolicies([ticket("ZOU-929", BROKEN_POLICY)]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({
      check: "model_policy",
      severity: "blocking",
      ticket: "ZOU-929",
      subject: "LINEUP_ROLE_CHAINS",
      failure_class: "configuration_error",
    });
  });

  test("a backticked role chain is repaired by the parser, not reported as a defect", () => {
    const result = checkModelPolicies([ticket("ZOU-929", BACKTICKED_POLICY)]);
    expect(result.findings).toEqual([]);
    expect(result.policies.get("ZOU-929")?.role_chains).toContain('"proposers"');
  });

  test("reports every ticket carrying the defect, not just the first", () => {
    const queue = ["ZOU-929", "ZOU-930", "ZOU-931", "ZOU-933"].map((id) => ticket(id, BROKEN_POLICY));
    expect(checkModelPolicies(queue).findings.map((f) => f.ticket)).toEqual(queue.map((t) => t.identifier));
  });

  test("flags missing contract fields", () => {
    const bare = ticket("ZOU-900");
    bare.description = "no contract here";
    const findings = checkContracts([bare]);
    expect(findings[0].check).toBe("contract");
    expect(findings[0].message).toContain("acceptance_criteria");
  });

  test("flags malformed and unknown-scheme provider aliases", () => {
    const { policies } = checkModelPolicies([
      ticket("ZOU-1", "## Model Policy\nLINEUP_PIN_PROPOSERS=vendor/ok,unknownscheme:model"),
    ]);
    const findings = checkProviderAliases(policies);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain('unknown provider prefix "unknownscheme:"');
  });

  test("accepts unprefixed ids, which route to OpenRouter", () => {
    const { policies } = checkModelPolicies([
      ticket("ZOU-1", "## Model Policy\nLINEUP_PIN_PROPOSERS=z-ai/glm-5.2,hf:vendor/m,byok:uuid"),
    ]);
    expect(checkProviderAliases(policies)).toEqual([]);
  });

  test("flags a target repo that does not resolve on disk", () => {
    const findings = checkTargetRepos([ticket("ZOU-1")], { repoRoot: "/nowhere", exists: () => false });
    expect(findings[0]).toMatchObject({ check: "target_repo", severity: "blocking" });
  });

  test("does not try to resolve a URL target on disk", () => {
    const remote = ticket("ZOU-1");
    remote.description = remote.description.replace("zouroboros", "https://github.com/marlandoj/zouroboros");
    expect(checkTargetRepos([remote], { exists: () => false })).toEqual([]);
  });

  test("flags an unresolvable base ref", () => {
    expect(checkBaseBranch("origin/main", { resolve: () => true })).toEqual([]);
    expect(checkBaseBranch("origin/nope", { resolve: () => false })[0].check).toBe("base_branch");
  });

  test("flags a dependency on a ticket outside the queue", () => {
    const findings = checkSerialChain([
      ticket("ZOU-1", "", { stable_key: "ZBRE-001" }),
      ticket("ZOU-2", "", { stable_key: "ZBRE-002", depends_on: ["ZBRE-099"] }),
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("ZBRE-099");
  });

  test("detects a dependency cycle without hanging", () => {
    const findings = checkSerialChain([
      ticket("ZOU-1", "", { stable_key: "A", depends_on: ["B"] }),
      ticket("ZOU-2", "", { stable_key: "B", depends_on: ["C"] }),
      ticket("ZOU-3", "", { stable_key: "C", depends_on: ["A"] }),
    ]);
    expect(findings.some((f) => f.message.includes("cycle"))).toBe(true);
  });

  test("accepts a well-formed serial chain", () => {
    expect(checkSerialChain([
      ticket("ZOU-1", "", { stable_key: "A" }),
      ticket("ZOU-2", "", { stable_key: "B", depends_on: ["A"] }),
      ticket("ZOU-3", "", { stable_key: "C", depends_on: ["B"] }),
    ])).toEqual([]);
  });
});

describe("consensus seat check (FH-01 → FH-03)", () => {
  test("passes when enough routes return a real verdict", async () => {
    const findings = await checkConsensusSeats(new Map(), {
      defaultRoutes: ["hf:a", "hf:b", "xai:c"],
      minCapable: 3,
      call: verdictCall,
      path: join(scratch(), "health.json"),
    });
    expect(findings).toEqual([]);
  });

  test("blocks when routes are reachable but return prose", async () => {
    const findings = await checkConsensusSeats(new Map(), {
      defaultRoutes: ["hf:a", "hf:b", "xai:c"],
      minCapable: 3,
      call: proseCall,
      path: join(scratch(), "health.json"),
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("only 0 of 3");
    expect(findings[0].failure_class).toBe("provider_unavailable");
  });

  test("probes the routes the project actually pins", async () => {
    const probed: string[] = [];
    const { policies } = checkModelPolicies([
      ticket("ZOU-1", "## Model Policy\nLINEUP_PIN_PROPOSERS=hf:x,hf:y\nLINEUP_PIN_AGGREGATOR=xai:z"),
    ]);
    await checkConsensusSeats(policies, {
      minCapable: 3,
      path: join(scratch(), "health.json"),
      call: async (model) => { probed.push(model); return verdictCall(model, ""); },
    });
    expect(probed.sort()).toEqual(["hf:x", "hf:y", "xai:z"]);
  });

  test("blocks when there is no panel to probe at all", async () => {
    const findings = await checkConsensusSeats(new Map(), { path: join(scratch(), "health.json") });
    expect(findings[0].message).toContain("no consensus routes to probe");
  });
});

describe("preflight orchestration (FH-01)", () => {
  const base = () => scratch();

  test("a clean queue clears for promotion", async () => {
    const report = await runPreflight({
      project: "ZBRE",
      tickets: [ticket("ZOU-1", "", { stable_key: "ZBRE-001" })],
      baseRef: "origin/main",
      defaultRoutes: ["hf:a", "hf:b", "xai:c"],
      probeCall: verdictCall,
      resolveRef: () => true,
      exists: () => true,
      base: base(),
      healthPath: join(scratch(), "health.json"),
      now: "2026-07-26T18:00:00.000Z",
    });
    expect(report.ok).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.checks_skipped).toEqual([]);
  });

  test("the ZBRE queue as it actually was would have been blocked before ticket one", async () => {
    const report = await runPreflight({
      project: "ZBRE",
      tickets: ["ZOU-929", "ZOU-930", "ZOU-931", "ZOU-933"].map((id) =>
        ticket(id, BROKEN_POLICY, { stable_key: id })),
      baseRef: "origin/main",
      defaultRoutes: ["hf:a", "hf:b", "xai:c"],
      probeCall: verdictCall,
      resolveRef: () => true,
      exists: () => true,
      base: base(),
      healthPath: join(scratch(), "health.json"),
    });
    expect(report.ok).toBe(false);
    expect(report.findings.filter((f) => f.check === "model_policy")).toHaveLength(4);
  });

  test("an open lane halt blocks promotion", async () => {
    const dir = base();
    const defect = "LINEUP_ROLE_CHAINS must be valid JSON: Unrecognized token '\x60'";
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-929", execution_id: "e1", message: defect }, { base: dir });
    recordRawFailure({ project: "ZBRE", ticket: "ZOU-930", execution_id: "e2", message: defect }, { base: dir });

    const report = await runPreflight({
      project: "ZBRE",
      tickets: [ticket("ZOU-940")],
      baseRef: "origin/main",
      defaultRoutes: ["hf:a", "hf:b", "xai:c"],
      probeCall: verdictCall,
      resolveRef: () => true,
      exists: () => true,
      base: dir,
      healthPath: join(scratch(), "health.json"),
    });
    expect(report.ok).toBe(false);
    expect(report.findings.some((f) => f.check === "lane_halt")).toBe(true);
  });

  test("a skipped check is not a pass", async () => {
    const report = await runPreflight({
      project: "ZBRE",
      tickets: [ticket("ZOU-1")],
      skipSeatProbe: true,
      resolveRef: () => true,
      exists: () => true,
      base: base(),
    });
    expect(report.findings).toEqual([]);
    expect(report.ok).toBe(false);
    expect(report.checks_skipped).toEqual(["base_branch", "consensus_seats"]);
  });

  test("the report names the ticket and field an operator must fix", async () => {
    const report = await runPreflight({
      project: "ZBRE",
      tickets: [ticket("ZOU-929", BROKEN_POLICY)],
      baseRef: "origin/main",
      defaultRoutes: ["hf:a", "hf:b", "xai:c"],
      probeCall: verdictCall,
      resolveRef: () => true,
      exists: () => true,
      base: base(),
      healthPath: join(scratch(), "health.json"),
    });
    const text = formatReport(report);
    expect(text).toContain("BLOCKED");
    expect(text).toContain("ZOU-929");
    expect(text).toContain("LINEUP_ROLE_CHAINS");
  });
});
