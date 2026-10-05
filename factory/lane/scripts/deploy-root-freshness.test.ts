import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDeployRootFreshness,
  describeFreshness,
  findReplacementRoot,
  isDeployRoot,
  isRealRemoteUrl,
  parsePinnedSha,
  parseRemotes,
  selectCanonicalRemote,
} from "./deploy-root-freshness";

const DEPLOY_ROOT_REMOTES = `origin\thttps://github.com/marlandoj/hermes-agent.git (fetch)
origin\tDISABLED-meta-repo-must-not-push-to-public-hermes-agent (push)
zbr\thttps://github.com/marlandoj/zouroboros-workspace.git (fetch)
zbr\thttps://github.com/marlandoj/zouroboros-workspace.git (push)`;

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "deploy-root-freshness-"));
  directories.push(dir);
  return dir;
}

function git(args: string[], cwd: string): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return (r.stdout ?? "").trim();
}

function commit(repo: string, name: string): string {
  writeFileSync(join(repo, name), name);
  git(["add", "."], repo);
  git(["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", name], repo);
  return git(["rev-parse", "HEAD"], repo);
}

describe("remote url classification", () => {
  test("a neutered push url is not a transport target", () => {
    expect(isRealRemoteUrl("DISABLED-meta-repo-must-not-push-to-public-hermes-agent")).toBe(false);
    expect(isRealRemoteUrl("")).toBe(false);
    expect(isRealRemoteUrl("   ")).toBe(false);
  });

  test("https, ssh and scp-style urls are transport targets", () => {
    expect(isRealRemoteUrl("https://github.com/marlandoj/zouroboros-workspace.git")).toBe(true);
    expect(isRealRemoteUrl("ssh://git@github.com/marlandoj/x.git")).toBe(true);
    expect(isRealRemoteUrl("git@github.com:marlandoj/x.git")).toBe(true);
  });

  test("local filesystem remotes are transport targets", () => {
    expect(isRealRemoteUrl("/srv/mirrors/zouroboros.git")).toBe(true);
    expect(isRealRemoteUrl("../upstream.git")).toBe(true);
  });
});

describe("canonical remote selection", () => {
  test("prefers the pushable remote over the deploy root's disabled origin", () => {
    const selected = selectCanonicalRemote(parseRemotes(DEPLOY_ROOT_REMOTES));
    expect(selected?.name).toBe("zbr");
  });

  test("an explicit repository slug wins over declaration order", () => {
    const remotes = parseRemotes(`a\thttps://github.com/marlandoj/other.git (fetch)
a\thttps://github.com/marlandoj/other.git (push)
b\thttps://github.com/marlandoj/zouroboros-workspace.git (fetch)
b\thttps://github.com/marlandoj/zouroboros-workspace.git (push)`);
    expect(selectCanonicalRemote(remotes, "marlandoj/zouroboros-workspace")?.name).toBe("b");
    expect(selectCanonicalRemote(remotes)?.name).toBe("a");
  });

  test("falls back to a fetch-only remote and reports none when there is nothing to read", () => {
    const fetchOnly = parseRemotes("upstream\thttps://example.com/x.git (fetch)");
    expect(selectCanonicalRemote(fetchOnly)?.name).toBe("upstream");
    expect(selectCanonicalRemote([])).toBeNull();
  });
});

describe("directory-name pin parsing", () => {
  test("reads the sha out of both observed deploy-root shapes", () => {
    expect(parsePinnedSha("/r/factory-conveyor-state-boundary-main-bb57f03b-20260830")).toBe("bb57f03b");
    expect(parsePinnedSha("/r/factory-conveyor-state-boundary-f4c28cbe-zou1450")).toBe("f4c28cbe");
  });

  test("never mistakes the trailing date stamp for the pinned sha", () => {
    expect(parsePinnedSha("/r/factory-conveyor-state-boundary-main-20260830")).toBeNull();
  });

  test("ignores directories that are not deploy roots", () => {
    expect(parsePinnedSha("/home/workspace")).toBeNull();
    expect(isDeployRoot("/home/workspace")).toBe(false);
    expect(isDeployRoot("/r/factory-conveyor-state-boundary-main-bb57f03b-20260830")).toBe(true);
  });
});

describe("drift description", () => {
  test("names the distance and the canonical remote when behind", () => {
    const detail = describeFreshness({
      head: "2974af266aaaaaaa",
      pinnedSha: "2974af26",
      nameMatchesHead: true,
      remote: "zbr",
      upstream: "7a2284df3bbbbbbb",
      behind: 4,
      ahead: 0,
      replacementRoot: null,
    });
    expect(detail).toContain("4 commit(s) behind zbr/main");
    expect(detail).not.toContain("directory name");
  });

  test("names unmerged commits instead of calling a diverged root zero behind", () => {
    const detail = describeFreshness({
      head: "97db3f5a7aaaaaaa",
      pinnedSha: null,
      nameMatchesHead: null,
      remote: "zbr",
      upstream: "7a2284df3bbbbbbb",
      behind: 0,
      ahead: 1,
      replacementRoot: null,
    });
    expect(detail).toContain("1 unmerged commit(s) ahead of zbr/main");
    expect(detail).not.toContain("behind");
  });

  test("reports both directions when the root has truly diverged", () => {
    const detail = describeFreshness({
      head: "97db3f5a7aaaaaaa",
      pinnedSha: null,
      nameMatchesHead: null,
      remote: "zbr",
      upstream: "7a2284df3bbbbbbb",
      behind: 3,
      ahead: 2,
      replacementRoot: null,
    });
    expect(detail).toContain("diverged");
    expect(detail).toContain("3 behind, 2 ahead");
  });

  test("reports a stale directory pin alongside a matching HEAD", () => {
    const detail = describeFreshness({
      head: "2974af266aaaaaaa",
      pinnedSha: "bb57f03b",
      nameMatchesHead: false,
      remote: "zbr",
      upstream: "2974af266aaaaaaa",
      behind: 0,
      ahead: 0,
      replacementRoot: null,
    });
    expect(detail).toContain("matches zbr/main");
    expect(detail).toContain("directory name still pins bb57f03b");
  });

  test("names the sibling root the operator should rebind ROOT to", () => {
    const detail = describeFreshness({
      head: "2974af266aaaaaaa",
      pinnedSha: "bb57f03b",
      nameMatchesHead: false,
      remote: "zbr",
      upstream: "7a2284df3bbbbbbb",
      behind: 1,
      ahead: 0,
      replacementRoot: "/home/workspace/.runtime/factory-conveyor-state-boundary-main-7a2284df-20260902",
    });
    expect(detail).toContain("rebind the conveyor ROOT to");
    expect(detail).toContain("factory-conveyor-state-boundary-main-7a2284df-20260902");
  });

  test("says drift is unverified when the remote could not be read", () => {
    const detail = describeFreshness({
      head: "2974af266aaaaaaa",
      pinnedSha: null,
      nameMatchesHead: null,
      remote: null,
      upstream: null,
      behind: null,
      ahead: null,
      replacementRoot: null,
    });
    expect(detail).toContain("drift unverified");
  });
});

describe("replacement root discovery", () => {
  const siblings = [
    "factory-conveyor-state-boundary-main-bb57f03b-20260830",
    "factory-conveyor-state-boundary-main-7a2284df-20260902",
    "factory-conveyor-state-boundary-main-f0c3fbb1-20260831",
    "unrelated-directory",
  ];

  test("matches a sibling root whose name pins canonical main", () => {
    const found = findReplacementRoot(
      "/rt/factory-conveyor-state-boundary-main-bb57f03b-20260830",
      "7a2284df3a74cbe8af607518f3d44fc94f104be0",
      () => siblings,
    );
    expect(found).toBe("/rt/factory-conveyor-state-boundary-main-7a2284df-20260902");
  });

  test("returns nothing when no sibling is at canonical main", () => {
    expect(
      findReplacementRoot(
        "/rt/factory-conveyor-state-boundary-main-bb57f03b-20260830",
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        () => siblings,
      ),
    ).toBeNull();
  });

  test("never proposes the current root or survives an unreadable parent", () => {
    expect(
      findReplacementRoot(
        "/rt/factory-conveyor-state-boundary-main-7a2284df-20260902",
        "7a2284df3a74cbe8af607518f3d44fc94f104be0",
        () => siblings,
      ),
    ).toBeNull();
    expect(
      findReplacementRoot("/rt/factory-conveyor-state-boundary-main-bb57f03b-20260830", "7a2284df3", () => {
        throw new Error("EACCES");
      }),
    ).toBeNull();
  });

  test("is inert without a resolved upstream", () => {
    expect(findReplacementRoot("/rt/factory-conveyor-state-boundary-main-bb57f03b-20260830", null, () => siblings)).toBeNull();
  });
});

describe("deploy-root freshness check", () => {
  test("skips any directory that is not a conveyor deploy root", () => {
    const result = checkDeployRootFreshness("/home/workspace/Projects/x", {});
    expect(result.applicable).toBe(false);
    expect(result.ok).toBe(true);
  });

  test("honours the kill switch", () => {
    const result = checkDeployRootFreshness(
      "/r/factory-conveyor-state-boundary-main-bb57f03b-20260830",
      { FACTORY_ROOT_DRIFT_CHECK: "0" },
    );
    expect(result.applicable).toBe(false);
    expect(result.detail).toContain("FACTORY_ROOT_DRIFT_CHECK=0");
  });

  test("reports drift against canonical main and stays advisory by default", () => {
    const base = scratch();
    const upstream = join(base, "upstream.git");
    const root = join(base, "factory-conveyor-state-boundary-main-abcdef1-20260830");
    git(["init", "-q", "--bare", "-b", "main", upstream], base);
    git(["clone", "-q", upstream, root], base);
    const first = commit(root, "one");
    git(["push", "-q", "origin", "main"], root);
    const second = commit(root, "two");
    git(["push", "-q", "origin", "main"], root);
    git(["checkout", "-q", first], root);

    const advisory = checkDeployRootFreshness(root, {});
    expect(advisory.applicable).toBe(true);
    expect(advisory.head).toBe(first);
    expect(advisory.upstream).toBe(second);
    expect(advisory.behind).toBe(1);
    expect(advisory.ahead).toBe(0);
    expect(advisory.ok).toBe(true);
    expect(advisory.enforced).toBe(false);
    expect(advisory.detail).toContain("1 commit(s) behind");
    // The directory pins abcdef1, which no commit in this fixture matches.
    expect(advisory.nameMatchesHead).toBe(false);

    const enforced = checkDeployRootFreshness(root, { FACTORY_ROOT_DRIFT_ENFORCE: "1" });
    expect(enforced.ok).toBe(false);
    expect(enforced.enforced).toBe(true);
  });

  test("passes when the root is level with canonical main, even under enforcement", () => {
    const base = scratch();
    const upstream = join(base, "upstream.git");
    const root = join(base, "factory-conveyor-state-boundary-main-abcdef1-20260830");
    git(["init", "-q", "--bare", "-b", "main", upstream], base);
    git(["clone", "-q", upstream, root], base);
    const head = commit(root, "one");
    git(["push", "-q", "origin", "main"], root);

    const result = checkDeployRootFreshness(root, { FACTORY_ROOT_DRIFT_ENFORCE: "1" });
    expect(result.head).toBe(head);
    expect(result.upstream).toBe(head);
    expect(result.behind).toBe(0);
    expect(result.ahead).toBe(0);
    expect(result.ok).toBe(true);
  });

  test("flags a root carrying commits canonical main has not merged", () => {
    const base = scratch();
    const upstream = join(base, "upstream.git");
    const root = join(base, "factory-conveyor-state-boundary-main-abcdef1-20260830");
    git(["init", "-q", "--bare", "-b", "main", upstream], base);
    git(["clone", "-q", upstream, root], base);
    commit(root, "one");
    git(["push", "-q", "origin", "main"], root);
    commit(root, "local-only");

    const result = checkDeployRootFreshness(root, {});
    expect(result.behind).toBe(0);
    expect(result.ahead).toBe(1);
    expect(result.detail).toContain("1 unmerged commit(s) ahead");
    expect(result.ok).toBe(true);
  });

  test("stays advisory when the canonical remote cannot be read", () => {
    const base = scratch();
    const root = join(base, "factory-conveyor-state-boundary-main-abcdef1-20260830");
    git(["init", "-q", "-b", "main", root], base);
    commit(root, "one");
    git(["remote", "add", "zbr", "https://example.invalid/nope.git"], root);

    const result = checkDeployRootFreshness(root, { FACTORY_ROOT_DRIFT_ENFORCE: "1" });
    expect(result.upstream).toBeNull();
    expect(result.ok).toBe(true);
    expect(result.detail).toContain("drift unverified");
  });
});
