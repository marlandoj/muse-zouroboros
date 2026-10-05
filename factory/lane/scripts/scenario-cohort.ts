#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { activeActorTwinPorts, actorSha256, parseActorSystemManifest } from "./actor-system-twin.ts";
import { createHoldoutFingerprint, evaluateHoldoutContamination, finalizeHoldoutManifest } from "./heldout-cohort.ts";
import { canonicalize } from "./run-receipt-contract.ts";
import { runScenario, type ScenarioRunRecord } from "./scenario-run.ts";
import { activeTrajectoryVerifierPorts, activeTrajectoryVerifierRoots, activeTrajectoryVerifierWorkers } from "./trajectory-verifier-runtime.ts";

export interface CohortSummary {
  manifestHash: string;
  contracts: number;
  seeds: number;
  expectedRuns: number;
  completedRuns: number;
  expectedTerminals: number;
  validReceipts: number;
  cleanupChecks: number;
  networkChecks: number;
  secretStrippingChecks: number;
  canonicalReports: number;
  completeReproductions: number;
  verifierCleanupChecks: number;
  boundaryViolations: number;
  answerRecoveryViolations: number;
  contaminationDetections: number;
  baselineBefore: Record<string, string>;
  baselineAfter: Record<string, string>;
  baselineRestored: boolean;
  linearBaselinePassed: boolean;
}

export interface CohortOptions {
  manifestPath: string;
  expectedManifestHash: string;
  approvalSeedHash: string;
  stateRoot: string;
  runsPath: string;
  evaluatedCommit: string;
}

const HASH = /^[0-9a-f]{64}$/;
const EXPECTED_CONTRACTS = 20;
const EXPECTED_SEEDS = 3;
const EXPECTED_RUNS = 60;

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sf009Workdirs(): string[] {
  return readdirSync(tmpdir()).filter((name) => name.startsWith("sf009-")).sort();
}

function sourceBaseline(): Record<string, string> {
  return Object.fromEntries([
    "scenario-spec.ts",
    "scenario-run.ts",
  ].map((name) => [name, sha256(readFileSync(join(import.meta.dir, name)))]));
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

export async function runActorSystemCohort(options: CohortOptions): Promise<CohortSummary> {
  if (!HASH.test(options.expectedManifestHash) || !HASH.test(options.approvalSeedHash)) throw new Error("cohort authority hashes must be lowercase SHA-256");
  const root = resolve(options.stateRoot);
  const tempRoot = `${resolve(tmpdir())}/`;
  if (!root.startsWith(tempRoot)) throw new Error("cohort stateRoot must be disposable temp state");
  if (!existsSync(options.manifestPath)) throw new Error("cohort manifest is unavailable");
  const manifestBytes = readFileSync(options.manifestPath);
  const manifestHash = sha256(manifestBytes);
  if (manifestHash !== options.expectedManifestHash) throw new Error("cohort manifest hash mismatch");
  const manifest = parseActorSystemManifest(JSON.parse(manifestBytes.toString("utf8")));
  if (manifest.contracts.length !== EXPECTED_CONTRACTS || manifest.replicateSeeds.length !== EXPECTED_SEEDS
    || manifest.contracts.length * manifest.replicateSeeds.length !== EXPECTED_RUNS) {
    throw new Error("cohort must contain exactly 20 contracts x 3 registered seeds");
  }
  const holdout = finalizeHoldoutManifest([createHoldoutFingerprint({
    itemId: "zou-1057-synthetic-holdout",
    version: "v1",
    plaintext: "quasar juniper cobalt atlas lumen orchard vertex mosaic tundra harbor",
    createdAt: "2026-08-01T00:00:00.000Z",
    expiresAt: "2026-12-01T00:00:00.000Z",
  })]);
  const baselineBefore = sourceBaseline();
  const beforeWorkdirs = sf009Workdirs();
  const specsRoot = join(root, "specs");
  mkdirSync(specsRoot, { recursive: true });
  const saved = Object.fromEntries([
    "SF009_SCENARIOS", "SF009_ACTOR_TWINS", "SF009_TRAJECTORY_VERIFIER", "SF009_RUNS_PATH", "SF009_SCENARIO_MANIFEST_SHA256",
    "SF009_EVALUATED_COMMIT", "FACTORY_STATE_DIR", "FACTORY_STATE_MODE", "FACTORY_STATE_ALLOW_OUTSIDE_ROOT",
  ].map((name) => [name, process.env[name]]));
  const records: ScenarioRunRecord[] = [];
  let contaminationDetections = 0;
  let cleanupChecks = 0;
  let verifierCleanupChecks = 0;
  try {
    process.env.SF009_SCENARIOS = "1";
    process.env.SF009_ACTOR_TWINS = "1";
    process.env.SF009_RUNS_PATH = resolve(options.runsPath);
    process.env.SF009_SCENARIO_MANIFEST_SHA256 = manifestHash;
    process.env.SF009_EVALUATED_COMMIT = options.evaluatedCommit;
    process.env.FACTORY_STATE_DIR = root;
    process.env.FACTORY_STATE_MODE = "test";
    process.env.FACTORY_STATE_ALLOW_OUTSIDE_ROOT = "1";

    for (const contract of manifest.contracts) {
      const contamination = evaluateHoldoutContamination(canonicalize(contract), holdout, "2026-08-20T00:00:00.000Z");
      if (contamination.disposition !== "clear") contaminationDetections++;
      for (const seed of manifest.replicateSeeds) {
        const approval = contract.approval === "required_allow" ? "allow" : "deny";
        const requestId = `${contract.id}-${seed}`;
        const command = `bun -e 'const u=process.env.ACTOR_SYSTEM_TWIN_URL;if(!u)process.exit(11);for(const k of ["LINEAR_API_KEY","ZO_API_KEY","ANTHROPIC_API_KEY","STRIPE_SECRET_KEY"])if(process.env[k])process.exit(12);const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({requestId:"${requestId}",approval:"${approval}"})});const j=await r.json();console.log("terminal="+j.terminal);try{await fetch("https://example.com",{signal:AbortSignal.timeout(1000)});console.log("EGRESS-OPEN")}catch{console.log("egress-refused")}console.log("secret-stripped")'`;
        const spec = {
          scenario_id: `actor-${contract.id}-${seed}`.slice(0, 64),
          description: "ZOU-1057 approved synthetic actor-system cohort",
          seed,
          twin: {
            kind: "actor-system",
            fixture: resolve(options.manifestPath),
            contract_id: contract.id,
            authority_kind: "approved_manifest",
            manifest_sha256: manifestHash,
            contract_sha256: actorSha256(contract),
            review_sha256: options.approvalSeedHash,
          },
          trajectory_verifier: {
            mode: "advisory",
            generator_model_id: "generator-stub-v1",
            generator_prompt_sha256: sha256(`generator-prompt:${contract.id}`),
            generator_history_sha256: sha256(`generator-history:${contract.id}:${seed}`),
            verifier_model_id: "verifier-stub-v1",
            verifier_prompt_sha256: sha256(`verifier-prompt:${contract.id}`),
            verifier_history_sha256: sha256(`verifier-history:${contract.id}:${seed}`),
            rubric_sha256: sha256("zou-1058-trajectory-rubric-v1"),
            qualitative_score: 1,
            qualitative_confidence: 0.95,
            qualitative_rationale_sha256: sha256(`qualitative-rationale:${contract.id}:${seed}`),
          },
          steps: [{
            name: "execute",
            run: command,
            timeout_ms: 15_000,
            expect: { exit_code: 0, stdout_contains: [`terminal=${contract.expectedTerminal}`, "egress-refused", "secret-stripped"] },
          }],
        };
        const specPath = join(specsRoot, `${contract.id}-${seed}.json`);
        writeFileSync(specPath, `${canonicalize(spec)}\n`, { mode: 0o600 });
        const record = await runScenario(specPath);
        records.push(record);
        if (record.verdict !== "passed") throw new Error(`cohort run failed: ${record.scenario_id} ${record.failures.join("; ")}`);
        if (activeActorTwinPorts().length !== 0 || canonicalize(sf009Workdirs()) !== canonicalize(beforeWorkdirs)) {
          throw new Error(`cohort cleanup failed after ${record.scenario_id}`);
        }
        cleanupChecks++;
        if (activeTrajectoryVerifierPorts().length !== 0 || activeTrajectoryVerifierRoots().length !== 0 || activeTrajectoryVerifierWorkers() !== 0) {
          throw new Error(`trajectory verifier cleanup failed after ${record.scenario_id}`);
        }
        verifierCleanupChecks++;
      }
    }

    const linearRecord = await runScenario(join(import.meta.dir, "..", "scenarios", "linear-pull-smoke.yaml"));
    const baselineAfter = sourceBaseline();
    return {
      manifestHash,
      contracts: manifest.contracts.length,
      seeds: manifest.replicateSeeds.length,
      expectedRuns: EXPECTED_RUNS,
      completedRuns: records.length,
      expectedTerminals: records.filter((record) => record.verdict === "passed").length,
      validReceipts: records.filter((record) => HASH.test(record.run_receipt_hash ?? "") && Boolean(record.run_receipt_id)).length,
      cleanupChecks,
      networkChecks: records.filter((record) => record.verdict === "passed").length,
      secretStrippingChecks: records.filter((record) => record.verdict === "passed").length,
      canonicalReports: records.filter((record) => HASH.test(record.trajectory_report_hash ?? "") && Boolean(record.trajectory_report_id)).length,
      completeReproductions: records.filter((record) => record.trajectory_disposition === "PASS" && record.trajectory_reproduction_ratio === 1).length,
      verifierCleanupChecks,
      boundaryViolations: records.filter((record) => (record.trajectory_uncertainty_count ?? 0) > 0).length,
      answerRecoveryViolations: records.filter((record) => record.trajectory_disposition !== "PASS").length,
      contaminationDetections,
      baselineBefore,
      baselineAfter,
      baselineRestored: canonicalize(baselineBefore) === canonicalize(baselineAfter),
      linearBaselinePassed: linearRecord.verdict === "passed" && linearRecord.twin === "linear",
    };
  } finally {
    rmSync(specsRoot, { recursive: true, force: true });
    restoreEnv(saved);
    if (activeActorTwinPorts().length !== 0) throw new Error("actor-system ports remain active after cohort cleanup");
    if (activeTrajectoryVerifierPorts().length !== 0 || activeTrajectoryVerifierRoots().length !== 0 || activeTrajectoryVerifierWorkers() !== 0) {
      throw new Error("trajectory verifier resources remain active after cohort cleanup");
    }
  }
}

function option(args: string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1];
}

if (import.meta.main) {
  if (process.env.SF009_SCENARIOS !== "1" || process.env.SF009_ACTOR_TWINS !== "1") process.exit(0);
  try {
    const args = process.argv.slice(2);
    if (args[0] !== "run") throw new Error("usage: scenario-cohort.ts run --manifest <json> --manifest-sha256 <hash> --approval-sha256 <hash> --root <dir> --runs <jsonl> --commit <sha> [--summary <json>]");
    const summary = await runActorSystemCohort({
      manifestPath: option(args, "--manifest"),
      expectedManifestHash: option(args, "--manifest-sha256"),
      approvalSeedHash: option(args, "--approval-sha256"),
      stateRoot: option(args, "--root"),
      runsPath: option(args, "--runs"),
      evaluatedCommit: option(args, "--commit"),
    });
    const summaryIndex = args.indexOf("--summary");
    if (summaryIndex >= 0) {
      const path = args[summaryIndex + 1];
      if (!path) throw new Error("missing --summary");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${canonicalize(summary)}\n`, { mode: 0o600 });
    }
    console.log(canonicalize(summary));
  } catch (error) {
    console.error(String(error));
    process.exit(1);
  }
}
