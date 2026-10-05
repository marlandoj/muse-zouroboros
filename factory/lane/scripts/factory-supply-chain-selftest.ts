import { parseSupplyChainOutput, runSupplyChainPreflight } from "./factory-supply-chain";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildAttestation, sourceDigest } from "../../../Skills/skill-security-gate/scripts/supply-chain/attestation";
import type { SupplyChainReport } from "../../../Skills/skill-security-gate/scripts/supply-chain/types";

let failures = 0;
function check(name: string, condition: boolean): void {
  if (!condition) failures++;
  console.log(`${condition ? "PASS" : "FAIL"} ${name}`);
}

const dir = mkdtempSync(join(tmpdir(), "supply-selftest-"));
const reportPath = join(dir, "report.json");
const attestationPath = join(dir, "attestation.json");
const report: SupplyChainReport = {
  check: "supply-chain", timestamp: "2026-07-11T00:00:00Z", checksRun: ["action-pin"], findings: [],
  summary: { critical: 0, warning: 0, info: 0 }, passed: true,
};
const digest = sourceDigest(report);
writeFileSync(reportPath, JSON.stringify(report));
writeFileSync(attestationPath, JSON.stringify(buildAttestation(report, report.timestamp, reportPath)));
const pass = parseSupplyChainOutput({
  status: 0,
  stdout: `Attestation: ${attestationPath}\nAttestation digest: ${digest}\nMCP review required: 0`,
  stderr: "",
}, "blocking");
check("valid attestation passes", pass.status === "pass" && !pass.blocked && pass.attestation_hash === digest);

const advisory = parseSupplyChainOutput({ status: 1, stdout: "", stderr: "critical" }, "advisory");
check("legacy advisory failure does not block", advisory.status === "fail" && !advisory.blocked);

const blocking = parseSupplyChainOutput({ status: 1, stdout: "", stderr: "critical" }, "blocking");
check("new-contract critical failure blocks", blocking.status === "fail" && blocking.blocked);

const reviewReportPath = join(dir, "review-report.json");
const reviewAttestationPath = join(dir, "review-attestation.json");
const reviewReport: SupplyChainReport = {
  check: "supply-chain", timestamp: report.timestamp, checksRun: ["mcp-policy"],
  findings: [0, 1].map((i) => ({ target: `mcp-${i}`, category: "mcp-policy", severity: "warning", finding: "restricted", evidence: "policy", remediation: "review" })),
  summary: { critical: 0, warning: 2, info: 0 }, passed: true,
};
const reviewDigest = sourceDigest(reviewReport);
writeFileSync(reviewReportPath, JSON.stringify(reviewReport));
writeFileSync(reviewAttestationPath, JSON.stringify(buildAttestation(reviewReport, reviewReport.timestamp, reviewReportPath)));
const unreviewed = parseSupplyChainOutput({ status: 0, stdout: `Attestation: ${reviewAttestationPath}\nAttestation digest: ${reviewDigest}\nMCP review required: 2`, stderr: "" }, "blocking");
check("restricted MCP findings require review", unreviewed.blocked && unreviewed.review_required === 2);
const reviewed = parseSupplyChainOutput(
  { status: 0, stdout: `Attestation: ${reviewAttestationPath}\nAttestation digest: ${reviewDigest}\nMCP review required: 2`, stderr: "" },
  "blocking",
  { by: "operator", note: "inventory approved" },
);
check("operator review releases noncritical MCP findings", !reviewed.blocked && reviewed.reviewed_by === "operator");

let captured: string[] = [];
runSupplyChainPreflight("/repo", "/reports", "blocking", (_command, args) => {
  captured = args;
  return { status: 1, stdout: "", stderr: "blocked" };
});
check("blocking preflight invokes strict attestation", captured.includes("--strict") && captured.includes("--attest"));

writeFileSync(reportPath, JSON.stringify({ ...report, passed: false }));
const tampered = parseSupplyChainOutput({ status: 0, stdout: `Attestation: ${attestationPath}\nAttestation digest: ${digest}\nMCP review required: 0`, stderr: "" }, "blocking");
check("tampered source report blocks", tampered.blocked && tampered.diagnostics.some((line) => line.includes("does not match")));

rmSync(dir, { recursive: true, force: true });

process.exit(failures === 0 ? 0 : 1);
