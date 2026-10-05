import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProductionGitHubEdgeAdapter,
  createProductionWorkspaceEdgeAdapter,
  runBoundedGitHubGet,
} from "./run-edge-proof-adapters";
import { canonicalize } from "./run-receipt-contract";
import { hashEdgeTarget, type EdgeProbeRequest } from "./run-edge-proof";

const NOW = "2026-08-11T20:00:00.000Z";
const ACTOR = "a".repeat(64);
const TICKET = "5fe149b9-c520-4ecf-a96f-bc82ae145cc1";
let root = "";
let stateDir = "";
let lanePath = "";

function hash(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalize(value)).digest("hex");
}

function request(targetRef: string, expectedState: unknown): EdgeProbeRequest {
  return {
    operationId: "op-A0000000000000000000000000",
    traceId: "trace",
    actorHash: ACTOR,
    planCreatedAt: NOW,
    targetRef,
    targetHash: hashEdgeTarget(targetRef),
    expectedStateHash: hash(expectedState),
    attempt: 1,
    timeoutMs: 100,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "zou-1055-adapters-"));
  stateDir = join(root, "state");
  lanePath = join(root, "lane.jsonl");
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("production workspace edge adapter", () => {
  test("resolves scheduled lane outcomes from the durable ledger", async () => {
    writeFileSync(lanePath, `${JSON.stringify({ schema: 1, cycle_id: "cycle-1", phase: "outcome", reason: "empty_queue", ticket_id: null, identifier: null, execution_id: null, detail: null, ts: NOW })}\n`);
    const adapter = createProductionWorkspaceEdgeAdapter({ stateDir, laneLedgerPath: lanePath, now: () => NOW });
    const result = await adapter.probe(request("lane:cycle-1:outcome", { cycle_id: "cycle-1", phase: "outcome" }));
    expect(result).toMatchObject({ status: "confirmed", acknowledgementTier: "durable_confirmed" });
    expect(JSON.stringify(result)).not.toContain(lanePath);
  });

  test("binds a factory target to one terminal execution and lane outcome", async () => {
    writeFileSync(lanePath, `${JSON.stringify({ schema: 1, cycle_id: "cycle-2", phase: "outcome", reason: "dispatched", ticket_id: TICKET, identifier: "ZOU-1055", execution_id: "exec-1", detail: null, ts: NOW })}\n`);
    writeFileSync(join(stateDir, "exec-exec-1.json"), JSON.stringify({ execution_id: "exec-1", ticket_id: TICKET, identifier: "ZOU-1055", state: "verified", completed_at: NOW }));
    const adapter = createProductionWorkspaceEdgeAdapter({ stateDir, laneLedgerPath: lanePath, now: () => NOW });
    const result = await adapter.probe(request(`factory:${TICKET}:cycle-2`, { cycle_id: "cycle-2", ticket_id: TICKET, terminal: true }));
    expect(result).toMatchObject({ status: "confirmed", providerEventId: "execution:exec-1" });
    expect(JSON.stringify(result)).not.toContain(stateDir);
  });

  test("resolves execution and shipping receipts without accepting mismatched state", async () => {
    writeFileSync(join(stateDir, "exec-exec-2.json"), JSON.stringify({ execution_id: "exec-2", state: "failed", completed_at: NOW }));
    writeFileSync(join(stateDir, "shipping-request-exec-2.json"), JSON.stringify({ execution_id: "exec-2", status: "succeeded", attempt_count: 2, outcome: "merge_queued", updated_at: NOW }));
    const adapter = createProductionWorkspaceEdgeAdapter({ stateDir, laneLedgerPath: lanePath, now: () => NOW });
    expect(await adapter.probe(request("execution:exec-2", { execution_id: "exec-2", terminal: true }))).toMatchObject({ status: "confirmed" });
    expect(await adapter.probe(request("shipping:exec-2:attempt:2", { execution_id: "exec-2", status: "succeeded", attempt_count: 2, outcome: "merge_queued" }))).toMatchObject({ status: "confirmed" });
    expect(await adapter.probe(request("execution:exec-2", { execution_id: "exec-2", terminal: false }))).toMatchObject({ status: "unavailable", reasonCode: "edge_state_mismatch" });
  });

  test("rejects durable records that predate the proof plan", async () => {
    writeFileSync(lanePath, `${JSON.stringify({ schema: 1, cycle_id: "cycle-old", phase: "outcome", reason: "empty_queue", ticket_id: null, identifier: null, execution_id: null, detail: null, ts: "2026-08-11T19:59:59.999Z" })}\n`);
    const adapter = createProductionWorkspaceEdgeAdapter({ stateDir, laneLedgerPath: lanePath, now: () => NOW });
    expect(await adapter.probe(request("lane:cycle-old:outcome", { cycle_id: "cycle-old", phase: "outcome" }))).toMatchObject({
      status: "unavailable",
      reasonCode: "workspace_record_historical",
    });
  });
});

describe("production GitHub edge adapter", () => {
  test("performs exactly one bounded GET and persists only normalized hashes", async () => {
    const repositoryPath = "/home/workspace/zouroboros";
    const repositoryHash = hash(repositoryPath);
    writeFileSync(join(stateDir, "exec-exec-gh.json"), JSON.stringify({ execution_id: "exec-gh", identifier: "ZOU-1055", repo_path: repositoryPath }));
    writeFileSync(join(stateDir, "shipping-request-exec-gh.json"), JSON.stringify({
      execution_id: "exec-gh",
      status: "succeeded",
      attempt_count: 1,
      outcome: "merge_queued",
      pr_number: 510,
      pr_url: "https://github.com/marlandoj/zouroboros/pull/510",
      repo_path: repositoryPath,
      updated_at: NOW,
    }));
    const calls: Array<{ program: string; args: readonly string[]; timeoutMs: number }> = [];
    const adapter = createProductionGitHubEdgeAdapter({
      stateDir,
      now: () => NOW,
      command: (program, args, timeoutMs) => {
        calls.push({ program, args, timeoutMs });
        return {
          status: 0,
          stdout: JSON.stringify({ number: 510, state: "open", merged: false, head: { sha: "d".repeat(40) }, html_url: "https://github.com/marlandoj/zouroboros/pull/510", body: "secret provider content" }),
          stderr: "",
        };
      },
    });
    const targetRef = `github:${repositoryHash}:exec-gh`;
    const result = await adapter.probe(request(targetRef, { repository_hash: repositoryHash, execution_id: "exec-gh", user_visible: true }));
    expect(calls).toEqual([{ program: "gh", args: ["api", "--method", "GET", "repos/marlandoj/zouroboros/pulls/510"], timeoutMs: 100 }]);
    expect(result).toMatchObject({ status: "confirmed", acknowledgementTier: "user_visible_confirmed" });
    const persisted = JSON.stringify(result);
    expect(persisted).not.toContain("github.com");
    expect(persisted).not.toContain(repositoryPath);
    expect(persisted).not.toContain("secret provider content");
  });

  test("rejects mutation endpoints and repository identity drift before command execution", async () => {
    expect(() => runBoundedGitHubGet(() => ({ status: 0, stdout: "{}", stderr: "" }), "repos/o/r/issues/1/comments", 100)).toThrow("endpoint is invalid");
    let calls = 0;
    writeFileSync(join(stateDir, "exec-exec-drift.json"), JSON.stringify({ execution_id: "exec-drift", repo_path: "/repo/actual" }));
    writeFileSync(join(stateDir, "shipping-request-exec-drift.json"), JSON.stringify({ execution_id: "exec-drift", pr_number: 1, pr_url: "https://github.com/o/r/pull/1", updated_at: NOW }));
    const adapter = createProductionGitHubEdgeAdapter({ stateDir, now: () => NOW, command: () => { calls++; return { status: 0, stdout: "{}", stderr: "" }; } });
    const targetRef = `github:${hash("/repo/other")}:exec-drift`;
    expect(await adapter.probe(request(targetRef, { repository_hash: hash("/repo/other"), execution_id: "exec-drift", user_visible: true }))).toMatchObject({ status: "unavailable", reasonCode: "github_repository_mismatch" });
    expect(calls).toBe(0);
  });

  test("requires a bounded response with an immutable GitHub head revision", async () => {
    const repositoryPath = "/home/workspace/zouroboros";
    const repositoryHash = hash(repositoryPath);
    writeFileSync(join(stateDir, "exec-exec-head.json"), JSON.stringify({ execution_id: "exec-head", repo_path: repositoryPath }));
    writeFileSync(join(stateDir, "shipping-request-exec-head.json"), JSON.stringify({
      execution_id: "exec-head",
      pr_number: 510,
      pr_url: "https://github.com/marlandoj/zouroboros/pull/510",
      repo_path: repositoryPath,
      updated_at: NOW,
    }));
    const targetRef = `github:${repositoryHash}:exec-head`;
    const expected = { repository_hash: repositoryHash, execution_id: "exec-head", user_visible: true };
    const missingHead = createProductionGitHubEdgeAdapter({
      stateDir,
      now: () => NOW,
      command: () => ({ status: 0, stdout: JSON.stringify({ number: 510, state: "open" }), stderr: "sensitive stderr" }),
    });
    expect(await missingHead.probe(request(targetRef, expected))).toMatchObject({ status: "unavailable", reasonCode: "github_source_revision_missing" });
    const oversized = createProductionGitHubEdgeAdapter({
      stateDir,
      now: () => NOW,
      command: () => ({ status: 0, stdout: "x".repeat(64 * 1024 + 1), stderr: "sensitive stderr" }),
    });
    const result = await oversized.probe(request(targetRef, expected));
    expect(result).toMatchObject({ status: "unavailable", reasonCode: "github_response_too_large" });
    expect(JSON.stringify(result)).not.toContain("sensitive stderr");
  });
});
