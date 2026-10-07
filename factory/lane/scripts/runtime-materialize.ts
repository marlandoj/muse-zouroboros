#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { canonicalFactoryPath, loadFactoryPathProfile } from "../../../packages/zo-swarm-orchestrator/src/transport/factory-path-profile";
import { existsSync, lstatSync, readFileSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { arch, platform } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const REQUIRED_PNPM_VERSION = "8.15.0";
export const MATERIALIZE_FLAGS = ["--offline", "--frozen-lockfile", "--ignore-scripts"] as const;
export const STANDALONE_RUNTIME_ROOT = "/opt/zouroboros/software-factory/execution-runtime";

export interface RuntimeMaterializationAttestation {
  version: 1;
  candidate_root: string;
  merge_commit: string;
  merge_tree: string;
  package_json_sha256: string;
  pnpm_lock_sha256: string;
  pnpm_workspace_sha256: string;
  pnpm_version: string;
  bun_version: string;
  os: string;
  arch: string;
  install_flags: string[];
  normalized_dependency_graph_sha256: string;
  template_library_ajv_entrypoint: string;
  template_library_ajv_version: string;
  runtime_key_sha256: string;
  dependency_link_count: number;
  tracked_clean: boolean;
  path_profile_sha256?: string;
}

export class RuntimeMaterializationError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RuntimeMaterializationError";
  }
}

function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function run(command: string, args: string[], cwd: string, standalone = isStandaloneCandidate(cwd)): Promise<string> {
  const env = standalone ? standaloneEnvironment() : process.env;
  let executable = standalone ? Bun.which(command, { PATH: env.PATH }) : command;
  if (!executable) throw new RuntimeMaterializationError("standalone_tool", "required staging tool is unavailable");
  if (standalone) {
    const resolved = realpathSync(executable); rootLineage(dirname(resolved));
    const stat = lstatSync(resolved);
    if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022)) throw new RuntimeMaterializationError("standalone_tool", "staging executable is not root-controlled");
    executable = resolved;
  }
  const toolArgs = standalone && command === "git" ? ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "core.attributesFile=/dev/null", ...args] : args;
  const proc = Bun.spawn([executable, ...toolArgs], { cwd, stdout: "pipe", stderr: "pipe", env });
  const [stdout, stderr, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new RuntimeMaterializationError("command_failed", `${command} ${args.join(" ")} failed (${exit}): ${stderr || stdout}`);
  return stdout.trim();
}

type RootLineage = { path: string; dev: number; ino: number; mode: number }[];

function standaloneEnvironment(): Record<string, string> {
  // Tool bytes and the offline store are independently pinned by the root
  // provisioning caller. Version checks here do not replace that enrollment.
  const toolPath = process.env.PATH;
  if (!toolPath) throw new RuntimeMaterializationError("standalone_tool", "explicit root tool PATH required");
  for (const entry of toolPath.split(":")) {
    if (!isAbsolute(entry) || resolve(entry) !== entry) throw new RuntimeMaterializationError("standalone_tool", "literal root tool PATH required");
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink() && ["/bin", "/sbin"].includes(entry) && stat.uid === 0 && stat.gid === 0 && realpathSync(entry) === `/usr${entry}`) {
      rootLineage(`/usr${entry}`);
    } else rootLineage(entry);
  }
  const env: Record<string, string> = { PATH: toolPath, HOME: "/root", LC_ALL: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_ATTR_NOSYSTEM: "1",
    NPM_CONFIG_USERCONFIG: "/dev/null", NPM_CONFIG_GLOBALCONFIG: "/dev/null", npm_config_package_import_method: "copy", CI: "true" };
  const store = process.env.npm_config_store_dir;
  if (store !== undefined) {
    if (!isAbsolute(store) || resolve(store) !== store) throw new RuntimeMaterializationError("standalone_store", "literal offline store directory required");
    rootLineage(store); env.npm_config_store_dir = store;
  }
  return env;
}

function rootLineage(path: string): RootLineage {
  if (platform() !== "linux" || process.getuid?.() !== 0 || process.getgid?.() !== 0) {
    throw new RuntimeMaterializationError("standalone_identity", "standalone materialization requires the root staging account");
  }
  const entries: RootLineage = [];
  let current = "/";
  for (const part of ["", ...path.split("/").filter(Boolean)]) {
    if (part) current = join(current, part);
    const stat = lstatSync(current);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022) !== 0) {
      throw new RuntimeMaterializationError("standalone_ancestry", "standalone staging requires root-controlled directory ancestry without symlinks");
    }
    entries.push({ path: current, dev: stat.dev, ino: stat.ino, mode: stat.mode });
  }
  return entries;
}

function recheckLineage(entries: RootLineage): void {
  for (const entry of entries) {
    const stat = lstatSync(entry.path);
    if (!stat.isDirectory() || stat.uid !== 0 || stat.gid !== 0 || stat.dev !== entry.dev || stat.ino !== entry.ino || stat.mode !== entry.mode) {
      throw new RuntimeMaterializationError("standalone_ancestry_changed", "owned staging directory changed during materialization");
    }
  }
}

export function isStandaloneCandidate(path: string): boolean {
  return dirname(path) === STANDALONE_RUNTIME_ROOT && /^[a-f0-9]{40}$/.test(path.slice(STANDALONE_RUNTIME_ROOT.length + 1));
}

function canonicalCandidate(path: string): string {
  if (!path || !isAbsolute(path) || path.includes("\0") || resolve(path) !== path || path === sep) {
    throw new RuntimeMaterializationError("candidate_invalid", "candidate root must be a canonical absolute path");
  }
  // This fixed VPS namespace is independent of Zo profiles and test bypasses.
  if (path === STANDALONE_RUNTIME_ROOT || path.startsWith(`${STANDALONE_RUNTIME_ROOT}/`)) {
    if (!isStandaloneCandidate(path)) throw new RuntimeMaterializationError("standalone_candidate", "standalone candidate must be named by its exact commit");
    rootLineage(dirname(path));
    return path;
  }
  const allowedRuntime = "/home/workspace/.runtime/factory-conveyor-state-boundary-";
  const profile = loadFactoryPathProfile();
  const external = profile && dirname(path) === profile.releases_root && path.startsWith(`${profile.releases_root}/factory-conveyor-state-boundary-`);
  if (external) canonicalFactoryPath(path);
  const allowedTest = resolve(process.env.RUNTIME_MATERIALIZE_TEST_ROOT ?? "/tmp/runtime-materialize-test");
  if (!external && !path.startsWith(allowedRuntime) && !(process.env.RUNTIME_MATERIALIZE_TEST_MODE === "1" && (path === allowedTest || path.startsWith(`${allowedTest}${sep}`)))) {
    throw new RuntimeMaterializationError("candidate_out_of_scope", "candidate root is outside the authorized inactive-runtime namespace");
  }
  return path;
}

export function normalizeDependencyGraph(value: unknown, candidateRoot: string): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeDependencyGraph(entry, candidateRoot)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().filter((key) => !["path", "resolved", "dev"].includes(key)).map((key) => [key, normalizeDependencyGraph(record[key], candidateRoot)]));
  }
  if (typeof value === "string") return value.replaceAll(candidateRoot, "<runtime>");
  return value;
}

function isContained(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function auditLinks(candidateRoot: string, fullSource: boolean, inertAliases: ReadonlyMap<string, string>, requireNodeModules = true): { links: number; violations: string[] } {
  const rootNodeModules = join(candidateRoot, "node_modules");
  if (requireNodeModules && !existsSync(rootNodeModules)) throw new RuntimeMaterializationError("node_modules_missing", "candidate node_modules is missing");
  let links = 0;
  const violations: string[] = [];
  const auditTree = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (fullSource && dir === candidateRoot && name === ".git") continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        links += 1;
        const sourcePath = relative(candidateRoot, path).split(sep).join("/");
        if (inertAliases.has(sourcePath)) {
          if (readlinkSync(path) !== inertAliases.get(sourcePath)) throw new RuntimeMaterializationError("standalone_source_record", "inert source alias changed during audit");
          continue; // An exact Git record, never a dependency or a dereference.
        }
        let target: string;
        try { target = realpathSync(path); }
        catch { violations.push(sourcePath + " -> unresolved link"); continue; }
        if (!isContained(candidateRoot, target)) violations.push(`${relative(candidateRoot, path)} -> ${target}`);
        continue;
      }
      if (stat.isDirectory()) auditTree(path);
    }
  };
  const discoverBoundaries = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === ".git") continue;
      const path = join(dir, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;
      if (name === "node_modules") {
        auditTree(path);
        continue;
      }
      discoverBoundaries(path);
    }
  };
  if (fullSource) auditTree(candidateRoot); else discoverBoundaries(candidateRoot);
  return { links, violations: violations.sort() };
}

export function auditDependencyLinks(candidateRoot: string, fullSource = false): { links: number; violations: string[] } {
  return auditLinks(candidateRoot, fullSource, new Map());
}

// These historical records are outside the pinned pnpm workspace. Keeping their
// Git bytes is required for a clean source tree; they provide no runtime input.
// Never admit caller-supplied exclusions or follow an alias to its former host.
const INERT_SOURCE_ALIASES: Readonly<Record<string, string>> = {
  "AVATAR-USER.md": "AVATAR-KEVIN.md",
  "evaluations/bench": "/home/workspace/zouroboros/packages/bench/evaluations",
  "evaluations/rag": "/home/workspace/zouroboros/packages/rag/evaluations",
  "evaluations/swarm": "/home/workspace/zouroboros/packages/zo-swarm-orchestrator/evaluations",
  "Projects/zourobench-2026/node_modules": "hal-adapter/node_modules",
};
const INERT_ALIAS_WORKSPACE_BLOB = "dda638de2b858681bdb3740c2cc5ba7d5df3db32";
function gitBlob(data: string | Uint8Array): string {
  const bytes = Buffer.from(data);
  return createHash("sha1").update("blob " + bytes.length + "\0").update(bytes).digest("hex");
}

async function standaloneSourceAliases(candidateRoot: string, exactCommit: string): Promise<ReadonlyMap<string, string>> {
  const aliases = new Map<string, string>();
  const entries = await run("git", ["ls-tree", "-rz", "--full-tree", exactCommit], candidateRoot);
  for (const record of entries.split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (blob|commit) ([a-f0-9]{40})\t(.+)$/s.exec(record);
    if (!match) throw new RuntimeMaterializationError("standalone_source_record", "invalid Git source inventory");
    const [, mode, type, object, name] = match;
    if (mode === "160000") {
      const path = join(candidateRoot, name);
      rootLineage(path);
      const stat = lstatSync(path);
      if (!stat.isDirectory() || readdirSync(path).length) throw new RuntimeMaterializationError("standalone_gitlink", "unrelated Git submodules must remain uninitialized");
      continue;
    }
    if (!Object.hasOwn(INERT_SOURCE_ALIASES, name)) continue;
    const expected = INERT_SOURCE_ALIASES[name];
    if (mode !== "120000" || type !== "blob" || object !== gitBlob(expected)) {
      throw new RuntimeMaterializationError("standalone_source_record", "historical source alias differs from its reviewed Git record");
    }
    const path = join(candidateRoot, name);
    rootLineage(dirname(path));
    const stat = lstatSync(path);
    if (!stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== 0 || readlinkSync(path) !== expected) {
      throw new RuntimeMaterializationError("standalone_source_record", "historical source alias differs from the exact commit");
    }
    aliases.set(name, expected);
  }
  if (aliases.size && gitBlob(readFileSync(join(candidateRoot, "pnpm-workspace.yaml"))) !== INERT_ALIAS_WORKSPACE_BLOB) {
    throw new RuntimeMaterializationError("standalone_source_record", "inert aliases require the reviewed workspace exclusion binding");
  }
  return aliases;
}

export function resolveTemplateLibraryAjv(candidateRoot: string): { entrypoint: string; version: string } {
  const projectManifest = join(candidateRoot, "Projects", "software-template-library", "package.json");
  if (!existsSync(projectManifest)) {
    throw new RuntimeMaterializationError("template_library_missing", "software-template-library package manifest is missing");
  }
  const requireFromProject = createRequire(projectManifest);
  let entrypoint: string;
  let dependencyManifest: string;
  try {
    entrypoint = realpathSync(requireFromProject.resolve("ajv/dist/2020"));
    dependencyManifest = realpathSync(requireFromProject.resolve("ajv/package.json"));
  } catch (error) {
    throw new RuntimeMaterializationError("template_library_ajv_unresolved", `software-template-library Ajv entrypoint is unresolved: ${String(error)}`);
  }
  if (!isContained(candidateRoot, entrypoint) || !isContained(candidateRoot, dependencyManifest)) {
    throw new RuntimeMaterializationError("template_library_ajv_external", "software-template-library Ajv resolves outside the candidate runtime");
  }
  const version = (JSON.parse(readFileSync(dependencyManifest, "utf8")) as { version?: unknown }).version;
  if (version !== "8.17.1") {
    throw new RuntimeMaterializationError("template_library_ajv_version", `expected software-template-library Ajv 8.17.1, found ${String(version)}`);
  }
  return { entrypoint: relative(candidateRoot, entrypoint).split(sep).join("/"), version };
}

export function runtimeKey(input: Omit<RuntimeMaterializationAttestation, "version" | "candidate_root" | "normalized_dependency_graph_sha256" | "runtime_key_sha256" | "dependency_link_count" | "tracked_clean"> & { normalized_dependency_graph_sha256: string }): string {
  return sha256(JSON.stringify({
    merge_commit: input.merge_commit,
    merge_tree: input.merge_tree,
    package_json_sha256: input.package_json_sha256,
    pnpm_lock_sha256: input.pnpm_lock_sha256,
    pnpm_workspace_sha256: input.pnpm_workspace_sha256,
    pnpm_version: input.pnpm_version,
    bun_version: input.bun_version,
    os: input.os,
    arch: input.arch,
    install_flags: input.install_flags,
    normalized_dependency_graph_sha256: input.normalized_dependency_graph_sha256,
    template_library_ajv_entrypoint: input.template_library_ajv_entrypoint,
    template_library_ajv_version: input.template_library_ajv_version,
    ...(input.path_profile_sha256 ? { path_profile_sha256: input.path_profile_sha256 } : {}),
  }));
}

async function installAndAttest(candidateRoot: string, exactCommit: string, mergeTree: string, check: () => void): Promise<RuntimeMaterializationAttestation> {
  check();
  if (isStandaloneCandidate(candidateRoot)) {
    const before = await run("git", ["status", "--porcelain", "--untracked-files=all"], candidateRoot);
    if (before) throw new RuntimeMaterializationError("tracked_drift", "standalone candidate is dirty before installation");
    // Pnpm hooks/config can execute or redirect independently of lifecycle
    // scripts. This bounded standalone route admits no project hook/config.
    for (const name of [".npmrc", ".pnpmfile.cjs", ".pnpmfile.js", "pnpmfile.cjs", "pnpmfile.js"]) {
      try { lstatSync(join(candidateRoot, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      throw new RuntimeMaterializationError("standalone_pnpm_config", "repository pnpm hook/config requires separate reviewed support");
    }
    for (const name of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      const stat = lstatSync(join(candidateRoot, name));
      if (!stat.isFile() || stat.uid !== 0 || stat.gid !== 0 || (stat.mode & 0o022)) throw new RuntimeMaterializationError("standalone_pnpm_config", "root-controlled package inputs required");
    }
    const aliases = await standaloneSourceAliases(candidateRoot, exactCommit);
    const sourceAudit = auditLinks(candidateRoot, true, aliases, false);
    if (sourceAudit.violations.length) throw new RuntimeMaterializationError("cross_runtime_link", sourceAudit.violations.join("\n"));
    check();
  }
  const pnpmVersion = await run("pnpm", ["--version"], candidateRoot);
  if (pnpmVersion !== REQUIRED_PNPM_VERSION) {
    throw new RuntimeMaterializationError("pnpm_version_mismatch", `expected pnpm ${REQUIRED_PNPM_VERSION}, found ${pnpmVersion}`);
  }
  check();
  await run("pnpm", ["install", ...MATERIALIZE_FLAGS], candidateRoot);
  check();
  const graphRaw = await run("pnpm", ["list", "--depth", "Infinity", "--json"], candidateRoot);
  const graph = normalizeDependencyGraph(JSON.parse(graphRaw), candidateRoot);
  const graphHash = sha256(JSON.stringify(graph));
  const standalone = isStandaloneCandidate(candidateRoot);
  const aliases = standalone ? await standaloneSourceAliases(candidateRoot, exactCommit) : new Map<string, string>();
  const linkAudit = auditLinks(candidateRoot, standalone, aliases);
  if (linkAudit.violations.length) throw new RuntimeMaterializationError("cross_runtime_link", linkAudit.violations.join("\n"));
  const templateLibraryAjv = resolveTemplateLibraryAjv(candidateRoot);
  const status = await run("git", ["status", "--porcelain", "--untracked-files=all"], candidateRoot);
  if (status) throw new RuntimeMaterializationError("tracked_drift", `candidate source is not clean:\n${status}`);
  if (await run("git", ["rev-parse", "HEAD"], candidateRoot) !== exactCommit || await run("git", ["rev-parse", "HEAD^{tree}"], candidateRoot) !== mergeTree) {
    throw new RuntimeMaterializationError("commit_changed", "candidate commit or tree changed during materialization");
  }
  check();

  const keyInput = {
    ...(!isStandaloneCandidate(candidateRoot) && loadFactoryPathProfile() ? { path_profile_sha256: process.env.FACTORY_PATH_PROFILE_SHA256! } : {}),
    merge_commit: exactCommit,
    merge_tree: mergeTree,
    package_json_sha256: sha256(readFileSync(join(candidateRoot, "package.json"))),
    pnpm_lock_sha256: sha256(readFileSync(join(candidateRoot, "pnpm-lock.yaml"))),
    pnpm_workspace_sha256: sha256(readFileSync(join(candidateRoot, "pnpm-workspace.yaml"))),
    pnpm_version: pnpmVersion,
    bun_version: Bun.version,
    os: platform(),
    arch: arch(),
    install_flags: [...MATERIALIZE_FLAGS],
    normalized_dependency_graph_sha256: graphHash,
    template_library_ajv_entrypoint: templateLibraryAjv.entrypoint,
    template_library_ajv_version: templateLibraryAjv.version,
  };
  return {
    version: 1,
    candidate_root: candidateRoot,
    ...keyInput,
    runtime_key_sha256: runtimeKey(keyInput),
    dependency_link_count: linkAudit.links,
    tracked_clean: true,
  };
}

export async function materializeRuntime(sourceRootInput: string, commit: string, candidateInput: string): Promise<RuntimeMaterializationAttestation> {
  const sourceRoot = resolve(sourceRootInput);
  const candidateRoot = canonicalCandidate(candidateInput);
  const standalone = isStandaloneCandidate(candidateRoot);
  if (existsSync(candidateRoot)) throw new RuntimeMaterializationError("candidate_exists", "candidate root must not exist");
  const sourceLineage = standalone ? rootLineage(sourceRoot) : [];
  const parentLineage = standalone ? rootLineage(dirname(candidateRoot)) : [];
  const repositoryRoot = await run("git", ["rev-parse", "--show-toplevel"], sourceRoot, standalone);
  const exactCommit = await run("git", ["rev-parse", `${commit}^{commit}`], sourceRoot, standalone);
  if (standalone && (commit !== exactCommit || candidateRoot !== `${STANDALONE_RUNTIME_ROOT}/${exactCommit}`)) {
    throw new RuntimeMaterializationError("standalone_commit", "standalone materialization requires the exact commit in both input and directory name");
  }
  const commonGit = standalone ? rootLineage(await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], sourceRoot, standalone)) : [];
  const mergeTree = await run("git", ["rev-parse", `${exactCommit}^{tree}`], sourceRoot, standalone);
  const check = () => { recheckLineage(sourceLineage); recheckLineage(parentLineage); recheckLineage(commonGit); };
  check();
  await run("git", ["worktree", "add", "--detach", candidateRoot, exactCommit], repositoryRoot, standalone);
  const candidateLineage = standalone ? rootLineage(candidateRoot) : [];
  return installAndAttest(candidateRoot, exactCommit, mergeTree, () => { check(); recheckLineage(candidateLineage); });
}

/** Re-run the same offline installation after reviewed native augmentation; never reuse a prior link count or clean claim. */
export async function refreshStandaloneRuntime(commit: string, candidateInput: string): Promise<RuntimeMaterializationAttestation> {
  const candidateRoot = canonicalCandidate(candidateInput);
  if (!isStandaloneCandidate(candidateRoot) || !/^[a-f0-9]{40}$/.test(commit) || candidateRoot !== `${STANDALONE_RUNTIME_ROOT}/${commit}`) {
    throw new RuntimeMaterializationError("standalone_commit", "refresh is restricted to an existing exact standalone commit directory");
  }
  const lineage = rootLineage(candidateRoot);
  const commonGit = rootLineage(await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], candidateRoot));
  if (await run("git", ["rev-parse", "--show-toplevel"], candidateRoot) !== candidateRoot || await run("git", ["rev-parse", "HEAD"], candidateRoot) !== commit) {
    throw new RuntimeMaterializationError("standalone_commit", "refresh requires the retained candidate worktree at its exact commit");
  }
  const mergeTree = await run("git", ["rev-parse", "HEAD^{tree}"], candidateRoot);
  return installAndAttest(candidateRoot, commit, mergeTree, () => { recheckLineage(lineage); recheckLineage(commonGit); });
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const command = args.shift();
  const value = (name: string): string | undefined => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  if (command !== "materialize" && command !== "refresh-standalone") throw new RuntimeMaterializationError("usage", "usage: runtime-materialize.ts materialize --source <repo> --commit <sha> --candidate <path>, or refresh-standalone --commit <sha> --candidate <path>");
  const source = value("--source");
  const commit = value("--commit");
  const candidate = value("--candidate");
  if (!commit || !candidate || (command === "materialize" && !source) || (command === "refresh-standalone" && source)) throw new RuntimeMaterializationError("usage", "exact materialize or refresh inputs required");
  console.log(JSON.stringify(command === "materialize" ? await materializeRuntime(source!, commit, candidate) : await refreshStandaloneRuntime(commit, candidate), null, 2));
}
