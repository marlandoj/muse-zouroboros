// Verity hybrid Phase 2: the push guard's check (`engine/cli.js prepush`).
//
// Runs inside the Verity-owned pre-push hook a `verity run` session points
// git at (see run.js installGuard), after the repository's own pre-push hook
// has run. Over the outgoing range of every ref being pushed it applies the
// shared diff core (swarm.js diffRules): test deletion and skip markers over
// the net diff, the secret scan over EVERY outgoing commit (a credential added
// and removed again inside the range is still in the pushed history). The
// verdict is appended to the verdict store (event "prepush"). In shadow it
// only logs; the hook's exit status stays the repository hook's.
import { spawnSync } from "node:child_process";
import { loadTrustedConfig } from "./config.js";
import { resolveHome } from "./home.js";
import { EMPTY_TREE, DEFAULT_IGNORE, blockingFindings, diffRepo, diffRules, gitTry } from "./swarm.js";
import { hash16 } from "./util.js";
import { findSecrets } from "./checks.js";
import { appendCliVerdict } from "./record.js";

export const PREPUSH_SCHEMA = "verity.prepush.verdict/1";
/** Outgoing commits scanned one by one; beyond this the verdict is unverifiable (truncated). */
export const MAX_PUSH_COMMITS = 500;
const ZERO = /^0+$/;

function revList(top, args) {
  const r = spawnSync("git", ["-C", top, "rev-list", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
  return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : null;
}

/** Parse git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export function parsePushLines(text) {
  return String(text || "")
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((p) => p.length === 4)
    .map(([localRef, localSha, remoteRef, remoteSha]) => ({ localRef, localSha, remoteRef, remoteSha }));
}

/** The outgoing commits (oldest first) and the base the net diff starts from. */
function outgoing(top, remote, u) {
  if (!ZERO.test(u.remoteSha) && gitTry(top, ["cat-file", "-e", `${u.remoteSha}^{commit}`]) !== null) {
    const commits = revList(top, ["--reverse", u.localSha, `^${u.remoteSha}`]);
    return { commits, base: u.remoteSha };
  }
  // New ref (or a remote tip we do not have): what no remote-tracking ref of this remote already holds.
  const named = remote && !remote.includes("/") && !remote.includes(":") ? [`--remotes=${remote}`] : ["--remotes"];
  const commits = revList(top, ["--reverse", u.localSha, "--not", ...named]);
  if (!commits || commits.length === 0) return { commits: commits || [], base: u.localSha };
  const parent = gitTry(top, ["rev-parse", "--verify", "-q", `${commits[0]}^`]);
  return { commits, base: parent || EMPTY_TREE };
}

/**
 * Judge one push. Returns the verdict object (decision pass | fail |
 * unverifiable, findings, message); never throws on repository content.
 */
export function judgePush({ cwd, remote, lines, allowSecrets = false, ignoreGlobs = DEFAULT_IGNORE }) {
  const t0 = Date.now();
  const top = gitTry(cwd, ["rev-parse", "--show-toplevel"]) || cwd;
  const findings = [];
  const refs = [];
  let truncated = false;
  const seenSecret = new Set();
  for (const u of lines) {
    if (ZERO.test(u.localSha)) {
      refs.push({ ref: u.remoteRef, deleted: true });
      continue;
    }
    const { commits, base } = outgoing(top, remote, u);
    if (commits === null) {
      truncated = true;
      refs.push({ ref: u.remoteRef, error: "rev-list failed" });
      continue;
    }
    if (commits.length > MAX_PUSH_COMMITS) truncated = true;
    refs.push({ ref: u.remoteRef, commits: commits.length });
    if (commits.length === 0) continue;
    // Net diff: test deletion / rename-away and skip markers (and its secrets).
    const net = diffRepo(top, base, u.localSha);
    if (net.truncated) truncated = true;
    const r = diffRules({ abs: top, entries: net.entries, added: net.added, baseTree: base, postTree: u.localSha, ignoreGlobs, allowSecrets, command: null });
    for (const f of r.findings) {
      if (f.rule === "secret") seenSecret.add(`${f.path}\0${f.fingerprint}`);
      findings.push({ ...f, ref: u.remoteRef });
    }
    // Every outgoing commit: secrets that the net diff no longer shows.
    if (!allowSecrets) {
      for (const c of commits.slice(0, MAX_PUSH_COMMITS)) {
        const parent = gitTry(top, ["rev-parse", "--verify", "-q", `${c}^`]) || EMPTY_TREE;
        const d = diffRepo(top, parent, c);
        if (d.truncated) truncated = true;
        for (const [p, added] of d.added) {
          for (const s of findSecrets(added.join("\n"))) {
            const key = `${p}\0${hash16(s.value)}`;
            if (seenSecret.has(key)) continue;
            seenSecret.add(key);
            findings.push({ rule: "secret", path: p, label: s.label, fingerprint: hash16(s.value), ref: u.remoteRef, commit: c.slice(0, 12), inHistory: true });
          }
        }
      }
    }
  }
  const blocking = blockingFindings(findings);
  const messages = [];
  for (const f of blocking) {
    if (f.rule === "secret") messages.push(`Verity: the push to ${f.ref} carries what looks like ${f.label} in ${f.path}${f.inHistory ? ` (commit ${f.commit}, removed again later but still in the pushed history)` : ""}.`);
    else if (f.rule === "test_deletion") messages.push(`Verity: the push to ${f.ref} removes ${f.path} from the tests${f.renamedTo ? ` (moved to ${f.renamedTo})` : ""}.`);
  }
  let decision;
  if (blocking.length) decision = "fail";
  else if (truncated) {
    decision = "unverifiable";
    messages.push(`Verity: the outgoing range is above the push caps (${MAX_PUSH_COMMITS} commits or the diff byte cap), so it was truncated; the push is unverifiable, not passed.`);
  } else {
    decision = "pass";
    const skipped = findings.filter((f) => f.rule === "test_skipped").length;
    messages.push(`Verity: the push carries no credential shape and removes no test${skipped ? ` (${skipped} skip marker${skipped === 1 ? "" : "s"} added to tests, advisory)` : ""}.`);
  }
  return { schema: PREPUSH_SCHEMA, decision, cwd: top, remote: remote || null, refs, findings, changes: { code: [], truncated }, message: [...new Set(messages)].join(" "), durationMs: Date.now() - t0 };
}

/**
 * The hook entry: judge, record, report on stderr. Returns the exit status
 * Verity asks for: 0 always in shadow; 1 for a refused push when the run's
 * posture is live (never reachable in Phase 2, which ships shadow-only).
 */
export function prepushMain({ cwd, remote, url, stdinText, chain, repoHookExit, env = process.env }) {
  const t0 = Date.now();
  const mode = env.VERITY_RUN_MODE === "live" ? "live" : "shadow";
  const runId = env.VERITY_RUN_ID || null;
  const harness = env.VERITY_RUN_HARNESS || "cli";
  // Allowances come from the trusted project config only (trust-bound .verity.json), never from the push.
  const trusted = loadTrustedConfig(resolveHome(), cwd);
  const allowSecrets = !!(trusted && Array.isArray(trusted.cfg.allow) && trusted.cfg.allow.includes("secrets"));
  let verdict;
  try {
    verdict = judgePush({ cwd, remote, lines: parsePushLines(stdinText), allowSecrets });
  } catch (e) {
    verdict = { schema: PREPUSH_SCHEMA, decision: "error", findings: [], message: `Verity: the push check could not answer: ${String(e && e.message).slice(0, 300)}` };
  }
  const applied = mode === "live" && verdict.decision !== "pass" && verdict.decision !== "error";
  appendCliVerdict({
    event: "prepush", harness, mode, applied, runId, cwd: verdict.cwd || cwd, verdict, wallMs: Date.now() - t0, env,
    detail: { remote: remote || null, url: url ? "set" : null, refs: verdict.refs || [], chain: chain || null, repoHookExit: Number.isFinite(repoHookExit) ? repoHookExit : null },
  });
  if (verdict.decision !== "pass") {
    process.stderr.write(`${mode === "live" ? "verity" : "verity (shadow, not enforced)"}: pre-push ${verdict.decision}: ${verdict.message}\n`);
  }
  if (chain && chain.startsWith("unverifiable")) {
    process.stderr.write(`verity: the repository's own pre-push hook could not be chained (${chain}); the push guard ran without it.\n`);
  }
  return applied ? 1 : 0;
}
