#!/usr/bin/env bun
/**
 * Dangerous-operation detector for elevated tasks (threat-model R5).
 *
 * Deterministic and pure: no LLM, no filesystem, no network. Runs before
 * policy classification and can only RAISE a category, REJECT a request, or
 * declare it UNCLASSIFIABLE (which the classifier turns into a hold). It never
 * lowers a category, so a detector miss can only be a missed raise.
 *
 * Seeded from the runbook's "human-gated forever" list (`.mcp.json`, every
 * file under `/etc/zouroboros`, systemd units, secrets, `git main`) plus the
 * destructive shell shapes enumerated in the Command Center threat model.
 *
 * Input is an argv array executed without a shell. When argv[0] is a shell
 * with `-c`, the inline script is tokenized (quotes, operators, redirections)
 * and each pipeline segment is analysed; command substitution, unresolved
 * variable expansion, `eval`, heredocs, and nesting deeper than two levels are
 * unclassifiable because their effect cannot be determined statically.
 */

import { posix } from "node:path";
import { ELEVATED_CATEGORIES, maxCategory, type DetectorVerdict, type ElevatedCategory } from "./elevated-task-contract";

// ─── Rule table ───────────────────────────────────────────────────────────────

export type DetectorAction = "reject" | "raise" | "unclassifiable";

export interface DetectorRule {
  id: string;
  action: DetectorAction;
  minimum_category: ElevatedCategory | null;
  description: string;
}

function rule(id: string, action: DetectorAction, minimum: ElevatedCategory | null, description: string): DetectorRule {
  return { id, action, minimum_category: minimum, description };
}

/** Every rule the detector can emit, by id. Tests pin this table. */
export const DETECTOR_RULES: Readonly<Record<string, DetectorRule>> = Object.freeze(
  Object.fromEntries(
    [
      // Human-gated forever (runbook agent-handoff §4): reject outright.
      rule("ET-HG-MCP-CONFIG", "reject", null, "MCP configuration files are human-gated forever"),
      rule("ET-HG-ETC-ZOUROBOROS", "reject", null, "/etc/zouroboros is human-gated forever"),
      rule("ET-HG-SYSTEMD-UNIT", "reject", null, "systemd unit files and unit configuration are human-gated forever"),
      rule("ET-HG-SECRET-FILE", "reject", null, "secret and credential files are human-gated forever"),
      rule("ET-HG-HARNESS-STORE", "reject", null, "harness credential stores (~/.claude, ~/.codex, ~/.ssh, ...) are human-gated forever"),
      rule("ET-HG-GIT-MAIN", "reject", null, "pushes to main/master and force pushes are human-gated forever"),
      rule("ET-HG-PR-MERGE", "reject", null, "merging to a protected branch is human-gated forever"),
      rule("ET-HG-ETC-WRITE", "reject", null, "writes, ownership or mode changes under /etc are human-gated forever"),
      rule("ET-HG-EDGE-IDENTITY", "reject", null, "tailscale serve/funnel/up/down/set changes the perimeter"),
      rule("ET-HG-GH-AUTH", "reject", null, "gh auth and gh secret mutate credentials"),
      // Destructive shapes: reject.
      rule("ET-DET-PRIV", "reject", null, "privilege escalation (sudo/su/doas/pkexec)"),
      rule("ET-DET-DISK", "reject", null, "raw disk or filesystem operations (dd/mkfs/fdisk/parted/wipefs/shred)"),
      rule("ET-DET-DEVICE", "reject", null, "writes to block devices, /proc/sys or /sys"),
      rule("ET-DET-RM-ROOT", "reject", null, "recursive delete of a root-like path (/, ~, cwd, or a parent of cwd)"),
      rule("ET-DET-PIPE-TO-SHELL", "reject", null, "piping fetched or generated content into a shell"),
      rule("ET-DET-POWER", "reject", null, "reboot/shutdown/halt/poweroff"),
      rule("ET-DET-FIREWALL", "reject", null, "firewall mutation (iptables/nft/ufw)"),
      rule("ET-DET-ACCOUNTS", "reject", null, "account or sudoers mutation"),
      rule("ET-DET-CRONTAB", "reject", null, "crontab edit/replace/remove"),
      rule("ET-DET-BACKUP-DESTROY", "reject", null, "restic forget/prune/unlock/init"),
      // Destructive shapes: raise.
      rule("ET-DET-RM-RECURSIVE", "raise", "production", "recursive delete outside cwd and scratch roots"),
      rule("ET-DET-RM-IN-CWD", "raise", "branch-write", "recursive delete inside cwd"),
      rule("ET-DET-RM", "raise", "branch-write", "non-recursive delete"),
      rule("ET-DET-SERVICE-STOP", "raise", "production", "systemctl stop/kill"),
      rule("ET-DET-SERVICE-RESTART", "raise", "staging", "systemctl start/restart/reload"),
      rule("ET-DET-PROCESS-KILL", "raise", "production", "kill/pkill/killall"),
      rule("ET-DET-PACKAGE-INSTALL", "raise", "production", "system-wide package install or removal"),
      rule("ET-DET-CONTAINER-DESTROY", "raise", "production", "docker/podman rm/rmi/prune/down -v"),
      rule("ET-DET-CONTAINER-LIFECYCLE", "raise", "staging", "docker/podman up/start/stop/restart"),
      rule("ET-DET-CC-CLONE-WRITE", "raise", "production", "write into the live Command Center clone"),
      rule("ET-DET-STATE-DIR-WRITE", "raise", "staging", "write under /var/lib/zouroboros"),
      rule("ET-DET-NETWORK-MUTATION", "raise", "staging", "HTTP request with a mutating method or body"),
      rule("ET-DET-GIT-PUSH", "raise", "branch-write", "push to a non-protected branch"),
      rule("ET-DET-GIT-PUSH-DESTRUCTIVE", "raise", "staging", "force push or branch deletion on a non-protected branch"),
      rule("ET-DET-GIT-WRITE", "raise", "branch-write", "local git mutation (commit/merge/rebase/reset/clean/...)"),
      rule("ET-DET-GH-PR-CREATE", "raise", "open-pr", "gh pr create"),
      rule("ET-DET-GH-MUTATION", "raise", "staging", "other gh mutation (issue/label/release edit, api with mutating method)"),
      rule("ET-DET-FILE-WRITE", "raise", "branch-write", "file write inside cwd"),
      rule("ET-DET-FILE-WRITE-OUTSIDE", "raise", "staging", "file write outside cwd and scratch roots"),
      rule("ET-DET-CHMOD", "raise", "branch-write", "ownership or mode change inside cwd"),
      rule("ET-DET-CHMOD-OUTSIDE", "raise", "staging", "ownership or mode change outside cwd"),
      rule("ET-DET-BACKUP-WRITE", "raise", "staging", "restic backup/rebuild"),
      // Unclassifiable: hold.
      rule("ET-DET-NESTED-SHELL", "unclassifiable", null, "shell nesting deeper than two levels"),
      rule("ET-DET-EVAL", "unclassifiable", null, "eval/source/exec/xargs"),
      rule("ET-DET-INLINE-CODE", "unclassifiable", null, "interpreter with inline code"),
      rule("ET-DET-SUBSTITUTION", "unclassifiable", null, "command substitution, process substitution or heredoc"),
      rule("ET-DET-VARIABLE", "unclassifiable", null, "unresolved variable expansion"),
      rule("ET-DET-DECODE", "unclassifiable", null, "base64/hex decoding in a pipeline"),
      rule("ET-DET-TOKENIZE", "unclassifiable", null, "inline script could not be tokenized"),
      rule("ET-DET-GIT-PUSH-IMPLICIT", "unclassifiable", null, "git push without an explicit refspec"),
      rule("ET-DET-UNKNOWN-SHELL-FORM", "unclassifiable", null, "shell invoked without -c or a script path"),
    ].map((entry) => [entry.id, entry]),
  ),
);

// ─── Public types ─────────────────────────────────────────────────────────────

export interface DetectorInput {
  argv: string[];
  cwd: string;
  /** Home directory used for `~` expansion. Defaults to `/home/zouroboros`. */
  home?: string;
  /** Directories where recursive deletes are not raised. Defaults to /tmp, /var/tmp, <cwd>/.swarm/scratch. */
  scratch_roots?: string[];
  /** Absolute path of the live Command Center clone. Defaults to /opt/zouroboros/command-center. */
  cc_clone_root?: string;
}

export interface DetectorFinding {
  rule_id: string;
  action: DetectorAction;
  minimum_category: ElevatedCategory | null;
  segment: number;
  token: string;
}

export interface DetectorResult {
  verdict: DetectorVerdict;
  minimum_category: ElevatedCategory | null;
  rule_ids: string[];
  findings: DetectorFinding[];
  /** Pipeline segments after tokenization (argv-level when no shell is involved). */
  segments: string[][];
}

// ─── Tokenizer ────────────────────────────────────────────────────────────────

export const SHELL_OPERATOR_TOKENS = [";", "&&", "||", "|", "|&", "&", "\n"] as const;
const REDIRECT_TOKEN = /^(\d*>>?|\d*>\||&>>?|<>|<)$/;

export interface TokenizeResult {
  ok: true;
  segments: string[][];
}

export interface TokenizeFailure {
  ok: false;
  rule_id: "ET-DET-SUBSTITUTION" | "ET-DET-VARIABLE" | "ET-DET-TOKENIZE";
  detail: string;
}

/**
 * Minimal POSIX-shell tokenizer. Produces pipeline segments split on `;`, `&&`,
 * `||`, `|`, `&`, and newlines. Quotes and backslashes are honoured; `~` and
 * `$HOME` expand to `home`; every other expansion or substitution is a failure.
 */
export function tokenizeShellScript(script: string, home: string): TokenizeResult | TokenizeFailure {
  const segments: string[][] = [];
  let current: string[] = [];
  let token = "";
  let hasToken = false;
  let index = 0;
  const flush = (): void => {
    if (hasToken) current.push(token);
    token = "";
    hasToken = false;
  };
  const endSegment = (): void => {
    flush();
    if (current.length > 0) segments.push(current);
    current = [];
  };
  const expandVariable = (name: string): string | null => (name === "HOME" ? home : null);
  while (index < script.length) {
    const char = script[index]!;
    if (char === "#" && !hasToken) {
      while (index < script.length && script[index] !== "\n") index += 1;
      continue;
    }
    if (char === "'") {
      const end = script.indexOf("'", index + 1);
      if (end === -1) return { ok: false, rule_id: "ET-DET-TOKENIZE", detail: "unterminated single quote" };
      token += script.slice(index + 1, end);
      hasToken = true;
      index = end + 1;
      continue;
    }
    if (char === '"') {
      index += 1;
      let closed = false;
      while (index < script.length) {
        const inner = script[index]!;
        if (inner === "\\" && index + 1 < script.length) {
          token += script[index + 1];
          index += 2;
          continue;
        }
        if (inner === '"') {
          closed = true;
          index += 1;
          break;
        }
        if (inner === "`") return { ok: false, rule_id: "ET-DET-SUBSTITUTION", detail: "backtick substitution" };
        if (inner === "$") {
          const rest = script.slice(index + 1);
          if (rest.startsWith("(")) return { ok: false, rule_id: "ET-DET-SUBSTITUTION", detail: "command substitution" };
          const braced = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
          const bare = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
          const match = braced ?? bare;
          if (match) {
            const value = expandVariable(match[1]!);
            if (value === null) return { ok: false, rule_id: "ET-DET-VARIABLE", detail: `$${match[1]}` };
            token += value;
            index += 1 + match[0].length;
            continue;
          }
        }
        token += inner;
        index += 1;
      }
      if (!closed) return { ok: false, rule_id: "ET-DET-TOKENIZE", detail: "unterminated double quote" };
      hasToken = true;
      continue;
    }
    if (char === "\\") {
      if (index + 1 >= script.length) return { ok: false, rule_id: "ET-DET-TOKENIZE", detail: "trailing backslash" };
      if (script[index + 1] === "\n") {
        index += 2;
        continue;
      }
      token += script[index + 1];
      hasToken = true;
      index += 2;
      continue;
    }
    if (char === "`") return { ok: false, rule_id: "ET-DET-SUBSTITUTION", detail: "backtick substitution" };
    if (char === "$") {
      const rest = script.slice(index + 1);
      if (rest.startsWith("(")) return { ok: false, rule_id: "ET-DET-SUBSTITUTION", detail: "command or arithmetic substitution" };
      const braced = /^\{([A-Za-z_][A-Za-z0-9_]*)\}/.exec(rest);
      const bare = /^([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
      const match = braced ?? bare;
      if (match) {
        const value = expandVariable(match[1]!);
        if (value === null) return { ok: false, rule_id: "ET-DET-VARIABLE", detail: `$${match[1]}` };
        token += value;
        hasToken = true;
        index += 1 + match[0].length;
        continue;
      }
      return { ok: false, rule_id: "ET-DET-VARIABLE", detail: "special parameter" };
    }
    if (char === "<" && script.startsWith("<<", index)) {
      return { ok: false, rule_id: "ET-DET-SUBSTITUTION", detail: "heredoc" };
    }
    if ((char === "<" || char === ">") && script[index + 1] === "(") {
      return { ok: false, rule_id: "ET-DET-SUBSTITUTION", detail: "process substitution" };
    }
    if (char === "\n" || char === ";") {
      endSegment();
      index += 1;
      continue;
    }
    if (char === "&" || char === "|") {
      const two = script.slice(index, index + 2);
      if (two === "&>" ) {
        flush();
        const three = script.slice(index, index + 3);
        token = three === "&>>" ? "&>>" : "&>";
        hasToken = true;
        flush();
        index += token.length || 2;
        continue;
      }
      endSegment();
      index += two === "&&" || two === "||" || two === "|&" ? 2 : 1;
      continue;
    }
    if (char === ">" || char === "<") {
      flush();
      let op = char;
      if (script[index + 1] === ">" || script[index + 1] === "|" || (char === "<" && script[index + 1] === ">")) {
        op += script[index + 1];
        index += 1;
      }
      if (/^\d+$/.test(token)) op = token + op;
      current.push(op);
      index += 1;
      continue;
    }
    if (char === " " || char === "\t") {
      flush();
      index += 1;
      continue;
    }
    if (char === "~" && !hasToken && (index + 1 >= script.length || script[index + 1] === "/" || /\s/.test(script[index + 1]!))) {
      token += home;
      hasToken = true;
      index += 1;
      continue;
    }
    token += char;
    hasToken = true;
    index += 1;
  }
  endSegment();
  return { ok: true, segments };
}

// ─── Path helpers ─────────────────────────────────────────────────────────────

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "fish"]);
const WRAPPERS = new Set(["env", "nice", "nohup", "ionice", "stdbuf", "command", "builtin", "time"]);
const PRIVILEGE = new Set(["sudo", "su", "doas", "pkexec", "runuser"]);
const DISK = new Set(["dd", "mkfs", "fdisk", "sfdisk", "parted", "gparted", "wipefs", "shred", "blkdiscard", "mkswap"]);
const POWER = new Set(["reboot", "shutdown", "halt", "poweroff", "init", "telinit"]);
const FIREWALL = new Set(["iptables", "ip6tables", "nft", "ufw", "firewall-cmd"]);
const ACCOUNTS = new Set(["useradd", "userdel", "usermod", "groupadd", "groupdel", "groupmod", "passwd", "chpasswd", "visudo", "adduser", "deluser"]);
const PROCESS_KILL = new Set(["kill", "pkill", "killall"]);
const EVAL_LIKE = new Set(["eval", "source", ".", "exec", "xargs", "parallel"]);
const DECODERS = new Set(["base64", "xxd", "base32", "uudecode", "openssl"]);
const PACKAGE_MANAGERS = new Set(["apt", "apt-get", "dpkg", "snap", "yum", "dnf", "pacman", "pipx", "brew"]);
const WRITE_PROGRAMS = new Set(["mv", "cp", "tee", "truncate", "ln", "mkdir", "touch", "install", "rsync", "unzip", "tar", "patch", "dd"]);
const CHMOD_PROGRAMS = new Set(["chmod", "chown", "chgrp", "setfacl", "chattr"]);
const INLINE_CODE_FLAGS: Record<string, string[]> = {
  python: ["-c"],
  python3: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  bun: ["-e", "--eval", "--print"],
  deno: ["eval"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
  php: ["-r"],
};

function basename(program: string): string {
  const name = program.split("/").pop() ?? program;
  return name.replace(/^(python|node)\d[\d.]*$/, "$1");
}

function looksLikePath(token: string): boolean {
  return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.includes("/") || token.startsWith(".");
}

function normalizePath(token: string, cwd: string, home: string): string {
  let raw = token;
  if (raw === "~") raw = home;
  else if (raw.startsWith("~/")) raw = home + raw.slice(1);
  if (raw.startsWith("$HOME")) raw = home + raw.slice(5);
  const absolute = raw.startsWith("/") ? raw : posix.join(cwd, raw);
  return posix.normalize(absolute).replace(/\/+$/, "") || "/";
}

function isUnder(path: string, root: string): boolean {
  const normalizedRoot = root.replace(/\/+$/, "") || "/";
  if (normalizedRoot === "/") return true;
  return path === normalizedRoot || path.startsWith(`${normalizedRoot}/`);
}

/** Candidate path strings in a token: the whole token and any `--flag=value` value. */
function pathCandidates(token: string): string[] {
  const candidates = [token];
  const eq = token.indexOf("=");
  if (eq > 0 && !token.startsWith("/")) candidates.push(token.slice(eq + 1));
  return candidates.filter((candidate) => candidate.length > 0);
}

const MCP_CONFIG = /(^|\/)(\.mcp\.json|\.kimi-code\/mcp\.json|\.codex\/config\.toml|\.gemini\/settings\.json|mcp\.json)$/;
const SECRET_FILE =
  /(^|\/)(\.env(\.[A-Za-z0-9_-]+)?|[A-Za-z0-9_-]+\.env|restic-password|\.zo_secrets|secrets?\.(json|ya?ml|toml|env)|auth\.json|credentials(\.json)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials|id_(rsa|dsa|ecdsa|ed25519)|[A-Za-z0-9_.-]+\.(pem|key|p12|pfx|jks|kdbx))$/;
const SECRET_FILE_EXEMPT = /\.(template|example|sample|dist)$/;
const HARNESS_STORE = /(^|\/)(\.claude|\.codex|\.gemini|\.hermes|\.kimi|\.kimi-code|\.pi|\.ssh|\.gnupg|\.aws|\.docker|\.config\/gh|\.config\/opencode|\.local\/share\/opencode|\.zouroboros\/cc)(\/|$)/;
const SYSTEMD_DIR = /^\/(etc|lib|usr\/lib|run)\/systemd(\/|$)|(^|\/)\.config\/systemd(\/|$)/;
const SYSTEMD_UNIT = /\.(service|timer|socket|mount|automount|path|target|slice|scope)$/;
const DEVICE = /^\/dev\/(sd|vd|nvme|xvd|hd|mmcblk|loop|mapper\/|mem$|kmem$|port$)|^\/(proc\/sys|sys)(\/|$)|^\/boot(\/|$)/;

interface PathContext {
  cwd: string;
  home: string;
  scratch: string[];
  ccClone: string;
}

/** Path rules that apply to any reference, read or write. */
function referencePathRules(path: string, raw: string): string[] {
  const hits: string[] = [];
  if (MCP_CONFIG.test(path) || MCP_CONFIG.test(raw)) hits.push("ET-HG-MCP-CONFIG");
  if (isUnder(path, "/etc/zouroboros")) hits.push("ET-HG-ETC-ZOUROBOROS");
  if (SYSTEMD_DIR.test(path) || (SYSTEMD_UNIT.test(path) && /^\/(etc|lib|usr|run)\//.test(path))) hits.push("ET-HG-SYSTEMD-UNIT");
  if ((SECRET_FILE.test(path) || SECRET_FILE.test(raw)) && !SECRET_FILE_EXEMPT.test(path)) hits.push("ET-HG-SECRET-FILE");
  if (HARNESS_STORE.test(path) || HARNESS_STORE.test(raw)) hits.push("ET-HG-HARNESS-STORE");
  return hits;
}

/** Path rules that apply only when the program writes. */
function writePathRules(path: string, context: PathContext): { rule: string; category: ElevatedCategory | null } | null {
  if (DEVICE.test(path)) return { rule: "ET-DET-DEVICE", category: null };
  if (isUnder(path, "/etc")) return { rule: "ET-HG-ETC-WRITE", category: null };
  if (isUnder(path, context.ccClone)) return { rule: "ET-DET-CC-CLONE-WRITE", category: "production" };
  if (isUnder(path, "/var/lib/zouroboros")) return { rule: "ET-DET-STATE-DIR-WRITE", category: "staging" };
  if (context.scratch.some((root) => isUnder(path, root))) return null;
  if (isUnder(path, context.cwd)) return { rule: "ET-DET-FILE-WRITE", category: "branch-write" };
  return { rule: "ET-DET-FILE-WRITE-OUTSIDE", category: "staging" };
}

// ─── Segment analysis ─────────────────────────────────────────────────────────

interface Analyzer {
  context: PathContext;
  findings: DetectorFinding[];
  segments: string[][];
  depth: number;
}

function emit(analyzer: Analyzer, ruleId: string, segment: number, token: string): void {
  const entry = DETECTOR_RULES[ruleId];
  if (!entry) throw new Error(`unknown detector rule ${ruleId}`);
  analyzer.findings.push({ rule_id: ruleId, action: entry.action, minimum_category: entry.minimum_category, segment, token });
}

function stripWrappers(tokens: string[]): string[] {
  let rest = tokens;
  for (;;) {
    if (rest.length === 0) return rest;
    const program = basename(rest[0]!);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[0]!)) {
      rest = rest.slice(1);
      continue;
    }
    if (program === "timeout") {
      let cursor = 1;
      while (cursor < rest.length && rest[cursor]!.startsWith("-")) cursor += rest[cursor]!.includes("=") ? 1 : 2;
      rest = rest.slice(cursor + 1);
      continue;
    }
    if (WRAPPERS.has(program)) {
      let cursor = 1;
      while (cursor < rest.length && (rest[cursor]!.startsWith("-") || /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[cursor]!))) cursor += 1;
      rest = rest.slice(cursor);
      continue;
    }
    return rest;
  }
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg) || (arg.startsWith("-") && !arg.startsWith("--") && flags.some((flag) => flag.length === 2 && arg.includes(flag[1]!))));
}

function nonFlagArgs(args: string[]): string[] {
  return args.filter((arg) => !arg.startsWith("-"));
}

function analyzeGit(analyzer: Analyzer, args: string[], segmentIndex: number): void {
  const sub = nonFlagArgs(args)[0];
  const token = `git ${args.join(" ")}`;
  if (sub === undefined) return;
  if (sub === "push") {
    const pushArgs = args.slice(args.indexOf("push") + 1);
    const force = hasFlag(pushArgs, "-f", "--force", "--force-with-lease", "--force-if-includes") || pushArgs.some((arg) => arg.startsWith("+"));
    const deleting = hasFlag(pushArgs, "-d", "--delete") || pushArgs.some((arg) => /^:.+/.test(arg));
    const refspecs = nonFlagArgs(pushArgs).slice(1);
    const toProtected = refspecs.some((spec) => /(^|:|refs\/heads\/)(main|master)$/.test(spec.replace(/^\+/, "")));
    if (toProtected || (force && refspecs.length === 0)) {
      emit(analyzer, "ET-HG-GIT-MAIN", segmentIndex, token);
      return;
    }
    if (refspecs.length === 0 && !deleting) {
      emit(analyzer, "ET-DET-GIT-PUSH-IMPLICIT", segmentIndex, token);
      return;
    }
    emit(analyzer, force || deleting ? "ET-DET-GIT-PUSH-DESTRUCTIVE" : "ET-DET-GIT-PUSH", segmentIndex, token);
    return;
  }
  if (sub === "config" && (args.includes("--global") || args.includes("--system"))) {
    emit(analyzer, "ET-HG-HARNESS-STORE", segmentIndex, token);
    return;
  }
  const localWrites = new Set([
    "commit", "add", "rm", "mv", "merge", "rebase", "reset", "clean", "stash", "cherry-pick", "revert", "am", "apply",
    "tag", "worktree", "submodule", "checkout", "switch", "restore", "config", "filter-branch", "gc", "prune", "reflog", "update-ref", "notes",
  ]);
  if ((sub === "branch" && hasFlag(args, "-d", "-D", "-m", "-M", "--delete", "--move", "--force")) || localWrites.has(sub)) {
    emit(analyzer, "ET-DET-GIT-WRITE", segmentIndex, token);
  }
}

function analyzeGh(analyzer: Analyzer, args: string[], segmentIndex: number): void {
  const [group, verb] = nonFlagArgs(args);
  const token = `gh ${args.join(" ")}`;
  if (group === "auth" || group === "secret" || group === "ssh-key" || group === "gpg-key") {
    emit(analyzer, "ET-HG-GH-AUTH", segmentIndex, token);
    return;
  }
  if (group === "pr" && verb === "merge") {
    emit(analyzer, "ET-HG-PR-MERGE", segmentIndex, token);
    return;
  }
  if (group === "repo" && (verb === "delete" || verb === "archive" || verb === "rename" || verb === "edit")) {
    emit(analyzer, "ET-HG-PR-MERGE", segmentIndex, token);
    return;
  }
  if (group === "pr" && verb === "create") {
    emit(analyzer, "ET-DET-GH-PR-CREATE", segmentIndex, token);
    return;
  }
  if (group === "api") {
    const method = args.find((_, index) => args[index - 1] === "-X" || args[index - 1] === "--method");
    const mutating = (method !== undefined && method.toUpperCase() !== "GET") || hasFlag(args, "-f", "-F", "--field", "--raw-field", "--input");
    if (mutating) emit(analyzer, "ET-DET-GH-MUTATION", segmentIndex, token);
    return;
  }
  const mutatingVerbs = new Set(["create", "edit", "close", "reopen", "delete", "comment", "review", "ready", "lock", "unlock", "transfer", "pin", "unpin", "set-default", "sync", "fork", "clone", "upload", "run", "rerun", "cancel", "enable", "disable"]);
  if (verb !== undefined && mutatingVerbs.has(verb)) emit(analyzer, "ET-DET-GH-MUTATION", segmentIndex, token);
}

function analyzeSystemctl(analyzer: Analyzer, args: string[], segmentIndex: number): void {
  const verb = nonFlagArgs(args)[0];
  const token = `systemctl ${args.join(" ")}`;
  if (verb === undefined) return;
  if (["mask", "unmask", "enable", "disable", "daemon-reload", "daemon-reexec", "edit", "link", "revert", "set-property", "set-default", "preset", "isolate", "switch-root"].includes(verb)) {
    emit(analyzer, "ET-HG-SYSTEMD-UNIT", segmentIndex, token);
    return;
  }
  if (["stop", "kill", "clean", "reset-failed"].includes(verb)) {
    emit(analyzer, "ET-DET-SERVICE-STOP", segmentIndex, token);
    return;
  }
  if (["start", "restart", "reload", "reload-or-restart", "try-restart", "try-reload-or-restart", "condrestart", "force-reload"].includes(verb)) {
    emit(analyzer, "ET-DET-SERVICE-RESTART", segmentIndex, token);
  }
}

function analyzeRm(analyzer: Analyzer, args: string[], segmentIndex: number): void {
  const recursive = hasFlag(args, "-r", "-R", "--recursive") || args.some((arg) => /^-[a-zA-Z]*[rR]/.test(arg));
  const targets = nonFlagArgs(args);
  const { cwd, home, scratch } = analyzer.context;
  if (!recursive) {
    if (targets.length > 0) emit(analyzer, "ET-DET-RM", segmentIndex, `rm ${args.join(" ")}`);
    return;
  }
  for (const target of targets) {
    const path = normalizePath(target.replace(/\/?\*$/, ""), cwd, home);
    const rootLike = path === "/" || path === home || path === cwd || isUnder(cwd, path) || path === "/opt" || path === "/opt/zouroboros" || path === "/var" || path === "/usr" || path === "/home";
    if (rootLike) {
      emit(analyzer, "ET-DET-RM-ROOT", segmentIndex, target);
      continue;
    }
    if (scratch.some((root) => isUnder(path, root))) continue;
    emit(analyzer, isUnder(path, cwd) ? "ET-DET-RM-IN-CWD" : "ET-DET-RM-RECURSIVE", segmentIndex, target);
  }
}

function analyzeDocker(analyzer: Analyzer, args: string[], segmentIndex: number): void {
  const words = nonFlagArgs(args);
  const token = `docker ${args.join(" ")}`;
  const compose = words[0] === "compose" || words[0] === "docker-compose";
  const verb = compose ? words[1] : words[0];
  if (verb === undefined) return;
  const destroy = new Set(["rm", "rmi", "prune", "kill"]);
  if (destroy.has(verb) || (words[0] === "system" && words[1] === "prune") || (words[0] === "volume" && (words[1] === "rm" || words[1] === "prune")) || (compose && verb === "down" && (args.includes("-v") || args.includes("--volumes")))) {
    emit(analyzer, "ET-DET-CONTAINER-DESTROY", segmentIndex, token);
    return;
  }
  if (["up", "down", "start", "stop", "restart", "run", "create", "exec", "pull", "build", "push", "scale", "update"].includes(verb)) {
    emit(analyzer, "ET-DET-CONTAINER-LIFECYCLE", segmentIndex, token);
  }
}

function analyzeCurl(analyzer: Analyzer, program: string, args: string[], segmentIndex: number): void {
  const token = `${program} ${args.join(" ")}`;
  const method = args.find((_, index) => args[index - 1] === "-X" || args[index - 1] === "--request" || args[index - 1] === "--method");
  const body = hasFlag(args, "-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "-F", "--form", "-T", "--upload-file", "--post-data", "--post-file", "--json");
  if ((method !== undefined && method.toUpperCase() !== "GET" && method.toUpperCase() !== "HEAD") || body) {
    emit(analyzer, "ET-DET-NETWORK-MUTATION", segmentIndex, token);
  }
}

function analyzeSegment(analyzer: Analyzer, rawTokens: string[], segmentIndex: number, precededByPipe: boolean): void {
  const { context } = analyzer;
  // Redirections: any `>`/`>>` target is a write.
  const tokens: string[] = [];
  let writeTargets: string[] = [];
  for (let index = 0; index < rawTokens.length; index += 1) {
    const current = rawTokens[index]!;
    if (REDIRECT_TOKEN.test(current)) {
      const target = rawTokens[index + 1];
      if (target !== undefined && !current.startsWith("<") && current !== "<>") writeTargets.push(target);
      index += 1;
      continue;
    }
    tokens.push(current);
  }
  const stripped = stripWrappers(tokens);
  if (stripped.length === 0) {
    for (const target of writeTargets) applyWrite(analyzer, target, segmentIndex);
    return;
  }
  const program = basename(stripped[0]!);
  const args = stripped.slice(1);
  const joined = stripped.join(" ");

  // Reference path rules on every token, regardless of program.
  for (const token of stripped.slice(1)) {
    for (const candidate of pathCandidates(token)) {
      if (!looksLikePath(candidate)) continue;
      const path = normalizePath(candidate, context.cwd, context.home);
      for (const hit of referencePathRules(path, candidate)) emit(analyzer, hit, segmentIndex, token);
    }
  }
  for (const target of writeTargets) applyWrite(analyzer, target, segmentIndex);

  if (PRIVILEGE.has(program)) {
    emit(analyzer, "ET-DET-PRIV", segmentIndex, joined);
    return;
  }
  if (SHELLS.has(program)) {
    const flagIndex = args.findIndex((arg) => arg === "-c" || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
    if (flagIndex === -1) {
      emit(analyzer, precededByPipe ? "ET-DET-PIPE-TO-SHELL" : "ET-DET-UNKNOWN-SHELL-FORM", segmentIndex, joined);
      return;
    }
    const script = args[flagIndex + 1];
    if (script === undefined) {
      emit(analyzer, "ET-DET-UNKNOWN-SHELL-FORM", segmentIndex, joined);
      return;
    }
    analyzeScript(analyzer, script);
    return;
  }
  if (EVAL_LIKE.has(program)) {
    emit(analyzer, "ET-DET-EVAL", segmentIndex, joined);
    return;
  }
  const inlineFlags = INLINE_CODE_FLAGS[program];
  if (inlineFlags && args.some((arg) => inlineFlags.includes(arg))) {
    emit(analyzer, "ET-DET-INLINE-CODE", segmentIndex, joined);
    return;
  }
  if (DECODERS.has(program) && (hasFlag(args, "-d", "--decode", "-r", "-p") || args.includes("enc"))) {
    emit(analyzer, "ET-DET-DECODE", segmentIndex, joined);
    return;
  }
  if (DISK.has(program)) {
    emit(analyzer, "ET-DET-DISK", segmentIndex, joined);
    return;
  }
  if (POWER.has(program)) {
    emit(analyzer, "ET-DET-POWER", segmentIndex, joined);
    return;
  }
  if (FIREWALL.has(program)) {
    emit(analyzer, "ET-DET-FIREWALL", segmentIndex, joined);
    return;
  }
  if (ACCOUNTS.has(program)) {
    emit(analyzer, "ET-DET-ACCOUNTS", segmentIndex, joined);
    return;
  }
  if (program === "crontab" && (args.length === 0 || hasFlag(args, "-e", "-r") || args.some((arg) => !arg.startsWith("-") && arg !== "-l"))) {
    if (!hasFlag(args, "-l")) emit(analyzer, "ET-DET-CRONTAB", segmentIndex, joined);
    return;
  }
  if (program === "tailscale") {
    const verb = nonFlagArgs(args)[0];
    if (verb !== undefined && ["serve", "funnel", "up", "down", "set", "logout", "login", "cert", "ssh", "configure", "switch"].includes(verb)) {
      emit(analyzer, "ET-HG-EDGE-IDENTITY", segmentIndex, joined);
    }
    return;
  }
  if (program === "restic") {
    const verb = nonFlagArgs(args)[0];
    if (verb !== undefined && ["forget", "prune", "unlock", "init", "migrate", "rewrite", "repair"].includes(verb)) {
      emit(analyzer, "ET-DET-BACKUP-DESTROY", segmentIndex, joined);
    } else if (verb !== undefined && ["backup", "rebuild-index", "restore", "copy", "tag"].includes(verb)) {
      emit(analyzer, "ET-DET-BACKUP-WRITE", segmentIndex, joined);
    }
    return;
  }
  if (PROCESS_KILL.has(program)) {
    if (!(program === "kill" && hasFlag(args, "-l"))) emit(analyzer, "ET-DET-PROCESS-KILL", segmentIndex, joined);
    return;
  }
  if (PACKAGE_MANAGERS.has(program)) {
    const verb = nonFlagArgs(args)[0];
    if (verb !== undefined && ["install", "remove", "purge", "upgrade", "dist-upgrade", "full-upgrade", "autoremove", "reinstall", "-i", "-r", "-P", "refresh", "revert", "update", "-S", "-R", "-U"].includes(verb)) {
      emit(analyzer, "ET-DET-PACKAGE-INSTALL", segmentIndex, joined);
    }
    return;
  }
  if ((program === "npm" || program === "pnpm" || program === "yarn" || program === "bun" || program === "pip" || program === "pip3" || program === "cargo") && (args.includes("-g") || args.includes("--global") || (program === "cargo" && args[0] === "install") || (program.startsWith("pip") && args[0] === "install" && !args.includes("--user") && !args.includes("-e")))) {
    emit(analyzer, "ET-DET-PACKAGE-INSTALL", segmentIndex, joined);
    return;
  }
  if (program === "systemctl") {
    analyzeSystemctl(analyzer, args, segmentIndex);
    return;
  }
  if (program === "git") {
    analyzeGit(analyzer, args, segmentIndex);
    return;
  }
  if (program === "gh") {
    analyzeGh(analyzer, args, segmentIndex);
    return;
  }
  if (program === "rm") {
    analyzeRm(analyzer, args, segmentIndex);
    return;
  }
  if (program === "docker" || program === "podman" || program === "docker-compose") {
    analyzeDocker(analyzer, program === "docker-compose" ? ["compose", ...args] : args, segmentIndex);
    return;
  }
  if (program === "curl" || program === "wget" || program === "http" || program === "xh") {
    analyzeCurl(analyzer, program, args, segmentIndex);
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index]!;
      if (arg === "-o" || arg === "--output" || arg === "-O" || arg === "--output-document") {
        const target = args[index + 1];
        if (target !== undefined) applyWrite(analyzer, target, segmentIndex);
      } else if (arg.startsWith("--output=") || arg.startsWith("--output-document=")) {
        applyWrite(analyzer, arg.slice(arg.indexOf("=") + 1), segmentIndex);
      }
    }
    return;
  }
  if (CHMOD_PROGRAMS.has(program)) {
    for (const target of nonFlagArgs(args).slice(1)) {
      const path = normalizePath(target, context.cwd, context.home);
      if (DEVICE.test(path)) emit(analyzer, "ET-DET-DEVICE", segmentIndex, target);
      else if (isUnder(path, "/etc")) emit(analyzer, "ET-HG-ETC-WRITE", segmentIndex, target);
      else if (isUnder(path, context.ccClone)) emit(analyzer, "ET-DET-CC-CLONE-WRITE", segmentIndex, target);
      else emit(analyzer, isUnder(path, context.cwd) ? "ET-DET-CHMOD" : "ET-DET-CHMOD-OUTSIDE", segmentIndex, target);
    }
    return;
  }
  if (program === "sed" || program === "perl") {
    if (hasFlag(args, "-i", "--in-place") || args.some((arg) => /^-i/.test(arg))) {
      for (const target of nonFlagArgs(args).slice(program === "sed" ? 1 : 0)) {
        if (looksLikePath(target) || /\.[A-Za-z0-9]+$/.test(target)) applyWrite(analyzer, target, segmentIndex);
      }
    }
    return;
  }
  if (WRITE_PROGRAMS.has(program)) {
    const targets = nonFlagArgs(args);
    const writeSet = program === "mv" || program === "cp" || program === "ln" || program === "rsync" || program === "install" ? targets.slice(-1) : targets;
    for (const target of writeSet) applyWrite(analyzer, target, segmentIndex);
    if (program === "tar" && args.some((arg) => /^-?[a-zA-Z]*x/.test(arg))) {
      const dest = args.find((_, index) => args[index - 1] === "-C") ?? ".";
      applyWrite(analyzer, dest, segmentIndex);
    }
    return;
  }
}

function applyWrite(analyzer: Analyzer, target: string, segmentIndex: number): void {
  if (target === "/dev/null" || target === "/dev/stdout" || target === "/dev/stderr" || target === "-") return;
  const path = normalizePath(target.replace(/\/?\*$/, ""), analyzer.context.cwd, analyzer.context.home);
  for (const hit of referencePathRules(path, target)) emit(analyzer, hit, segmentIndex, target);
  const write = writePathRules(path, analyzer.context);
  if (write !== null) emit(analyzer, write.rule, segmentIndex, target);
}

function analyzeScript(analyzer: Analyzer, script: string): void {
  if (analyzer.depth >= 2) {
    emit(analyzer, "ET-DET-NESTED-SHELL", analyzer.segments.length, script.slice(0, 120));
    return;
  }
  const tokenized = tokenizeShellScript(script, analyzer.context.home);
  if (!tokenized.ok) {
    emit(analyzer, tokenized.rule_id, analyzer.segments.length, tokenized.detail);
    return;
  }
  analyzer.depth += 1;
  // Segment boundaries carry the operator that preceded them so pipe-to-shell can be detected.
  const pipes = pipeBoundaries(script);
  tokenized.segments.forEach((segment, offset) => {
    const index = analyzer.segments.length;
    analyzer.segments.push(segment);
    analyzeSegment(analyzer, segment, index, pipes[offset] ?? false);
  });
  analyzer.depth -= 1;
}

/** For each segment index, whether the operator immediately before it was a pipe. Quote-aware. */
function pipeBoundaries(script: string): boolean[] {
  const flags: boolean[] = [false];
  let quote: string | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "|" && script[index + 1] !== "|") {
      flags.push(true);
      if (script[index + 1] === "&") index += 1;
    } else if (char === "|" || char === ";" || char === "\n") {
      flags.push(false);
      if (char === "|") index += 1;
    } else if (char === "&" && script[index + 1] !== ">") {
      flags.push(false);
      if (script[index + 1] === "&") index += 1;
    }
  }
  return flags;
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export function defaultScratchRoots(cwd: string): string[] {
  return ["/tmp", "/var/tmp", posix.join(cwd, ".swarm", "scratch")];
}

export function detectDangerousOperation(input: DetectorInput): DetectorResult {
  const home = input.home ?? "/home/zouroboros";
  const cwd = posix.normalize(input.cwd);
  const analyzer: Analyzer = {
    context: {
      cwd,
      home,
      scratch: input.scratch_roots ?? defaultScratchRoots(cwd),
      ccClone: input.cc_clone_root ?? "/opt/zouroboros/command-center",
    },
    findings: [],
    segments: [],
    depth: 0,
  };
  const argv = input.argv.map((arg) => (arg === "~" || arg.startsWith("~/") ? home + arg.slice(1) : arg));
  const program = argv.length > 0 ? basename(stripWrappers(argv)[0] ?? "") : "";
  if (SHELLS.has(program)) {
    // Analysed by analyzeSegment, which recurses into the -c script.
    analyzer.segments.push(argv);
    analyzeSegment(analyzer, argv, 0, false);
  } else {
    analyzer.segments.push(argv);
    analyzeSegment(analyzer, argv, 0, false);
  }
  return summarize(analyzer);
}

function summarize(analyzer: Analyzer): DetectorResult {
  const findings = analyzer.findings;
  const ruleIds = [...new Set(findings.map((finding) => finding.rule_id))].sort();
  let verdict: DetectorVerdict = "clear";
  if (findings.some((finding) => finding.action === "reject")) verdict = "reject";
  else if (findings.some((finding) => finding.action === "unclassifiable")) verdict = "unclassifiable";
  else if (findings.some((finding) => finding.action === "raise")) verdict = "raise";
  const minimum = maxCategory(...findings.map((finding) => finding.minimum_category));
  return { verdict, minimum_category: minimum, rule_ids: ruleIds, findings, segments: analyzer.segments };
}

/** Pinned category order used by tests to assert the detector never lowers. */
export const DETECTOR_CATEGORY_LADDER = ELEVATED_CATEGORIES;
