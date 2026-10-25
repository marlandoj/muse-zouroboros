// Check classification and guards. All behavior derived from black-box
// observation (see test/fixtures/engine); no shared code with any prior
// implementation.
import { relPath, stripQuotesAndComments, tokenize } from "./util.js";
import { execFileSync } from "node:child_process";

// Programs whose invocations may count as checks (observed allowlist).
// Basenames match: `./gradlew`, `/usr/local/bin/gradlew`, and
// `node_modules/.bin/jest` all count via their final path component.
const CHECK_PROGRAMS = new Set([
  "npm", "npx", "yarn", "pnpm", "bun", "deno",
  "cargo", "go", "pytest", "python", "mocha",
  "vitest", "jest", "rspec", "tsc", "eslint",
  "prettier", "ruff", "make",
  "gradle", "gradlew", "mvn", "dotnet", "mix",
]);

// Words that mark a check invocation (word-boundaried; _ counts as a word
// char, so mylib_test / attest do not match).
const CHECK_WORDS = [
  "test", "jest", "pytest", "mocha", "vitest", "rspec",
  "tsc", "eslint", "prettier", "lint", "check", "vet", "build",
];
const WORD_RES = CHECK_WORDS.map(
  (w) => new RegExp(`(?<![A-Za-z0-9_])${w}(?![A-Za-z0-9_])`)
);

function hasCheckWord(s) {
  return WORD_RES.some((re) => re.test(s));
}

/**
 * Strip leading command modifiers that don't change what runs (observed):
 * `time`/`sudo` (with their flags), `exec`, `VAR=value` assignments, and a
 * `!` that isn't at a command position (a leading `!` is rejected before
 * this runs). `command` is notably NOT stripped.
 */
export function stripModifiers(s) {
  const toks = String(s).trim().split(/\s+/);
  let i = 0;
  while (i < toks.length) {
    const t = toks[i];
    if (t === "!" || t === "exec" || /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)) {
      i++;
      continue;
    }
    if (t === "time" || t === "sudo") {
      i++;
      while (i < toks.length && /^-[A-Za-z]/.test(toks[i])) i++;
      continue;
    }
    break;
  }
  return toks.slice(i).join(" ");
}

function isCheckPart(part, pipefailSeen) {
  const p = part.trim();
  if (!p) return false;
  let body = p;
  if (body.includes("|")) {
    // A pipe hides the exit status unless pipefail is set.
    if (!pipefailSeen) return false;
    body = body.split("|")[0];
  }
  // The program is the basename: `./gradlew`, `/usr/local/bin/gradlew`,
  // and `node_modules/.bin/jest` all resolve via the final component.
  const prog = body.trim().split(/\s+/)[0].split("/").pop() || "";
  if (!CHECK_PROGRAMS.has(prog)) return false;
  return hasCheckWord(body);
}

// Behaviorally-derived: "<runner> run <script>" counts as a check only for
// these pairs. Named test tools count for the four runners; generic script
// names are runner-specific (npm/pnpm accept test+lint+build, yarn only
// test, bun only build). Anything else in run-form is not a check.
const RUN_TOOL_SCRIPTS = new Set([
  "jest", "vitest", "mocha", "tsc", "eslint", "pytest", "rspec",
]);
const RUN_GENERIC_SCRIPTS = {
  npm: new Set(["test", "lint", "build"]),
  pnpm: new Set(["test", "lint", "build"]),
  yarn: new Set(["test"]),
  bun: new Set(["build"]),
};

/**
 * Handle "<runner> run <script>" (and the never-a-check "run-script" /
 * "<runner> task" forms). Returns true/false when the part is a run-form
 * (a pipe without pipefail masks the status), null when it isn't.
 */
function runFormCheck(part, pipefailSeen) {
  let body = String(part).trim();
  if (body.includes("|")) {
    if (!pipefailSeen) return false;
    body = body.split("|")[0];
  }
  const m = body.match(/^(\S+)\s+(run(?:-script)?|task)\s+(\S+)/);
  if (!m) return null;
  if (m[2] !== "run") return false;
  const script = m[3];
  if (RUN_TOOL_SCRIPTS.has(script)) return true;
  const generics = RUN_GENERIC_SCRIPTS[m[1]];
  return generics ? generics.has(script) : false;
}

/**
 * Stage 1 finding #3 (2026-10-24): a trusted pattern used to short-circuit
 * the masking analysis, so `bun test | tail`, `bun test; echo ok` and
 * `echo bun test` all counted as checks once `bun test` was trusted. Now a
 * pattern counts only where it PREFIXES a command segment of the last `;`
 * segment (word-boundaried), after the `||` / `&` / `;` / pipe analysis
 * has run on that segment like for any other check.
 */
function trustedPrefix(part, patterns, pipefailSeen) {
  if (!patterns || patterns.length === 0) return false;
  let body = String(part);
  if (body.includes("|")) {
    if (!pipefailSeen) return false; // a pipe hides the exit status
    body = body.split("|")[0];
  }
  body = body.trim();
  return patterns.some((p) => {
    const pat = String(p ?? "").trim();
    if (!pat || !body.startsWith(pat)) return false;
    const next = body.charAt(pat.length);
    return next === "" || /\s/.test(next);
  });
}

/**
 * 2026-10-25 block adjudication (false positive): a headless Godot run of
 * the project's own test runner (`/abs/path/godot --headless --path . -s
 * res://tests/run_tests.gd`) matched no check pattern. It counts now, but
 * only when the binary's basename starts with `godot`, `--headless` is
 * passed, and the `-s` / `--script` path signals a test run (a test(s)
 * path segment, or a basename containing test or check). A plain game or
 * scene script never counts. Runs per && part, after the same `||` / `&` /
 * `;` analysis as every other check; a pipe masks unless pipefail is set.
 */
function isTestScriptPath(p) {
  const segs = String(p).split("/").filter((x) => x !== "");
  const base = segs.pop() || "";
  return segs.some((x) => /^tests?$/i.test(x)) || /test|check/i.test(base);
}

function godotTestRun(part, pipefailSeen) {
  let body = String(part);
  if (body.includes("|")) {
    if (!pipefailSeen) return false; // a pipe hides the exit status
    body = body.split("|")[0];
  }
  const toks = body.trim().split(/\s+/);
  const prog = (toks[0] || "").split("/").pop().toLowerCase();
  if (!prog.startsWith("godot")) return false;
  if (!toks.includes("--headless")) return false;
  for (let i = 1; i < toks.length; i++) {
    let script = null;
    if (toks[i] === "-s" || toks[i] === "--script") script = toks[i + 1] ?? null;
    else if (toks[i].startsWith("--script=")) script = toks[i].slice("--script=".length);
    if (script && isTestScriptPath(script)) return true;
  }
  return false;
}

/**
 * True when the command counts as a check: a recognized check invocation
 * whose own exit status is the result. `extraPatterns` are trusted
 * command prefixes from the project config (see trustedPrefix).
 */
export function isVerify(command, extraPatterns = []) {
  const s = stripQuotesAndComments(command);
  if (/\|\|/.test(s)) return false; // || masks the status
  if (/&\s*$/.test(s) && !/&&\s*$/.test(s)) return false; // backgrounded
  if (/\s--(version|help)\b/.test(s)) return false; // not a check run
  // `;` chains: the exit status is the last segment's, so only the last
  // non-empty segment can be the check (`npm test; true` hides the status).
  const segs = s.split(";").map((x) => x.trim()).filter((x) => x !== "");
  if (segs.length === 0) return false;
  let pipefailSeen = false;
  for (const seg of segs.slice(0, -1)) {
    if (/set\s+-o\s+pipefail/.test(seg)) pipefailSeen = true;
  }
  // && chains: any segment may be the check, but a `!` at a command
  // position disqualifies the whole chain.
  for (const part of segs[segs.length - 1].split("&&")) {
    let p = part.trim();
    if (/^!/.test(p)) return false;
    p = stripModifiers(p);
    if (/set\s+-o\s+pipefail/.test(p)) pipefailSeen = true;
    if (trustedPrefix(p, extraPatterns, pipefailSeen)) return true;
    if (godotTestRun(p, pipefailSeen)) return true;
    const runForm = runFormCheck(p, pipefailSeen);
    if (runForm === true) return true;
    if (runForm === false) continue;
    if (isCheckPart(p, pipefailSeen)) return true;
  }
  return false;
}

/**
 * True when a PreToolUse Bash command should be rewritten to add pipefail:
 * it pipes into `tail` (SIGPIPE-correct, unlike head/grep -q), isn't already
 * pipefail-safe, and the piped command would otherwise count as a check.
 */
export function needsPipefailRewrite(command, extraPatterns = []) {
  const s = stripQuotesAndComments(command);
  if (/set\s+-o\s+pipefail/.test(s)) return false;
  const m = s.match(/\|\s*tail\b/);
  if (!m) return false;
  return isVerify(s.slice(0, m.index), extraPatterns);
}

export function pipefailRewrite(command) {
  return `set -o pipefail && ${command}`;
}

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

// Corpus-derived patterns. Labels reproduce the observed messages verbatim,
// including their grammar ("a AWS access key", "a OpenAI or Anthropic key").
// Token patterns require a word boundary at the start: an embedded "xghp_..."
// or "myAKIA..." does not count (black-box verified).
const SECRET_PATTERNS = [
  { re: /\bAKIA[0-9A-Z]{16}/, label: "a AWS access key" },
  { re: /\bghp_[A-Za-z0-9]{36}/, label: "a GitHub token" },
  { re: /\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}/, label: "a OpenAI or Anthropic key" },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{16,}/, label: "a Slack token" },
  { re: /\bAIza[0-9A-Za-z_-]{35}/, label: "a Google API key" },
  { re: /-----BEGIN (?:RSA )?PRIVATE KEY-----/, label: "a private key" },
  { re: /-----BEGIN OPENSSH PRIVATE KEY-----/, label: "a private key" },
];

// Variable names that mark a hardcoded credential assignment (observed).
const CRED_NAMES = [
  "token", "password", "passwd", "secret",
  "api_key", "apikey", "access_token", "client_secret",
];
const CRED_RE_SOURCE = `\\b(?:${CRED_NAMES.join("|")})\\b\\s*[:=]\\s*"([^"]*)"`;

/**
 * Every high-entropy credential value assigned to a credential-named
 * variable in the text: `token = "..."`, `password: "..."`, etc. Observed
 * boundary: value length >= 16 with both a letter and a digit; single
 * quotes, backticks, and low-entropy values do not count.
 *
 * Stage 1 finding #4 (2026-10-24): the check used to test only the FIRST
 * credential-shaped assignment, so a benign `password = "changeme"` ahead of
 * a real token hid the token. Every match is tested now (a fresh global
 * regex per call, so no lastIndex state leaks between calls).
 */
function credentialValues(text) {
  const out = [];
  const re = new RegExp(CRED_RE_SOURCE, "g");
  for (const m of String(text).matchAll(re)) {
    const v = m[1];
    if (v.length >= 16 && /[A-Za-z]/.test(v) && /[0-9]/.test(v)) out.push(v);
  }
  return out;
}

/**
 * Every secret-shaped match in the text as { label, value }: token patterns
 * (all matches, not just the first) plus hardcoded credential values. Used by
 * the swarm verify gate, which records only the label and a fingerprint of
 * the value — never the value itself.
 *
 * Applies the same per-value seeded rule as detectSecret (isSeededValue on
 * the widened token): a seeded value contributes no finding, every unmarked
 * value still does. No env-file branch — that is a detectSecret concern.
 */
export function findSecrets(text) {
  const s = String(text ?? "");
  const out = [];
  for (const p of SECRET_PATTERNS) {
    for (const t of tokenMatches(s, p.re)) {
      if (!isSeededValue(t.token)) out.push({ label: p.label, value: t.value });
    }
  }
  for (const v of credentialValues(s)) {
    if (!isSeededValue(v)) out.push({ label: "a hardcoded credential", value: v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skipped tests (diff rules: lines added to test files)
// ---------------------------------------------------------------------------

// The pinned marker set. Each label is what a finding records (never the
// line itself). A marker counts only at an identifier boundary: `submit.skip(`
// and `fixit(` do not match `it.skip(` / `xit(`.
const SKIP_MARKERS = [
  { re: /(?<![\w$.])(?:it|test|describe|context|suite)\.skip\s*\(/, label: "js .skip(" },
  { re: /(?<![\w$.])(?:xit|xtest|xdescribe|xcontext)\s*\(/, label: "js x-prefixed test" },
  { re: /(?<![\w$.])this\.skip\s*\(\s*\)/, label: "mocha this.skip()" },
  { re: /@pytest\.mark\.skip(?:if)?(?!\w)/, label: "pytest.mark.skip" },
  { re: /(?<![\w$.])pytest\.skip\s*\(/, label: "pytest.skip(" },
  { re: /@unittest\.skip(?:If|Unless)?(?!\w)/, label: "unittest.skip" },
  { re: /(?<![\w$.])self\.skipTest\s*\(/, label: "unittest skipTest(" },
  { re: /(?<![\w$.])[tb]\.Skip(?:f|Now)?\s*\(/, label: "go t.Skip(" },
];

/** A line with its string literals emptied and its trailing comment cut (`//` or `#`); block-comment lines become empty. */
function codeOfLine(line) {
  const t = String(line).trim();
  if (t.startsWith("/*") || t.startsWith("*")) return "";
  let s = stripQuotesAndComments(t.replace(/`(?:[^`\\]|\\.)*`/g, ""));
  const c = s.indexOf("//");
  if (c !== -1) s = s.slice(0, c);
  return s;
}

/**
 * Skip markers in lines added to a test file, as [{ label }] (one per
 * matching line, first marker wins). Comments and string contents never
 * count; the caller decides which files are test files.
 */
export function findSkipMarkers(lines) {
  const out = [];
  for (const line of lines || []) {
    const code = codeOfLine(line);
    if (!code) continue;
    const m = SKIP_MARKERS.find((k) => k.re.test(code));
    if (m) out.push({ label: m.label });
  }
  return out;
}

// Extensions that never count as code for the done-gate (behaviorally
// derived denylist: docs, images, logs, lockfiles; case-insensitive).
// Everything else — including extensionless files — counts as code.
const NON_CODE_EXTS = new Set([
  "md", "mdx", "txt", "rst", "adoc", "log",
  "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "lock",
]);

/** True when a cwd-relative path counts as code for the done-gate. */
export function isCodeFile(relPath) {
  const base = String(relPath).split("/").pop();
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return true;
  return !NON_CODE_EXTS.has(base.slice(dot + 1).toLowerCase());
}

/**
 * 2026-10-25 block adjudication (false positive): a sanitizer test fixture
 * whose every credential-shaped value carried a fake marker (FAKE,
 * fakeseed) was denied. A value is "seeded" when its own body carries an
 * explicit fake-data marker (case-insensitive, embedded or delimited).
 * Only the value is examined — never the rest of the file or its name.
 */
const SEED_MARKER_RE = /fake|seed|example|dummy|placeholder|sample|test|redacted/i;

function isSeededValue(v) {
  return SEED_MARKER_RE.test(String(v));
}

/**
 * Every value a token pattern matches, widened to the whole surrounding
 * token ([A-Za-z0-9_-] run) so a fixed-length pattern like AKIA+16 still
 * sees a marker that sits just past the matched span. tokenMatches keeps
 * the matched span too (findSecrets fingerprints it, unchanged).
 */
function tokenMatches(text, re) {
  const out = [];
  const g = new RegExp(re.source, "g");
  for (const m of text.matchAll(g)) {
    let start = m.index;
    let end = m.index + m[0].length;
    while (start > 0 && /[A-Za-z0-9_-]/.test(text[start - 1])) start--;
    while (end < text.length && /[A-Za-z0-9_-]/.test(text[end])) end++;
    out.push({ value: m[0], token: text.slice(start, end) });
  }
  return out;
}

function tokenValues(text, re) {
  return tokenMatches(text, re).map((t) => t.token);
}

/**
 * Returns the deny message when content looks like it contains a secret,
 * or null. `allowSecrets` comes from trusted project config. Multiple
 * findings are joined ("a GitHub token and a hardcoded credential").
 * The path is shown cwd-relative, matching the ledger's display form.
 * Outside env files, content whose every matched value is seeded (see
 * isSeededValue) is not denied; one unmarked value denies as before.
 */
export function detectSecret(filePath, content, cwd, allowSecrets = false) {
  if (allowSecrets) return null;
  const text = String(content ?? "");
  const labels = [];
  let unmarked = false;
  for (const p of SECRET_PATTERNS) {
    const vals = tokenValues(text, p.re);
    if (vals.length === 0) continue;
    labels.push(p.label);
    if (!vals.every(isSeededValue)) unmarked = true;
  }
  const creds = credentialValues(text);
  if (creds.length > 0) {
    labels.push("a hardcoded credential");
    if (!creds.every(isSeededValue)) unmarked = true;
  }
  if (labels.length === 0) return null;
  const disp = relPath(cwd, filePath);
  const base = disp.split("/").pop();
  const label = labels.join(" and ");
  if (base.startsWith(".env")) {
    return (
      `Verity: ${disp} would contain what looks like ${label}. ` +
      `An env file is only the place for it once git ignores the file, and a committed template never is.`
    );
  }
  if (!unmarked) return null;
  return (
    `Verity: ${disp} would contain what looks like ${label}. ` +
    `Read the value from the environment or a git-ignored env file instead of writing it into the file.`
  );
}

// ---------------------------------------------------------------------------
// Test deletion
// ---------------------------------------------------------------------------

/** Parse rm-like commands into operand paths (flags/globs skipped). */
export function rmOperands(command) {
  let s = String(command).trim().replace(/^sudo\s+/, "");
  const m = s.match(/^(git\s+)?rm\s+([\s\S]*)$/);
  if (!m) return null;
  const ops = [];
  for (const t of tokenize(m[2])) {
    if (t.startsWith("--")) continue;
    if (t.startsWith("-") && t.length > 1) continue;
    if (/[*?[\]{}]/.test(t)) continue; // globs aren't resolved paths
    const clean = t.replace(/\/+$/, "");
    if (clean) ops.push(clean.replace(/^\.\//, ""));
  }
  return ops;
}

/** True when an rm operand points into the tests (case-sensitive). */
export function isTestPath(p) {
  const q = String(p).replace(/^\.\//, "");
  return (
    /(^|[/.])tests?([/.]|$)/.test(q) ||
    /__tests__/.test(q) ||
    /\.test\./.test(q)
  );
}

/** Sources of an mv command (the moved-from paths), or null. */
function mvSources(command) {
  const s = String(command).trim().replace(/^sudo\s+/, "");
  const m = s.match(/^(git\s+)?mv\s+([\s\S]*)$/);
  if (!m) return null;
  const ops = [];
  for (const t of tokenize(m[2])) {
    if (t.startsWith("--")) continue;
    if (t.startsWith("-") && t.length > 1) continue;
    if (/[*?[\]{}]/.test(t)) continue;
    const clean = t.replace(/\/+$/, "").replace(/^\.\//, "");
    if (clean) ops.push(clean);
  }
  return ops.length >= 2 ? ops.slice(0, -1) : null;
}

/**
 * Returns the deny message when a PreToolUse Bash command removes tests,
 * or null. Covers rm/git rm and mv (moving a test away removes it).
 * The message names the first matching operand, cwd-relative.
 */
export function detectTestDeletion(command, cwd) {
  const rmOps = rmOperands(command);
  const hit = (rmOps && rmOps.find(isTestPath)) || null;
  const mvHit = !hit && (() => {
    const srcs = mvSources(command);
    return (srcs && srcs.find(isTestPath)) || null;
  })();
  const found = hit || mvHit;
  if (!found) return null;
  return (
    `Verity: this command removes ${relPath(cwd, found)} from the tests. ` +
    `Tests are only removed or skipped when the user asked for it. ` +
    `Fix the code the test covers instead.`
  );
}

// ---------------------------------------------------------------------------
// Command file tracking (the `code` array on command facts)
// ---------------------------------------------------------------------------

function skipFlags(toks) {
  return toks.filter((t) => {
    if (t.startsWith("--")) return false;
    if (t.startsWith("-") && t.length > 1) return false;
    if (/[*?[\]{}]/.test(t)) return false;
    return true;
  });
}

/**
 * Files a Bash command touches, for the ledger's `code` array:
 * rm lists operands, mv lists [dest, ...sources], cp lists [dest].
 * Paths are relativized against cwd.
 */
export function commandCodeFiles(command, cwd) {
  const s = String(command).trim().replace(/^sudo\s+/, "");
  const rel = (p) => relPath(cwd, p);
  const rmOps = rmOperands(command);
  if (rmOps) return rmOps.map(rel);
  let m = s.match(/^mv\s+([\s\S]*)$/);
  if (m) {
    const ops = skipFlags(tokenize(m[1]));
    if (ops.length >= 2) {
      return [rel(ops[ops.length - 1]), ...ops.slice(0, -1).map(rel)];
    }
    return [];
  }
  m = s.match(/^cp\s+([\s\S]*)$/);
  if (m) {
    const ops = skipFlags(tokenize(m[1]));
    if (ops.length >= 1) return [rel(ops[ops.length - 1])];
    return [];
  }
  return [];
}

// ---------------------------------------------------------------------------
// Semantic anchor: a test-runner pass in a repo with no test files proves
// nothing (the `"test": "echo ok"` class of bypass). The gate refuses to
// count such a pass as verification.
// ---------------------------------------------------------------------------

/** Basename-level test file signals, broader than isTestPath (which is tuned
 *  for deletion detection). Covers x.test.ts, x.spec.js, test_x.py,
 *  x_test.go, FooTest.java, and test(s)/__tests__ directories. */
const TEST_BASENAME_RE = /(^test_.*|(^|[._])test\.[a-z0-9]+$|(^|[._])spec\.[a-z0-9]+$)/i;

/** Exported for the swarm verify gate: isTestPath alone misses test_x.py, x_test.go and x_spec.rb. */
export function looksLikeTestFile(p) {
  const q = String(p).replace(/^\.\//, "");
  if (isTestPath(q)) return true;
  const base = q.split("/").pop();
  return TEST_BASENAME_RE.test(base);
}

/**
 * Does the repo at cwd contain any test files? Returns true/false, or null
 * when the tree cannot be scanned — the anchor only bites on a positive
 * determination of "no test files", never on unscannable trees.
 */
export function repoHasTestFiles(cwd) {
  try {
    const dir = String(cwd || "");
    if (!dir) return null;
    let files = null;
    try {
      const out = execFileSync("git", ["-C", dir, "ls-files"], {
        timeout: 8000,
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      }).toString();
      files = out.split("\n").filter((l) => l !== "");
    } catch {
      /* not a git repo — fall through to find */
    }
    if (!files) {
      try {
        const out = execFileSync(
          "find",
          [dir, "-maxdepth", "5", "-type", "f", "-not", "-path", "*/node_modules/*", "-not", "-path", "*/.git/*", "-not", "-path", "*/vendor/*"],
          { timeout: 8000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] },
        ).toString();
        files = out.split("\n").filter((l) => l !== "");
      } catch {
        return null;
      }
    }
    if (!files.length) return null;
    return files.some(looksLikeTestFile);
  } catch {
    return null;
  }
}

const TEST_RUNNERS = new Set([
  "pytest", "jest", "vitest", "mocha", "ava", "tape", "jasmine", "karma",
  "rspec", "phpunit", "playwright", "cypress",
]);

/**
 * True when the command is a test-runner invocation (as opposed to a build,
 * lint, or typecheck). A bare `npm test` in a repo with no test files is the
 * hollow-pass shape this anchor targets.
 */
export function isTestRunnerCommand(command) {
  const s = stripQuotesAndComments(String(command));
  if (!s) return false;
  const segs = s.split(/[;&|]/).map((x) => x.trim()).filter((x) => x !== "");
  for (const seg of segs) {
    let toks = seg.split(/\s+/).filter((t) => t !== "");
    // Strip env assignments (FOO=bar) and leading sudo/env.
    while (toks.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(toks[0]) || toks[0] === "sudo" || toks[0] === "env")) toks.shift();
    if (!toks.length) continue;
    const head = toks[0].split("/").pop();
    if (TEST_RUNNERS.has(head)) return true;
    if (head === "go" && toks[1] === "test") return true;
    if (head === "cargo" && toks[1] === "test") return true;
    if (head === "deno" && toks[1] === "test") return true;
    if (head === "gradlew" || head === "./gradlew" || head === "gradle") {
      if (toks.slice(1).some((t) => t === "test" || t === "check")) return true;
      continue;
    }
    if (head === "npx" || head === "npx.cmd") {
      const sub = (toks[1] || "").split("/").pop();
      if (TEST_RUNNERS.has(sub)) return true;
      continue;
    }
    if (head === "npm" || head === "yarn" || head === "pnpm" || head === "bun") {
      const rest = toks.slice(1);
      if (rest[0] === "test") return true;
      if (rest[0] === "run" && rest[1] && (rest[1] === "test" || TEST_RUNNERS.has(rest[1]))) return true;
      continue;
    }
  }
  return false;
}
