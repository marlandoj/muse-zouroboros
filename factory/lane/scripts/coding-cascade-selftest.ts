#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  CODING_CASCADE_MODELS,
  captureRepositoryBaseCommit,
  classifyCascadeFailure,
  decideCascadeRetry,
  effectiveCodingModelChain,
  httpFailureKind,
  maxCodingAttempts,
  planCascadeWorktree,
  prepareCascadeWorktree,
  resolveCodingCascadeMode,
} from "./coding-cascade";
import type { ExecutionPolicy } from "./model-policy";
import { activeWorktreeRecords, reclaimIsolatedWorktrees } from "./execution-repository";

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed++;
    console.log(`  PASS ${name}`);
  } else {
    failed++;
    console.error(`  FAIL ${name}${detail ? `: ${detail}` : ""}`);
  }
}

function run(command: string, args: string[], cwd?: string): string {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited ${result.status}`);
  return (result.stdout ?? "").trim();
}

const incumbent = ["legacy-a", "legacy-b", "legacy-c"];
const override: ExecutionPolicy = {
  tier: "Routine",
  pin_proposers: [],
  pin_aggregator: null,
  role_chains: null,
  model_chain: ["override-a", "override-b", "override-c"],
  review_level: "deterministic",
};

console.log("coding cascade self-test");

check("mode defaults to off", resolveCodingCascadeMode({}) === "off");
check("shadow mode parses", resolveCodingCascadeMode({ FACTORY_CODING_CASCADE: "shadow" }) === "shadow");
check("enforce mode parses", resolveCodingCascadeMode({ FACTORY_CODING_CASCADE: "enforce" }) === "enforce");
let invalidRejected = false;
try {
  resolveCodingCascadeMode({ FACTORY_CODING_CASCADE: "on" });
} catch {
  invalidRejected = true;
}
check("invalid mode fails closed", invalidRejected);

check("enforced default has exactly three models", CODING_CASCADE_MODELS.length === 3);
check(
  "enforced primary is exact Opus route",
  effectiveCodingModelChain("enforce", null, incumbent)[0] === "byok:b74479bc-ec30-494d-a8c8-b2ff6218e1c0",
);
check(
  "enforced fallback is exact Sol route",
  effectiveCodingModelChain("enforce", null, incumbent)[1] === "byok:905b6491-3b7f-4ed6-864c-a9817603cb0f",
);
check(
  "enforced final fallback is exact Kimi K2.7-Code route",
  effectiveCodingModelChain("enforce", null, incumbent)[2] === "byok:463350ac-4a49-4ceb-8653-042ecffa513f",
);
check("off preserves incumbent chain", JSON.stringify(effectiveCodingModelChain("off", null, incumbent)) === JSON.stringify(incumbent));
check("shadow preserves incumbent dispatch", JSON.stringify(effectiveCodingModelChain("shadow", null, incumbent)) === JSON.stringify(incumbent));
check("ticket override wins in enforce", JSON.stringify(effectiveCodingModelChain("enforce", override, incumbent)) === JSON.stringify(override.model_chain));
check("shadow evaluates a three-attempt default", maxCodingAttempts("shadow", null, incumbent) === 3);
check("ticket override retains its attempt count", maxCodingAttempts("enforce", override, incumbent) === 3);

const timeout = classifyCascadeFailure({ cause: "timeout" });
const transport = classifyCascadeFailure({ cause: "transport" });
const mechanical = classifyCascadeFailure({
  cause: "worker_failure",
  review: { blocking: true, deterministic: { pass: false, summary: "git diff --check failed" }, consensus: null },
});
const governance = classifyCascadeFailure({
  cause: "worker_failure",
  review: {
    blocking: true,
    deterministic: { pass: true, summary: "passed" },
    consensus: { pass: false, summary: "consensus rejected" },
  },
});
const personaDissent = classifyCascadeFailure({
  cause: "worker_failure",
  review: {
    blocking: true,
    deterministic: { pass: true, summary: "passed" },
    persona_reviews: { mode: "enforce", pass: false, summary: "required persona dissented" },
  },
});
check("timeout is retryable", timeout.retryable && timeout.kind === "timeout");
check("transport is retryable", transport.retryable && transport.kind === "transport");
check("mechanical validation is retryable", mechanical.retryable && mechanical.kind === "mechanical_validation");
check("governance rejection is terminal", !governance.retryable && governance.kind === "governance");
check("persona diversity dissent is terminal governance", !personaDissent.retryable && personaDissent.kind === "governance");
for (const kind of ["authorization", "policy", "unsafe_scope", "worker_failure", "unknown"] as const) {
  check(`${kind} is terminal`, !classifyCascadeFailure({ cause: kind }).retryable);
}

check(
  "shadow records without acting",
  decideCascadeRetry({ mode: "shadow", failure: timeout, attempts_made: 1, max_attempts: 2 }).action === "would_retry",
);
check(
  "enforce retries first retryable failure",
  decideCascadeRetry({ mode: "enforce", failure: transport, attempts_made: 1, max_attempts: 3 }).action === "retry",
);
check(
  "enforce reaches the final fallback after two retryable failures",
  decideCascadeRetry({ mode: "enforce", failure: transport, attempts_made: 2, max_attempts: 3 }).action === "retry",
);
check(
  "enforce exhausts after the Kimi fallback",
  decideCascadeRetry({ mode: "enforce", failure: transport, attempts_made: 3, max_attempts: 3 }).action === "exhausted",
);
check(
  "enforce never retries governance",
  decideCascadeRetry({ mode: "enforce", failure: governance, attempts_made: 1, max_attempts: 2 }).action === "terminal",
);
check("HTTP authorization classification", httpFailureKind(401) === "authorization");
check("HTTP policy classification", httpFailureKind(400) === "policy");
check("HTTP rate-limit classification", httpFailureKind(429) === "transport");
check("HTTP server classification", httpFailureKind(502) === "transport");

const plannedWithDoubles = planCascadeWorktree("/virtual/workspace/repo", "virtual-a0", {
  workspaceRoot: "/virtual/workspace",
  worktreesRoot: "/virtual/workspace/missing/nested/worktrees",
  exists: (path) => path === "/virtual",
  realpath: (path) => path,
});
check(
  "prospective canonicalization supports injected filesystem doubles",
  plannedWithDoubles === "/virtual/workspace/missing/nested/worktrees/cascade-repo-virtual-a0",
);
let rootTerminationRejected = false;
try {
  planCascadeWorktree("/virtual/repo", "rootless-a0", {
    workspaceRoot: "/virtual/workspace",
    exists: () => false,
    realpath: (path) => path,
  });
} catch {
  rootTerminationRejected = true;
}
check("prospective canonicalization fails closed at filesystem root", rootTerminationRejected);

const root = mkdtempSync(join(tmpdir(), "coding-cascade-selftest-"));
try {
  const repository = join(root, "repo");
  run("git", ["init", "-q", repository]);
  run("git", ["config", "user.email", "cascade-selftest@example.invalid"], repository);
  run("git", ["config", "user.name", "Cascade Selftest"], repository);
  writeFileSync(join(repository, "tracked.txt"), "base\n");
  run("git", ["add", "tracked.txt"], repository);
  run("git", ["commit", "-qm", "base"], repository);
  const baseCommit = captureRepositoryBaseCommit(repository);
  const worktreesRoot = join(root, "worktrees");
  const common = { workspaceRoot: root, worktreesRoot };
  const primary = prepareCascadeWorktree({
    repository,
    base_commit: baseCommit,
    assignment_id: "primary-a0",
    options: common,
  });
  writeFileSync(join(primary, "tracked.txt"), "unverified primary diff\n");
  const fallback = prepareCascadeWorktree({
    repository,
    base_commit: baseCommit,
    assignment_id: "fallback-a1",
    options: common,
  });
  check("fallback worktree differs from primary", primary !== fallback);
  check("fallback starts from recorded base", run("git", ["rev-parse", "HEAD"], fallback) === baseCommit);
  check("fallback excludes primary diff", readFileSync(join(fallback, "tracked.txt"), "utf8") === "base\n");
  check("fallback worktree is clean", run("git", ["status", "--porcelain"], fallback) === "");
  let dirtyReuseRejected = false;
  try {
    prepareCascadeWorktree({ repository, base_commit: baseCommit, assignment_id: "primary-a0", options: common });
  } catch {
    dirtyReuseRejected = true;
  }
  check("dirty worktree reuse fails closed", dirtyReuseRejected);
  const active = activeWorktreeRecords({ workspaceRoot: root });
  check("cascade attempts share the factory cleanup ledger", active.length === 2);
  const reclaimed = reclaimIsolatedWorktrees({ workspaceRoot: root });
  check("factory cleanup reclaims the clean fallback", reclaimed.removed.includes(fallback));
  check("factory cleanup preserves the dirty primary for recovery", reclaimed.kept.includes(primary));
  check("cleanup leaves only the dirty evidence worktree", existsSync(primary) && !existsSync(fallback));
} finally {
  rmSync(root, { recursive: true, force: true });
}

const aliasRoot = mkdtempSync(join(tmpdir(), "coding-cascade-alias-selftest-"));
try {
  const physicalWorkspace = join(aliasRoot, "physical-workspace");
  const workspaceAlias = join(aliasRoot, "workspace-alias");
  mkdirSync(physicalWorkspace);
  symlinkSync(physicalWorkspace, workspaceAlias, "dir");

  const repository = join(physicalWorkspace, "repo");
  run("git", ["init", "-q", repository]);
  run("git", ["config", "user.email", "cascade-selftest@example.invalid"], repository);
  run("git", ["config", "user.name", "Cascade Selftest"], repository);
  writeFileSync(join(repository, "tracked.txt"), "alias base\n");
  run("git", ["add", "tracked.txt"], repository);
  run("git", ["commit", "-qm", "alias base"], repository);
  const baseCommit = captureRepositoryBaseCommit(join(workspaceAlias, "repo"));
  const canonicalWorkspace = realpathSync(physicalWorkspace);
  const worktree = prepareCascadeWorktree({
    repository: join(workspaceAlias, "repo"),
    base_commit: baseCommit,
    assignment_id: "alias-a0",
    options: {
      workspaceRoot: workspaceAlias,
      worktreesRoot: join(workspaceAlias, "missing", "nested", "worktrees"),
    },
  });
  check(
    "trusted workspace alias canonicalizes multiple missing worktree ancestors",
    worktree === join(canonicalWorkspace, "missing", "nested", "worktrees", "cascade-repo-alias-a0"),
    worktree,
  );
  check("trusted workspace alias preserves exact base", run("git", ["rev-parse", "HEAD"], worktree) === baseCommit);

  const outside = join(aliasRoot, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(physicalWorkspace, "escape"), "dir");
  let escapeRejected = false;
  try {
    prepareCascadeWorktree({
      repository,
      base_commit: baseCommit,
      assignment_id: "escape-a1",
      options: {
        workspaceRoot: workspaceAlias,
        worktreesRoot: join(workspaceAlias, "escape", "missing", "worktrees"),
      },
    });
  } catch {
    escapeRejected = true;
  }
  check("symlink escape remains rejected before worktree creation", escapeRejected);
  check("symlink escape creates no outside suffix", !existsSync(join(outside, "missing")));
} finally {
  rmSync(aliasRoot, { recursive: true, force: true });
}

console.log(`${failed === 0 ? "PASS" : "FAIL"} ${passed}/${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
