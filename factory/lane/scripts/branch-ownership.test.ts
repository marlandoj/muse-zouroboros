import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertOwnership,
  claimBranch,
  currentClaim,
  evaluateOwnership,
  registryPath,
  releaseBranch,
  staleClaims,
} from "./branch-ownership";

const dirs: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "branch-own-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** The branch PR #402 sits on. */
const ZBRE_BRANCH = "factory/zou-902-factory-intake-zbre-001-define-versioned-result-co";

describe("branch ownership (FH-12)", () => {
  test("refuses the PR #402 scenario — a second execution writing to another's branch", () => {
    const base = scratch();
    const first = claimBranch(
      { branch: ZBRE_BRANCH, execution_id: "exec-ed5547e3", ticket_id: "ZOU-902", base_commit: "abc123" },
      { base },
    );
    expect(first.allowed).toBe(true);

    const intruder = claimBranch(
      { branch: ZBRE_BRANCH, execution_id: "exec-selfheal", ticket_id: "ZOU-940" },
      { base },
    );
    expect(intruder.allowed).toBe(false);
    expect(intruder.status).toBe("conflict");
    expect(intruder.reason).toContain("exec-ed5547e3");
    expect(intruder.reason).toContain("ZOU-902");
  });

  test("an execution re-claiming its own branch is a resume, not a conflict", () => {
    const base = scratch();
    claimBranch({ branch: ZBRE_BRANCH, execution_id: "exec-ed5547e3", ticket_id: "ZOU-902" }, { base });
    const again = claimBranch({ branch: ZBRE_BRANCH, execution_id: "exec-ed5547e3", ticket_id: "ZOU-902" }, { base });
    expect(again.allowed).toBe(true);
    expect(again.status).toBe("owned");
  });

  test("an unclaimed branch is claimable — pre-existing work is not locked out", () => {
    const base = scratch();
    expect(assertOwnership("some/legacy-branch", "exec-new", base)).toMatchObject({
      status: "unclaimed",
      allowed: true,
    });
  });

  test("ownership survives a fresh process — the registry is on disk", () => {
    const base = scratch();
    claimBranch({ branch: ZBRE_BRANCH, execution_id: "exec-a", ticket_id: "ZOU-902" }, { base });
    // A separate conveyor step reads only the registry file.
    expect(assertOwnership(ZBRE_BRANCH, "exec-b", base).allowed).toBe(false);
    expect(assertOwnership(ZBRE_BRANCH, "exec-a", base).allowed).toBe(true);
  });

  test("a released branch becomes claimable by another execution", () => {
    const base = scratch();
    claimBranch({ branch: ZBRE_BRANCH, execution_id: "exec-a", ticket_id: "ZOU-902" }, { base });
    expect(releaseBranch(ZBRE_BRANCH, "marlandoj", { base }).released).toBe(true);
    const next = claimBranch({ branch: ZBRE_BRANCH, execution_id: "exec-b", ticket_id: "ZOU-940" }, { base });
    expect(next.allowed).toBe(true);
    expect(currentClaim(ZBRE_BRANCH, base)?.execution_id).toBe("exec-b");
  });

  test("release is not automatic — an unreleased stale claim still blocks", () => {
    const base = scratch();
    claimBranch(
      { branch: ZBRE_BRANCH, execution_id: "exec-a", ticket_id: "ZOU-902" },
      { base, now: "2026-01-01T00:00:00.000Z" },
    );
    expect(assertOwnership(ZBRE_BRANCH, "exec-b", base).allowed).toBe(false);
  });

  test("releasing an unowned or already-released branch is reported, not silently accepted", () => {
    const base = scratch();
    expect(releaseBranch("nobody/branch", "op", { base })).toMatchObject({ released: false });
    claimBranch({ branch: "b", execution_id: "exec-a", ticket_id: "T" }, { base });
    releaseBranch("b", "op", { base });
    expect(releaseBranch("b", "op", { base }).released).toBe(false);
  });

  test("the newest record wins when a branch has been claimed more than once", () => {
    const base = scratch();
    claimBranch({ branch: "b", execution_id: "exec-a", ticket_id: "T1" }, { base, now: "2026-07-01T00:00:00.000Z" });
    releaseBranch("b", "op", { base, now: "2026-07-02T00:00:00.000Z" });
    claimBranch({ branch: "b", execution_id: "exec-b", ticket_id: "T2" }, { base, now: "2026-07-03T00:00:00.000Z" });
    expect(currentClaim("b", base)).toMatchObject({ execution_id: "exec-b", ticket_id: "T2" });
  });

  test("a torn registry line does not blind the remaining claims", () => {
    const base = scratch();
    claimBranch({ branch: "b", execution_id: "exec-a", ticket_id: "T" }, { base });
    mkdirSync(join(base, "state"), { recursive: true });
    appendFileSync(registryPath(base), '{"branch":"b","exec\n');
    expect(currentClaim("b", base)?.execution_id).toBe("exec-a");
  });

  test("stale claims are reported for an operator, never auto-released", () => {
    const base = scratch();
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    claimBranch(
      { branch: "old/branch", execution_id: "exec-old", ticket_id: "ZOU-1" },
      { base, now: "2026-06-01T00:00:00.000Z" },
    );
    claimBranch(
      { branch: "new/branch", execution_id: "exec-new", ticket_id: "ZOU-2" },
      { base, now: "2026-07-25T00:00:00.000Z" },
    );
    const stale = staleClaims({ base, now, maxAgeDays: 14 });
    expect(stale.map((entry) => entry.branch)).toEqual(["old/branch"]);
    // Reporting must not mutate ownership.
    expect(assertOwnership("old/branch", "exec-other", base).allowed).toBe(false);
  });

  test("a released claim is never reported as stale", () => {
    const base = scratch();
    const now = Date.parse("2026-07-26T00:00:00.000Z");
    claimBranch({ branch: "b", execution_id: "exec-a", ticket_id: "T" }, { base, now: "2026-06-01T00:00:00.000Z" });
    releaseBranch("b", "op", { base, now: "2026-06-02T00:00:00.000Z" });
    expect(staleClaims({ base, now, maxAgeDays: 14 })).toEqual([]);
  });

  test("the ownership policy is decidable without touching disk", () => {
    const claim = {
      branch: "b", execution_id: "exec-a", ticket_id: "T", base_commit: null, claimed_at: "2026-07-01T00:00:00.000Z",
    };
    expect(evaluateOwnership("b", "exec-a", claim).status).toBe("owned");
    expect(evaluateOwnership("b", "exec-b", claim).status).toBe("conflict");
    expect(evaluateOwnership("b", "exec-b", null).status).toBe("unclaimed");
    expect(evaluateOwnership("b", "exec-b", { ...claim, released_at: "x", released_by: "op" }).status).toBe("released");
  });
});
