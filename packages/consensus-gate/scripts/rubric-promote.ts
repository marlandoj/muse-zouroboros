#!/usr/bin/env bun
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  decideRubricPromotion,
  sha256,
  type GovernanceArtifact,
  type RegressionEvidence,
} from "./dataset-governance";

interface PromotionRequest {
  governance: GovernanceArtifact;
  proposed_rubric_path: string;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (import.meta.main) {
  const requestPath = argument("--request");
  const evidencePath = argument("--evidence");
  const reviewer = argument("--by") || "";
  const approved = process.argv.includes("--approve");
  if (!requestPath || !evidencePath || reviewer === "") {
    console.error("usage: rubric-promote.ts --request <json> --evidence <json> --by <reviewer> [--approve]");
    process.exit(2);
  }
  const request = JSON.parse(readFileSync(requestPath, "utf8")) as PromotionRequest;
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8")) as RegressionEvidence;
  const observedRubricHash = sha256(readFileSync(request.proposed_rubric_path, "utf8"));
  if (observedRubricHash !== request.governance.rubric.content_sha256) {
    console.error(JSON.stringify({ status: "rejected", reasons: ["proposed rubric hash mismatch"] }));
    process.exit(1);
  }
  const decision = decideRubricPromotion({
    governance: request.governance,
    evidence,
    human: { approved, reviewed_by: reviewer, reviewed_at: new Date().toISOString() },
  });
  const decisionPath = join(dirname(requestPath), `${basename(requestPath, ".json")}.decision.json`);
  writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`);
  if (decision.status === "promoted") {
    const promotedPath = request.proposed_rubric_path.replace(/\.proposed\.md$/, ".promoted.md");
    copyFileSync(request.proposed_rubric_path, promotedPath);
    console.log(JSON.stringify({ ...decision, decision_path: decisionPath, promoted_rubric_path: promotedPath }));
    process.exit(0);
  }
  console.error(JSON.stringify({ ...decision, decision_path: decisionPath }));
  process.exit(1);
}
