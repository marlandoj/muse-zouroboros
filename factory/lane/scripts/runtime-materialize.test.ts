import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditDependencyLinks, isStandaloneCandidate, materializeRuntime, normalizeDependencyGraph, refreshStandaloneRuntime, resolveTemplateLibraryAjv, runtimeKey, STANDALONE_RUNTIME_ROOT } from "./runtime-materialize";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const rootTest = process.platform === "linux" && process.getuid?.() === 0 && process.getgid?.() === 0 ? test : test.skip;

describe("standalone VPS materialization", () => {
  test("recognizes only the fixed exact-commit namespace", () => {
    expect(isStandaloneCandidate(`${STANDALONE_RUNTIME_ROOT}/${"a".repeat(40)}`)).toBe(true);
    for (const path of [`${STANDALONE_RUNTIME_ROOT}/HEAD`, `${STANDALONE_RUNTIME_ROOT}/${"a".repeat(40)}/nested`, `/tmp/${"a".repeat(40)}`]) {
      expect(isStandaloneCandidate(path)).toBe(false);
    }
  });

  rootTest("actual Git worktree and post-augmentation refresh remeasure links, commit, and cleanliness", async () => {
    const fixture = mkdtempSync("/root/zo-task-materialize-");
    const createdParents: string[] = [];
    const candidates: string[] = [];
    const previousPath = process.env.PATH;
    const previousProfile = process.env.FACTORY_PATH_PROFILE;
    const previousTestMode = process.env.RUNTIME_MATERIALIZE_TEST_MODE;
    const previousNodeOptions = process.env.NODE_OPTIONS;
    const previousPnpmHook = process.env.npm_config_pnpmfile;
    const source = join(fixture, "source");
    const bin = join(fixture, "bin");
    const git = (args: string[], cwd = source) => {
      const result = Bun.spawnSync(["/usr/bin/git", ...args], { cwd, stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin", HOME: fixture, LC_ALL: "C" } });
      if (result.exitCode !== 0) throw new Error(result.stderr.toString());
      return result.stdout.toString().trim();
    };
    try {
      for (const path of ["/opt/zouroboros", "/opt/zouroboros/software-factory", STANDALONE_RUNTIME_ROOT]) {
        if (!existsSync(path)) { mkdirSync(path, { mode: 0o755 }); createdParents.push(path); }
      }
      mkdirSync(source); mkdirSync(bin);
      mkdirSync(join(source, "Projects/software-template-library"), { recursive: true });
      writeFileSync(join(source, "Projects/software-template-library/package.json"), "{}");
      writeFileSync(join(source, "package.json"), '{"private":true}');
      writeFileSync(join(source, "pnpm-lock.yaml"), "lockfileVersion: '6.0'\n");
      writeFileSync(join(source, "pnpm-workspace.yaml"), "packages:\n  - 'packages/*'\n  - 'cli'\n  - 'plugins/*'\n  - 'tui'\n  - 'Projects/software-template-library'\n");
      symlinkSync("AVATAR-KEVIN.md", join(source, "AVATAR-USER.md"));
      mkdirSync(join(source, "evaluations"));
      for (const name of ["bench", "rag", "swarm"]) symlinkSync("/home/workspace/zouroboros/packages/" + name + "/evaluations", join(source, "evaluations", name));
      mkdirSync(join(source, "Projects/zourobench-2026"));
      symlinkSync("hal-adapter/node_modules", join(source, "Projects/zourobench-2026/node_modules"));
      writeFileSync(join(source, ".gitignore"), "node_modules/\n");
      writeFileSync(join(source, "attribute-sensitive.txt"), "canonical Git bytes\n");
      git(["init", "--quiet", "--template=", "."]);
      git(["add", "."]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", fixture]);
      const submoduleCommit = git(["rev-parse", "HEAD"]);
      git(["update-index", "--add", "--cacheinfo", "160000," + submoduleCommit + ",legacy-submodule"]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "uninitialized unrelated submodule"]);
      const commit = git(["rev-parse", "HEAD"]);
      const candidate = `${STANDALONE_RUNTIME_ROOT}/${commit}`;
      if (existsSync(candidate)) throw new Error("owned exact fixture candidate collision");
      candidates.push(candidate);
      // The real Git child sees an owned HOME with ambient attributes. A clean
      // status alone would accept CRLF checkout conversion of this pinned file.
      const attributes = join(fixture, ".config/git"); mkdirSync(attributes, { recursive: true });
      writeFileSync(join(attributes, "attributes"), "attribute-sensitive.txt text eol=crlf\n");
      const gitEnvironment = join(fixture, "git-attributes-environment");
      writeFileSync(join(bin, "git"), `#!/usr/bin/python3
import os,sys
from pathlib import Path
Path(${JSON.stringify(gitEnvironment)}).write_text(os.environ.get('GIT_ATTR_NOSYSTEM','missing'))
os.environ['HOME']=${JSON.stringify(fixture)}
os.execv('/usr/bin/git',['/usr/bin/git',*sys.argv[1:]])
`);
      chmodSync(join(bin, "git"), 0o755);
      const pnpm = join(bin, "pnpm");
      writeFileSync(pnpm, `#!/usr/bin/python3
import json,os,sys
from pathlib import Path
a=sys.argv[1:]
assert os.environ['NPM_CONFIG_USERCONFIG']=='/dev/null' and os.environ['NPM_CONFIG_GLOBALCONFIG']=='/dev/null'
assert 'NODE_OPTIONS' not in os.environ and 'npm_config_pnpmfile' not in os.environ
assert os.environ['npm_config_package_import_method']=='copy'
if a==['--version']: print('8.15.0')
elif a==['install','--offline','--frozen-lockfile','--ignore-scripts']:
 p=Path('node_modules/ajv');(p/'dist').mkdir(parents=True,exist_ok=True)
 (p/'package.json').write_text('{"name":"ajv","version":"8.17.1"}')
 (p/'dist/2020.js').write_text('module.exports = {};')
 count=Path('node_modules/install-count');count.write_text(str(int(count.read_text())+1 if count.exists() else 1))
elif a==['list','--depth','Infinity','--json']: print(json.dumps([{'path':os.getcwd(),'dependencies':{'ajv':{'version':'8.17.1'}}}]))
else: raise SystemExit(71)
`);
      chmodSync(pnpm, 0o755);
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      process.env.FACTORY_PATH_PROFILE = "/must-not-read-a-Zo-profile";
      process.env.RUNTIME_MATERIALIZE_TEST_MODE = "1";
      process.env.NODE_OPTIONS = "--require=/must-not-load-in-staging";
      process.env.npm_config_pnpmfile = "/must-not-load-in-staging";
      await expect(materializeRuntime(source, "HEAD", candidate)).rejects.toMatchObject({ code: "standalone_commit" });
      expect(existsSync(candidate)).toBe(false);
      await expect(materializeRuntime(source, commit, `${STANDALONE_RUNTIME_ROOT}/HEAD`)).rejects.toMatchObject({ code: "standalone_candidate" });
      const initial = await materializeRuntime(source, commit, candidate);
      expect(initial).toMatchObject({ candidate_root: candidate, merge_commit: commit, tracked_clean: true, dependency_link_count: 5, pnpm_version: "8.15.0" });
      expect(initial.path_profile_sha256).toBeUndefined();
      expect(readFileSync(join(candidate, "attribute-sensitive.txt"), "utf8")).toBe("canonical Git bytes\n");
      expect(readFileSync(gitEnvironment, "utf8")).toBe("1");
      const native = join(candidate, "node_modules/.factory-native"); mkdirSync(native);
      writeFileSync(join(native, "adapter"), "synthetic-native-bytes");
      symlinkSync("adapter", join(native, "adapter-link"));
      symlinkSync("node_modules/.factory-native/adapter", join(candidate, "source-link"));
      mkdirSync(join(source, ".git/info"), { recursive: true });
      writeFileSync(join(source, ".git/info/exclude"), "source-link\n.pnpmfile.cjs\nevaluations/unknown\n");
      const refreshed = await refreshStandaloneRuntime(commit, candidate);
      expect(refreshed.dependency_link_count).toBe(7);
      expect(refreshed.tracked_clean).toBe(true);
      expect(readFileSync(join(candidate, "attribute-sensitive.txt"), "utf8")).toBe("canonical Git bytes\n");
      expect(readFileSync(gitEnvironment, "utf8")).toBe("1");
      expect(readFileSync(join(candidate, "node_modules/install-count"), "utf8")).toBe("2");
      expect(refreshed.install_flags).toEqual(["--offline", "--frozen-lockfile", "--ignore-scripts"]);
      symlinkSync(fixture, join(native, "escape"));
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "cross_runtime_link" });
      rmSync(join(native, "escape"));
      const countBeforeDenial = readFileSync(join(candidate, "node_modules/install-count"), "utf8");
      writeFileSync(join(candidate, "package.json"), '{"changed":true}');
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "tracked_drift" });
      expect(readFileSync(join(candidate, "node_modules/install-count"), "utf8")).toBe(countBeforeDenial);
      git(["checkout", "--", "package.json"], candidate);
      writeFileSync(join(candidate, ".pnpmfile.cjs"), "throw new Error('must not execute')");
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_pnpm_config" });
      expect(readFileSync(join(candidate, "node_modules/install-count"), "utf8")).toBe(countBeforeDenial);
      rmSync(join(candidate, ".pnpmfile.cjs"));
      chmodSync(join(candidate, "package.json"), 0o666);
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_pnpm_config" });
      chmodSync(join(candidate, "package.json"), 0o644);
      const toolSource = readFileSync(pnpm, "utf8");
      writeFileSync(pnpm, toolSource.replace("print('8.15.0')", "print('8.15.9')"));
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "pnpm_version_mismatch" });
      expect(readFileSync(join(candidate, "node_modules/install-count"), "utf8")).toBe(countBeforeDenial);
      writeFileSync(pnpm, toolSource);
      symlinkSync(bin, join(fixture, "tool-alias"));
      process.env.PATH = `${fixture}/tool-alias:/usr/bin:/bin`;
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_ancestry" });
      process.env.PATH = `${bin}:/usr/bin:/bin`;
      chmodSync(candidate, 0o775);
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_ancestry" });
      chmodSync(candidate, 0o755);
      const denied = Bun.spawnSync([process.execPath, "-e", `import { refreshStandaloneRuntime } from ${JSON.stringify(join(import.meta.dir, "runtime-materialize.ts"))};process.setgid(65534);process.setuid(65534);try { await refreshStandaloneRuntime(${JSON.stringify(commit)},${JSON.stringify(candidate)});process.exit(4); } catch(e) { process.exit(e.code === 'standalone_identity' ? 0 : 5); }`], { stdout: "pipe", stderr: "pipe", env: { PATH: "/usr/bin:/bin" } });
      expect(denied.exitCode).toBe(0);
      const preAliasDenialCount = readFileSync(join(candidate, "node_modules/install-count"), "utf8");
      symlinkSync("/home/workspace/unreviewed", join(candidate, "evaluations/unknown"));
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "cross_runtime_link" });
      expect(readFileSync(join(candidate, "node_modules/install-count"), "utf8")).toBe(preAliasDenialCount);
      rmSync(join(candidate, "evaluations/unknown"));
      writeFileSync(join(candidate, "legacy-submodule/foreign"), "must stay uninitialized");
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_gitlink" });
      expect(readFileSync(join(candidate, "node_modules/install-count"), "utf8")).toBe(preAliasDenialCount);
      rmSync(join(candidate, "legacy-submodule/foreign"));
      chmodSync(join(candidate, "legacy-submodule"), 0o777);
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_ancestry" });
      chmodSync(join(candidate, "legacy-submodule"), 0o755);
      chownSync(join(candidate, "legacy-submodule"), 65534, 65534);
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_ancestry" });
      chownSync(join(candidate, "legacy-submodule"), 0, 0);
      expect(readFileSync(join(candidate, "node_modules/install-count"), "utf8")).toBe(preAliasDenialCount);

      writeFileSync(pnpm, toolSource.replace("p=Path('node_modules/ajv');", "link=Path('evaluations/bench');link.unlink();link.symlink_to('/tmp/unreviewed')\n p=Path('node_modules/ajv');"));
      await expect(refreshStandaloneRuntime(commit, candidate)).rejects.toMatchObject({ code: "standalone_source_record" });
      git(["checkout", "--", "evaluations/bench"], candidate);
      writeFileSync(pnpm, toolSource);
      // Even a clean, committed alias change needs a fresh reviewed policy.
      for (const [name, target] of [["AVATAR-USER.md", "AVATAR-JACKSON.md"], ["evaluations/bench", "/home/workspace/unreviewed"]]) {
        rmSync(join(source, name));
        symlinkSync(target, join(source, name));
        git(["add", name]);
        git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "unreviewed alias " + name]);
        const changedCommit = git(["rev-parse", "HEAD"]);
        const changedCandidate = STANDALONE_RUNTIME_ROOT + "/" + changedCommit;
        candidates.push(changedCandidate);
        await expect(materializeRuntime(source, changedCommit, changedCandidate)).rejects.toMatchObject({ code: "standalone_source_record" });
        expect(existsSync(join(changedCandidate, "node_modules/install-count"))).toBe(false);
        git(["checkout", commit, "--", name]);
      }
      writeFileSync(join(source, "pnpm-workspace.yaml"), "packages:\n  - '**'\n");
      git(["add", "pnpm-workspace.yaml"]);
      git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "workspace admits legacy alias"]);
      const workspaceCommit = git(["rev-parse", "HEAD"]);
      const workspaceCandidate = STANDALONE_RUNTIME_ROOT + "/" + workspaceCommit;
      candidates.push(workspaceCandidate);
      await expect(materializeRuntime(source, workspaceCommit, workspaceCandidate)).rejects.toMatchObject({ code: "standalone_source_record" });
      expect(existsSync(join(workspaceCandidate, "node_modules/install-count"))).toBe(false);

    } finally {
      if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
      if (previousProfile === undefined) delete process.env.FACTORY_PATH_PROFILE; else process.env.FACTORY_PATH_PROFILE = previousProfile;
      if (previousTestMode === undefined) delete process.env.RUNTIME_MATERIALIZE_TEST_MODE; else process.env.RUNTIME_MATERIALIZE_TEST_MODE = previousTestMode;
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previousNodeOptions;
      if (previousPnpmHook === undefined) delete process.env.npm_config_pnpmfile; else process.env.npm_config_pnpmfile = previousPnpmHook;
      for (const candidate of candidates) {
        if (dirname(candidate) !== STANDALONE_RUNTIME_ROOT || !/^[a-f0-9]{40}$/.test(candidate.slice(STANDALONE_RUNTIME_ROOT.length + 1))) throw new Error("fixture cleanup scope");
        if (existsSync(candidate)) git(["worktree", "remove", "--force", candidate]);
      }
      rmSync(fixture, { recursive: true });
      for (const path of createdParents.reverse()) rmdirSync(path);
    }
  }, 30_000);
});

describe("runtime materialization", () => {
  test("normalizes path and ordering differences into one graph", () => {
    const a = "/tmp/runtime-a";
    const b = "/tmp/runtime-b";
    const graphA = [{ path: a, dependencies: { z: { version: "1" }, a: { version: "2", resolved: `${a}/node_modules/a` } } }];
    const graphB = [{ path: b, dependencies: { a: { resolved: `${b}/node_modules/a`, version: "2" }, z: { version: "1" } } }];
    expect(normalizeDependencyGraph(graphA, a)).toEqual(normalizeDependencyGraph(graphB, b));
  });

  test("accepts candidate-local links and rejects cross-runtime links", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-materialize-links-"));
    roots.push(root);
    const localPackage = join(root, "packages", "local");
    mkdirSync(localPackage, { recursive: true });
    mkdirSync(join(root, "node_modules"));
    symlinkSync(localPackage, join(root, "node_modules", "local"));
    expect(auditDependencyLinks(root).violations).toEqual([]);

    const other = mkdtempSync(join(tmpdir(), "runtime-materialize-other-"));
    roots.push(other);
    writeFileSync(join(other, "package.json"), "{}");
    symlinkSync(other, join(root, "node_modules", "other"));
    expect(auditDependencyLinks(root).violations[0]).toContain(other);
  });

  test("audits nested workspace node_modules boundaries", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-materialize-nested-links-"));
    roots.push(root);
    mkdirSync(join(root, "node_modules"));
    const nestedNodeModules = join(root, "Projects", "nested", "node_modules");
    mkdirSync(nestedNodeModules, { recursive: true });
    const localPackage = join(root, ".pnpm", "local");
    mkdirSync(localPackage, { recursive: true });
    symlinkSync(localPackage, join(nestedNodeModules, "local"));
    expect(auditDependencyLinks(root)).toEqual({ links: 1, violations: [] });

    const other = mkdtempSync(join(tmpdir(), "runtime-materialize-nested-other-"));
    roots.push(other);
    symlinkSync(other, join(nestedNodeModules, "other"));
    expect(auditDependencyLinks(root).violations[0]).toContain("Projects/nested/node_modules/other");
  });

  test("resolves the exact template-library Ajv entrypoint inside the candidate", () => {
    const root = mkdtempSync(join(tmpdir(), "runtime-materialize-ajv-"));
    roots.push(root);
    const project = join(root, "Projects", "software-template-library");
    const ajv = join(root, ".pnpm", "ajv@8.17.1", "node_modules", "ajv");
    mkdirSync(join(project, "node_modules"), { recursive: true });
    mkdirSync(join(ajv, "dist"), { recursive: true });
    writeFileSync(join(project, "package.json"), "{}");
    writeFileSync(join(ajv, "package.json"), JSON.stringify({ name: "ajv", version: "8.17.1" }));
    writeFileSync(join(ajv, "dist", "2020.js"), "module.exports = {};");
    symlinkSync(ajv, join(project, "node_modules", "ajv"));
    expect(resolveTemplateLibraryAjv(root)).toEqual({
      entrypoint: ".pnpm/ajv@8.17.1/node_modules/ajv/dist/2020.js",
      version: "8.17.1",
    });
  });

  test("runtime key changes with dependency graph or platform input", () => {
    const base = {
      merge_commit: "a".repeat(40),
      merge_tree: "b".repeat(40),
      package_json_sha256: "c".repeat(64),
      pnpm_lock_sha256: "d".repeat(64),
      pnpm_workspace_sha256: "e".repeat(64),
      pnpm_version: "8.15.0",
      bun_version: "1.3.12",
      os: "linux",
      arch: "x64",
      install_flags: ["--offline", "--frozen-lockfile", "--ignore-scripts"],
      normalized_dependency_graph_sha256: "f".repeat(64),
      template_library_ajv_entrypoint: ".pnpm/ajv@8.17.1/node_modules/ajv/dist/2020.js",
      template_library_ajv_version: "8.17.1",
    };
    expect(runtimeKey(base)).not.toBe(runtimeKey({ ...base, normalized_dependency_graph_sha256: "0".repeat(64) }));
    expect(runtimeKey(base)).not.toBe(runtimeKey({ ...base, arch: "arm64" }));
  });
});
