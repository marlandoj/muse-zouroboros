#!/usr/bin/env bun

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { relative, resolve } from "node:path";

export interface ConsensusReviewer {
  model_id: string;
  vendor: string;
  verdict: string;
}

export interface ConsensusAttestation {
  schema_version: 2;
  ticket: string;
  gate_id: string;
  attested_at: string;
  repository_remote: string;
  base_commit: string;
  implementation_commit: string;
  implementation_diff_sha256: string;
  gate_evidence_hmac: string;
  reviewers: ConsensusReviewer[];
  arbiter: { model_id: "non-llm/arbiter-v1"; verdict: string };
  unanimous: true;
}

export interface ConsensusVerification {
  passed: boolean;
  reason: string;
  attestation: ConsensusAttestation | null;
  path: string | null;
}

interface GateModelEvidence {
  pass?: unknown;
  substituted_from?: unknown;
}

interface GateLedgerEntry {
  consensus_id?: unknown;
  timestamp?: unknown;
  ticket?: unknown;
  repository_remote?: unknown;
  base_commit?: unknown;
  implementation_commit?: unknown;
  status?: unknown;
  input_sha256?: unknown;
  evidence_hmac?: unknown;
  verdict?: {
    pass?: unknown;
    models?: Record<string, GateModelEvidence>;
  };
}

function signedGateEvidence(entry: GateLedgerEntry): object {
  return {
    consensus_id: entry.consensus_id,
    timestamp: entry.timestamp,
    ticket: entry.ticket,
    repository_remote: entry.repository_remote,
    base_commit: entry.base_commit,
    implementation_commit: entry.implementation_commit,
    status: entry.status,
    input_sha256: entry.input_sha256,
    verdict: {
      pass: entry.verdict?.pass,
      models: entry.verdict?.models ?? {},
    },
  };
}

function validEvidenceHmac(entry: GateLedgerEntry, keyPath: string): boolean {
  if (typeof entry.evidence_hmac !== "string" || !/^[a-f0-9]{64}$/i.test(entry.evidence_hmac)) return false;
  if (!existsSync(keyPath)) return false;
  if ((statSync(keyPath).mode & 0o077) !== 0) return false;
  const key = readFileSync(keyPath);
  if (key.length < 32) return false;
  const expected = createHmac("sha256", key).update(JSON.stringify(signedGateEvidence(entry))).digest();
  const actual = Buffer.from(entry.evidence_hmac, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function accepted(verdict: unknown): boolean {
  return typeof verdict === "string" && ["PASS", "ACCEPT"].includes(verdict.trim().toUpperCase());
}

function normalizeRemote(value: string): string {
  return value.trim()
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    .replace(/\.git$/, "")
    .replace(/\/$/, "")
    .toLowerCase();
}

function modelFamily(modelId: string): string | null {
  if (modelId === "non-llm/arbiter-v1") return "arbiter";
  if (modelId === "xai:grok-3-mini") return "grok";
  const catalogPath = modelId.startsWith("byok:")
    ? resolve(import.meta.dir, "../../../Skills/consensus-gate/assets/byok-registry.json")
    : modelId.startsWith("oc:")
      ? resolve(homedir(), ".zouroboros/opencode-catalog.json")
      : /^(?:hf:|syn:)/.test(modelId)
        ? resolve(homedir(), ".zouroboros/synthetic-catalog.json")
        : null;
  if (!catalogPath || !existsSync(catalogPath)) return null;
  try {
    const registry = JSON.parse(readFileSync(catalogPath, "utf8")) as { models?: Array<{ id?: string; family?: string }> };
    const family = registry.models?.find((model) => model.id === modelId)?.family;
    return typeof family === "string" && family.trim() ? family.trim().toLowerCase() : null;
  } catch {
    return null;
  }
}

function readGateLedgerEntry(gateId: string, ledgerPath: string): { entry: GateLedgerEntry | null; corrupt: boolean } {
  if (!existsSync(ledgerPath)) return { entry: null, corrupt: false };
  let match: GateLedgerEntry | null = null;
  let corrupt = false;
  for (const line of readFileSync(ledgerPath, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as GateLedgerEntry;
      if (entry.consensus_id === gateId) match = entry;
    } catch {
      corrupt = true;
    }
  }
  return { entry: match, corrupt };
}

export function validateConsensusAttestation(value: unknown, expectedTicket: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return ["attestation must be an object"];
  const record = value as Record<string, unknown>;
  const errors: string[] = [];
  if (record.schema_version !== 2) errors.push("schema_version must be 2");
  if (typeof record.ticket !== "string" || record.ticket.toUpperCase() !== expectedTicket.toUpperCase()) errors.push(`ticket must equal ${expectedTicket}`);
  if (typeof record.gate_id !== "string" || !/^cg-[a-z0-9-]{8,}$/i.test(record.gate_id)) errors.push("gate_id must be a consensus gate run id");
  if (typeof record.attested_at !== "string" || !Number.isFinite(Date.parse(record.attested_at))) errors.push("attested_at must be an ISO timestamp");
  if (typeof record.repository_remote !== "string" || !record.repository_remote.trim()) errors.push("repository_remote is required");
  if (typeof record.base_commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.base_commit)) errors.push("base_commit must be a full git SHA");
  if (typeof record.implementation_commit !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.implementation_commit)) errors.push("implementation_commit must be a full git SHA");
  if (typeof record.implementation_diff_sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(record.implementation_diff_sha256)) errors.push("implementation_diff_sha256 must be SHA-256");
  if (typeof record.gate_evidence_hmac !== "string" || !/^[a-f0-9]{64}$/i.test(record.gate_evidence_hmac)) errors.push("gate_evidence_hmac must be SHA-256 HMAC");
  if (record.unanimous !== true) errors.push("unanimous must be true");
  if (!record.arbiter || typeof record.arbiter !== "object" || Array.isArray(record.arbiter)) {
    errors.push("arbiter is required");
  } else {
    const arbiter = record.arbiter as Record<string, unknown>;
    if (arbiter.model_id !== "non-llm/arbiter-v1") errors.push("arbiter model_id must be non-llm/arbiter-v1");
    if (arbiter.verdict !== "PASS") errors.push("arbiter verdict must be PASS");
  }

  if (!Array.isArray(record.reviewers) || record.reviewers.length !== 3) {
    errors.push("exactly three substantive reviewers are required");
  } else {
    const modelIds = new Set<string>();
    const vendors = new Set<string>();
    for (const [index, reviewer] of record.reviewers.entries()) {
      if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) {
        errors.push(`reviewer ${index + 1} must be an object`);
        continue;
      }
      const item = reviewer as Record<string, unknown>;
      const modelId = typeof item.model_id === "string" ? item.model_id.trim() : "";
      const vendor = typeof item.vendor === "string" ? item.vendor.trim().toLowerCase() : "";
      if (!modelId) errors.push(`reviewer ${index + 1} model_id is required`);
      else if (modelIds.has(modelId)) errors.push(`reviewer model_ids must be distinct: ${modelId}`);
      else modelIds.add(modelId);
      const expectedVendor = modelId ? modelFamily(modelId) : null;
      if (!expectedVendor) errors.push(`reviewer ${index + 1} model family is unknown`);
      else if (vendor !== expectedVendor) errors.push(`reviewer ${index + 1} vendor must equal ${expectedVendor}`);
      else if (vendors.has(vendor)) errors.push(`reviewer vendors must be distinct: ${vendor}`);
      else vendors.add(vendor);
      if (!accepted(item.verdict)) errors.push(`reviewer ${index + 1} verdict must be PASS or ACCEPT`);
    }
  }
  return errors;
}

function verifyCommitAndLedgerBinding(
  attestation: ConsensusAttestation,
  attestationPath: string,
  repoDir: string,
  ledgerPath: string,
  keyPath: string,
): string[] {
  const errors: string[] = [];
  const repo = realpathSync(repoDir);
  const path = realpathSync(attestationPath);
  const relPath = relative(repo, path).replaceAll("\\", "/");
  if (relPath.startsWith("../") || relPath === "..") return ["attestation path is outside target repository"];
  if (!/^evaluations\/.+-consensus-attestation\.json$/.test(relPath)) errors.push("attestation must live under evaluations/*-consensus-attestation.json");

  const dirty = execFileSync("git", ["status", "--porcelain"], { cwd: repo, encoding: "utf8" }).trim();
  if (dirty) errors.push("target repository has uncommitted changes");
  try {
    execFileSync("git", ["ls-files", "--error-unmatch", relPath], { cwd: repo, stdio: "ignore" });
  } catch {
    errors.push("attestation must be tracked in target repository HEAD");
  }

  try {
    for (const commit of [attestation.base_commit, attestation.implementation_commit]) {
      execFileSync("git", ["cat-file", "-e", `${commit}^{commit}`], { cwd: repo, stdio: "ignore" });
    }
    execFileSync("git", ["merge-base", "--is-ancestor", attestation.base_commit, attestation.implementation_commit], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["merge-base", "--is-ancestor", attestation.implementation_commit, "HEAD"], { cwd: repo, stdio: "ignore" });
  } catch {
    errors.push("base_commit and implementation_commit must form an ancestor chain ending at repository HEAD");
    return errors;
  }

  let actualRemote = "";
  try {
    actualRemote = execFileSync("git", ["config", "--get", "remote.origin.url"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    errors.push("target repository has no origin remote");
  }
  if (actualRemote && normalizeRemote(actualRemote) !== normalizeRemote(attestation.repository_remote)) errors.push("repository_remote does not match target repository origin");

  const reviewedDiff = execFileSync("git", ["diff", "--binary", "--full-index", `${attestation.base_commit}..${attestation.implementation_commit}`], { cwd: repo });
  const reviewedHash = createHash("sha256").update(reviewedDiff).digest("hex");
  if (reviewedHash !== attestation.implementation_diff_sha256.toLowerCase()) errors.push("implementation_diff_sha256 does not match the attested git diff");

  const changed = execFileSync("git", ["diff", "--name-only", `${attestation.implementation_commit}..HEAD`], { cwd: repo, encoding: "utf8" })
    .split("\n").map((line) => line.trim()).filter(Boolean);
  const unauthorized = changed.filter((file) => file !== relPath);
  if (unauthorized.length > 0) errors.push(`code changed after attested commit: ${unauthorized.slice(0, 5).join(", ")}`);

  const ledger = readGateLedgerEntry(attestation.gate_id, ledgerPath);
  if (ledger.corrupt) errors.push("consensus gate ledger contains malformed records");
  const gate = ledger.entry;
  if (!gate) return [...errors, `consensus gate ledger entry not found: ${attestation.gate_id}`];
  if (!validEvidenceHmac(gate, keyPath)) errors.push("consensus gate ledger evidence signature is missing or invalid");
  if (gate.evidence_hmac !== attestation.gate_evidence_hmac) errors.push("consensus gate ledger HMAC does not match attestation");
  const gateTs = typeof gate.timestamp === "string" ? Date.parse(gate.timestamp) : Number.NaN;
  const ageMs = Date.now() - gateTs;
  if (!Number.isFinite(gateTs) || ageMs < -5 * 60_000 || ageMs > 7 * 24 * 60 * 60_000) errors.push("consensus gate ledger evidence is stale or has an invalid timestamp");
  if (gate.timestamp !== attestation.attested_at) errors.push("consensus gate ledger timestamp does not match attestation");
  if (gate.ticket !== attestation.ticket) errors.push("consensus gate ledger ticket does not match attestation");
  if (typeof gate.repository_remote !== "string" || normalizeRemote(gate.repository_remote) !== normalizeRemote(attestation.repository_remote)) errors.push("consensus gate ledger repository does not match attestation");
  if (gate.base_commit !== attestation.base_commit) errors.push("consensus gate ledger base commit does not match attestation");
  if (gate.implementation_commit !== attestation.implementation_commit) errors.push("consensus gate ledger implementation commit does not match attestation");
  if (gate.status !== "passed" || gate.verdict?.pass !== true) errors.push("consensus gate ledger entry is not passed");
  if (gate.input_sha256 !== reviewedHash) errors.push("consensus gate reviewed input hash does not match implementation diff");
  const evidence = gate.verdict?.models ?? {};
  const expectedModels = new Set(attestation.reviewers.map((reviewer) => reviewer.model_id));
  expectedModels.add(attestation.arbiter.model_id);
  if (Object.keys(evidence).length !== expectedModels.size || Object.keys(evidence).some((model) => !expectedModels.has(model))) errors.push("attestation reviewer set does not exactly match consensus gate ledger");
  for (const modelId of expectedModels) {
    if (evidence[modelId]?.pass !== true) errors.push(`consensus gate ledger does not contain a passing vote for ${modelId}`);
    if (typeof evidence[modelId]?.substituted_from === "string" && evidence[modelId]?.substituted_from) errors.push(`substituted reviewer evidence is not accepted for ${modelId}`);
  }
  return errors;
}

export function verifyConsensusAttestation(
  attestationPath: string | undefined,
  expectedTicket: string,
  repoDir: string | undefined,
  ledgerPath = resolve(homedir(), ".zouroboros/consensus-gate.log"),
  keyPath = resolve(homedir(), ".zouroboros/consensus-attestation.key"),
): ConsensusVerification {
  if (!attestationPath) return { passed: false, reason: "consensus attestation path not provided", attestation: null, path: null };
  if (!repoDir) return { passed: false, reason: "target repository path not provided", attestation: null, path: resolve(attestationPath) };
  const path = resolve(attestationPath);
  if (!existsSync(path)) return { passed: false, reason: `consensus attestation missing: ${path}`, attestation: null, path };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    return { passed: false, reason: `consensus attestation is unreadable: ${error instanceof Error ? error.message : String(error)}`, attestation: null, path };
  }
  const errors = validateConsensusAttestation(parsed, expectedTicket);
  if (errors.length === 0) {
    try {
      errors.push(...verifyCommitAndLedgerBinding(parsed as ConsensusAttestation, path, repoDir, ledgerPath, keyPath));
    } catch (error) {
      errors.push(`binding verification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (errors.length > 0) return { passed: false, reason: errors.join("; "), attestation: null, path };
  const attestation = parsed as ConsensusAttestation;
  return {
    passed: true,
    reason: `unanimous consensus ${attestation.gate_id}: ${attestation.reviewers.length} vendor-diverse reviewers + arbiter accepted commit ${attestation.implementation_commit.slice(0, 12)}`,
    attestation,
    path,
  };
}
