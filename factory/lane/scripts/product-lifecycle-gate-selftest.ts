#!/usr/bin/env bun

import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { dispatchTickets, type DispatchResult, type IntakeTicket } from "./dispatcher";
import {
  classifyProductApplicability,
  inspectProductContext,
  productGateAuditScript,
  productGateMode,
  productGateStatePath,
  productionReadyAuditArgs,
  runProductLaunchGate,
  runProductPreflight,
  type ProductPreflightResult,
  type ProductionReadyVerdict,
} from "./product-lifecycle-gate";
import { run, type RunDeps } from "./prespec-runner";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  ok ${name}`);
  } else {
    failed++;
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function section(name: string): void {
  console.log(`\n-- ${name} --`);
}

function ticket(archetype = "feature", overrides: Partial<IntakeTicket> = {}): IntakeTicket {
  return {
    linear_id: overrides.linear_id ?? "linear-zou-785",
    identifier: overrides.identifier ?? "ZOU-785",
    title: overrides.title ?? "Build product lifecycle gate",
    description: overrides.description ?? [
      "## Acceptance Criteria",
      "The requested behavior is verified.",
      "## Target Repo",
      "fixture-repo",
      "## Archetype",
      archetype,
      "## Repro",
      "factory conveyor",
    ].join("\n"),
    url: overrides.url ?? "",
    state: overrides.state ?? "Backlog",
    labels: overrides.labels ?? [],
    created_at: overrides.created_at ?? "2026-07-20T00:00:00Z",
    updated_at: overrides.updated_at ?? "2026-07-20T00:00:00Z",
  };
}

const PRODUCT = [
  "# Product",
  "## Register",
  "product",
  "## Target Users",
  "Operators who run an autonomous software factory and need product strategy to survive handoffs.",
  "## Product Purpose",
  "Stop implementation from starting before the intended users, problem, positioning, and constraints are durable.",
  "## Brand Personality",
  "Precise, operational, and evidence-led.",
  "## Anti-References",
  "Do not invent requirements or use decorative process theater.",
].join("\n");

const sandbox = mkdtempSync(join(tmpdir(), "product-gate-selftest-"));
const repo = join(sandbox, "fixture-repo");
const stateDir = join(sandbox, "state");
mkdirSync(repo, { recursive: true });

const saved = {
  SF006_DEDUP: process.env.SF006_DEDUP,
  SF002_CLASSIFY: process.env.SF002_CLASSIFY,
  SF_PRESPEC: process.env.SF_PRESPEC,
  FACTORY_PRODUCT_GATE: process.env.FACTORY_PRODUCT_GATE,
  FACTORY_PRODUCT_GATE_ENFORCE: process.env.FACTORY_PRODUCT_GATE_ENFORCE,
  FACTORY_STATE_MUTATION_EVIDENCE: process.env.FACTORY_STATE_MUTATION_EVIDENCE,
};

try {
  section("flags and applicability");
  check("off is the default", productGateMode({}) === "off");
  check("shadow flag selects shadow", productGateMode({ FACTORY_PRODUCT_GATE: "1" }) === "shadow");
  check("enforce takes precedence", productGateMode({ FACTORY_PRODUCT_GATE_ENFORCE: "1" }) === "enforce");
  for (const archetype of ["bugfix", "refactor", "migration", "dependency", "docs", "test", "ops", "infra", "security"]) {
    check(`${archetype} is exempt`, classifyProductApplicability(ticket(archetype)).applicability === "not_applicable");
  }
  for (const archetype of ["feature", "product", "greenfield", "ui", "ux", "unknown"]) {
    check(`${archetype} requires context`, classifyProductApplicability(ticket(archetype)).applicability === "required");
  }
  check(
    "explicit exemption label wins",
    classifyProductApplicability(ticket("feature", { labels: ["product-discovery-na"] })).applicability === "not_applicable",
  );
  check(
    "conflicting labels fail conservative",
    classifyProductApplicability(ticket("bugfix", {
      labels: ["product-discovery-na", "product-discovery-required"],
    })).applicability === "required",
  );
  check(
    "frontmatter directive is parsed",
    classifyProductApplicability(ticket("feature", {
      description: "---\nproduct_discovery: not_applicable\ntarget_repo: fixture-repo\narchetype: feature\nacceptance_criteria: pass\nrepro: area\n---",
    })).applicability === "not_applicable",
  );

  section("PRODUCT.md contract");
  const productPath = join(repo, "PRODUCT.md");
  writeFileSync(productPath, PRODUCT);
  const baseTicket = ticket("feature");
  const evidence = inspectProductContext(baseTicket, repo, { exists: existsSync, read: (path) => readFileSync(path, "utf8") });
  check("valid root PRODUCT.md passes", evidence.valid && evidence.path === "PRODUCT.md" && evidence.source === "root");
  check("valid context is hashed", typeof evidence.sha256 === "string" && evidence.sha256.length === 64);

  writeFileSync(productPath, "# Product\n[TODO]");
  check(
    "TODO placeholder fails",
    !inspectProductContext(baseTicket, repo, { exists: existsSync, read: (path) => readFileSync(path, "utf8") }).valid,
  );
  writeFileSync(productPath, "short");
  check(
    "short context fails",
    !inspectProductContext(baseTicket, repo, { exists: existsSync, read: (path) => readFileSync(path, "utf8") }).valid,
  );
  rmSync(productPath);
  mkdirSync(join(repo, "docs"), { recursive: true });
  writeFileSync(join(repo, "docs", "product.md"), PRODUCT);
  const docsEvidence = inspectProductContext(baseTicket, repo, { exists: existsSync, read: (path) => readFileSync(path, "utf8") });
  check("docs fallback is case-insensitive", docsEvidence.valid && docsEvidence.source === "docs");
  rmSync(join(repo, "docs"), { recursive: true });
  writeFileSync(productPath, PRODUCT);
  const escapeTicket = ticket("feature", {
    description: `${baseTicket.description}\n## Product Context\n../outside/PRODUCT.md`,
  });
  check(
    "explicit path cannot escape repo",
    !inspectProductContext(escapeTicket, repo, { exists: existsSync, read: (path) => readFileSync(path, "utf8") }).valid,
  );

  section("pre-dispatch behavior and persistence");
  let comments = 0;
  const commonDeps = {
    resolveRepo: () => repo,
    stateDir,
    postHoldComment: async () => {
      comments++;
      return true;
    },
  };
  const pass = await runProductPreflight(baseTicket, {
    env: { FACTORY_PRODUCT_GATE: "1" },
    deps: commonDeps,
  });
  check("valid context passes in shadow", pass.decision === "pass" && !pass.acted);
  check("state sidecar is written", existsSync(productGateStatePath(baseTicket.identifier, stateDir)));
  const stored = JSON.parse(readFileSync(productGateStatePath(baseTicket.identifier, stateDir), "utf8"));
  check("sidecar carries preflight hash", stored.preflight.evidence.sha256 === pass.evidence.sha256);
  const mutationRoot = join(dirname(stateDir), "state-mutation-evidence");
  check("off mode creates no mutation evidence", !existsSync(mutationRoot));

  rmSync(productPath);
  const laneLog = join(dirname(stateDir), "lane-utilization.jsonl");
  writeFileSync(`${laneLog}.current-cycle`, "cycle-product-1\n");
  writeFileSync(laneLog, `${JSON.stringify({ cycle_id: "cycle-product-1", phase: "open", ts: "2026-08-13T14:00:00.000Z" })}\n`);
  process.env.FACTORY_STATE_MUTATION_EVIDENCE = "shadow";
  const shadowHold = await runProductPreflight(baseTicket, {
    env: { FACTORY_PRODUCT_GATE: "1" },
    deps: commonDeps,
  });
  check("shadow records hold without acting", shadowHold.decision === "hold" && !shadowHold.acted && comments === 0);
  const mutationFiles = readdirSync(mutationRoot).filter((name) => name.endsWith(".json"));
  const productMutation = JSON.parse(readFileSync(join(mutationRoot, mutationFiles[0]!), "utf8"));
  check(
    "shadow replacement emits exact scheduled product receipt",
    mutationFiles.length === 1 &&
      productMutation.scope === "scheduled-cycle" &&
      productMutation.producer_id === "product-lifecycle-gate" &&
      productMutation.target_schema === "product-gate/v1" &&
      productMutation.target_path.endsWith("/zou-785.json"),
  );
  process.env.FACTORY_STATE_MUTATION_EVIDENCE = "off";
  const enforceHold = await runProductPreflight(baseTicket, {
    env: { FACTORY_PRODUCT_GATE_ENFORCE: "1" },
    deps: commonDeps,
  });
  check("enforce hold acts and comments once", enforceHold.decision === "hold" && enforceHold.acted && comments === 1);
  const repeatedHold = await runProductPreflight(baseTicket, {
    env: { FACTORY_PRODUCT_GATE_ENFORCE: "1" },
    deps: commonDeps,
  });
  check("same hold comment is idempotent", repeatedHold.comment_posted && comments === 1);
  const previewHold = await runProductPreflight(baseTicket, {
    env: { FACTORY_PRODUCT_GATE_ENFORCE: "1" },
    deps: commonDeps,
    persist: false,
    mutate: false,
  });
  check("preview never comments", previewHold.acted && comments === 1);
  const exempt = await runProductPreflight(ticket("bugfix"), {
    env: { FACTORY_PRODUCT_GATE_ENFORCE: "1" },
    deps: commonDeps,
  });
  check("exempt work never resolves repo context", exempt.decision === "not_applicable" && !exempt.acted);

  section("production-ready launch adapter");
  writeFileSync(productPath, PRODUCT);
  const enforcePass = await runProductPreflight(baseTicket, {
    env: { FACTORY_PRODUCT_GATE_ENFORCE: "1" },
    deps: { ...commonDeps, writeState: () => {} },
  });
  const expected: Array<[ProductionReadyVerdict, number, "pass" | "hold"]> = [
    ["launch-ready", 0, "pass"],
    ["launch-with-monitoring", 1, "pass"],
    ["private-beta-only", 2, "hold"],
    ["do-not-launch", 3, "hold"],
  ];
  for (const [verdict, status, decision] of expected) {
    const launch = runProductLaunchGate(baseTicket, enforcePass, `exec-${status}`, {
      deps: {
        stateDir,
        writeState: () => {},
        runAudit: (_repoPath, outDir) => {
          writeFileSync(join(outDir, "verdict.json"), JSON.stringify({ verdict }));
          return { status };
        },
      },
    });
    check(`${verdict} maps to ${decision}`, launch.decision === decision);
    check(`${verdict} authority is correct`, launch.acted === (decision === "hold"));
    check(`${verdict} report hash persists`, launch.report_sha256?.length === 64 && launch.report_path?.endsWith("verdict.json") === true);
  }
  const auditError = runProductLaunchGate(baseTicket, enforcePass, "exec-error", {
    deps: { stateDir, writeState: () => {}, runAudit: () => ({ status: 10, error: "audit unavailable" }) },
  });
  check("audit error fails closed in enforce", auditError.decision === "hold" && auditError.acted && auditError.reason_code === "audit_error");

  let auditCalls = 0;
  writeFileSync(productPath, `${PRODUCT}\nchanged after dispatch`);
  const drift = runProductLaunchGate(baseTicket, enforcePass, "exec-drift", {
    deps: {
      stateDir,
      writeState: () => {},
      runAudit: () => {
        auditCalls++;
        return { status: 0 };
      },
    },
  });
  check("context drift blocks before audit", drift.reason_code === "context_hash_drift" && drift.acted && auditCalls === 0);
  const auditArgs = productionReadyAuditArgs(repo, join(stateDir, "audit-args"));
  check("adapter uses canonical audit script", auditArgs[0] === productGateAuditScript());
  check("adapter pins repo/out/json contract", auditArgs.join(" ").includes(`--repo ${repo}`) && auditArgs.slice(-2).join(" ") === "--format json");

  section("dispatcher and prespec reachability");
  process.env.SF006_DEDUP = "0";
  process.env.SF002_CLASSIFY = "0";
  const order: string[] = [];
  const routed = await dispatchTickets([baseTicket], {
    productPreflight: async () => {
      order.push("product");
      return pass;
    },
    swarmGate: () => {
      order.push("swarm");
      return {
        ticket: undefined as never,
        decision: "DIRECT",
        score: 0,
        override: false,
        raw_exit: 2,
        reason: "fixture",
      } as DispatchResult;
    },
  });
  check("dispatcher invokes product gate before swarm gate", order.join(",") === "product,swarm");
  check("dispatch JSON carries preflight", routed.results[0]?.product_gate?.evidence.sha256 === pass.evidence.sha256);

  process.env.SF_PRESPEC = "1";
  process.env.FACTORY_PRODUCT_GATE_ENFORCE = "1";
  let prespecGateCalls = 0;
  let interviews = 0;
  const prespecTicket = {
    ...baseTicket,
    state_type: "backlog",
    priority: 1,
  };
  const prespecDeps: Partial<RunDeps> = {
    fetchPullable: async () => [prespecTicket],
    productGate: async () => enforceHold,
    gateFn: () => {
      prespecGateCalls++;
      return "SWARM";
    },
    interview: async () => {
      interviews++;
    },
    nowMs: Date.now(),
  };
  const prespecResult = await run({ dryRun: false, topOverride: 1, deps: prespecDeps });
  check("enforced hold cannot reach prespec gate", prespecGateCalls === 0 && interviews === 0);
  check("prespec reports product-held identifier", prespecResult.product_gate_held?.[0] === baseTicket.identifier);

  section("source-level production ordering");
  const dispatcherSource = readFileSync(join(import.meta.dir, "dispatcher.ts"), "utf8");
  const prespecSource = readFileSync(join(import.meta.dir, "prespec-runner.ts"), "utf8");
  const swarmSource = readFileSync(join(import.meta.dir, "swarm-exec.ts"), "utf8");
  const shippingSource = readFileSync(join(import.meta.dir, "ship-ready-runner.ts"), "utf8");
  const dispatchProduct = dispatcherSource.indexOf("await productPreflight(ticket)");
  const dispatchDedup = dispatcherSource.indexOf("let dedup: DedupDecision", dispatchProduct);
  const dispatchSwarm = dispatcherSource.indexOf("swarmGate(summary)", dispatchProduct);
  check("preflight precedes dedup and routing", dispatchProduct >= 0 && dispatchProduct < dispatchDedup && dispatchDedup < dispatchSwarm);
  check(
    "prespec evaluates product gate before candidate selection",
    prespecSource.indexOf("await deps.productGate(ticket") < prespecSource.indexOf("selectPrespecCandidates(productEligible"),
  );
  const launchCall = swarmSource.indexOf("runProductLaunchGate(d.ticket");
  const manifestCall = swarmSource.indexOf("const manifest = createEvidenceManifest", launchCall);
  check("launch audit precedes evidence manifest", launchCall >= 0 && launchCall < manifestCall);
  check("swarm execution cannot bypass promotion through SF-010", !swarmSource.includes("sf010PostExecHook"));
  check("shipping opens a draft for the separate promotion gate", shippingSource.includes('"--draft"') && !shippingSource.includes('"pr", "merge"'));
  check("report artifact enters evidence manifest", swarmSource.includes("...productGateArtifact(exec.product_gate?.launch)"));
} finally {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(sandbox, { recursive: true, force: true });
}

console.log(`\nproduct-lifecycle-gate selftest: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
