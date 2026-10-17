#!/usr/bin/env node
// Differential fuzz input generator for the Verity engine rewrite.
// Emits JSONL records {"agent":"claude","event":{...}} on stdout — a stream of
// synthetic *sessions* (shared session_id per scenario) designed to stress the
// exact areas where the clean-room engine might diverge from Canny:
// isVerify edge cases, secret patterns, test deletion, exit-code spoofing,
// release-valve sequencing, malformed-ish inputs.
//
// Deterministic: mulberry32 PRNG, seed from --seed (default 1).
// Usage: node test/fuzz-generate.mjs --sessions 400 --seed 1 > /tmp/fuzz.jsonl
// Then:  bash scripts/engine-dual-run.sh --events /tmp/fuzz.jsonl \
//           --old-home /tmp/fz-old --new-home /tmp/fz-new

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt;
};
const NSESSIONS = parseInt(opt("--sessions", "400"), 10);
let seed = parseInt(opt("--seed", "1"), 10) >>> 0;

function rnd() {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const chance = (p) => rnd() < p;
const alnum = (n, alpha = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789") =>
  Array.from({ length: n }, () => alpha[Math.floor(rnd() * alpha.length)]).join("");

const out = [];
const rec = (event) => out.push(JSON.stringify({ agent: "claude", event }));

const RUNNERS = ["npm test","npm run test","npx jest","yarn test","pnpm test","bun test",
  "bun run test","pytest","python -m pytest","python3 -m unittest","go test ./...","cargo test",
  "make test","./gradlew test","ctest","npx tsc --noEmit","eslint .","tsc -p .","deno test"];
const SUFFIXES = [""," --watch"," --version"," --help"," -v"," 2>&1 | tail"," 2>&1 | head -5",
  " | grep -q ok"," | head"," || true"," || exit 0","; echo done"," &"," # run tests"," --coverage",
  " -u"," --updateSnapshot","; true"];
const PREFIXES = ["","! ","echo start; ","cd /p && ","time "];
const PATHS = ["/p/src/a.ts","/p/src/a.test.ts","/p/tests/b.test.js","/p/lib/c.py",
  "/p/README.md","/p/src/deep/nested/d.ts","/p/e2e/spec.cy.ts"];

function mutateCommand() {
  const r = pick(RUNNERS);
  let cmd = pick(PREFIXES) + r + pick(SUFFIXES);
  const q = rnd();
  if (q < 0.08) cmd = `"${cmd}"`;
  else if (q < 0.12) cmd = `'${cmd}'`;
  else if (q < 0.16) cmd = `FOO=1 ${cmd}`;
  return cmd;
}
function secretContent() {
  const k = rnd();
  if (k < 0.3) return `const key = "AKIA${alnum(16)}";`;
  if (k < 0.5) return `token = "ghp_${alnum(36, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789")}";`;
  if (k < 0.6) return `-----BEGIN RSA PRIVATE KEY-----\n${alnum(64)}\n-----END RSA PRIVATE KEY-----`;
  if (k < 0.75) return `// my AKIA${alnum(8)} key (truncated, not real)`;
  if (k < 0.85) return `const xghp_${alnum(36, "abcdefghijklmnopqrstuvwxyz0123456789")} = 1; // embedded`;
  return `password = "${alnum(12, "abcdefghijklmnopqrstuvwxyz")}"`;
}
function testDeleteCommand() {
  return pick([
    `rm ${pick(["/p/src/a.test.ts","/p/tests/b.test.js","/p/e2e/spec.cy.ts"])}`,
    "rm -rf /p/tests/",
    `git rm ${pick(["/p/src/a.test.ts"])}`,
    `mv /p/src/a.test.ts /p/src/a.test.ts.bak`,
    `cp /p/src/a.ts /p/src/a.ts.bak`,
  ]);
}

const preBash  = (sid, cmd) => rec({ hook_event_name: "PreToolUse", session_id: sid, cwd: "/p", tool_name: "Bash", tool_input: { command: cmd } });
const postBash = (sid, cmd, code, stdout) => rec({ hook_event_name: "PostToolUse", session_id: sid, cwd: "/p", tool_name: "Bash", tool_input: { command: cmd }, tool_response: { stdout, exit_code: code } });
const failBash = (sid, cmd, code) => rec({ hook_event_name: "PostToolUseFailure", session_id: sid, cwd: "/p", tool_name: "Bash", tool_input: { command: cmd }, error: { message: `Command exited with code ${code}` } });
const preWrite = (sid, path, content) => rec({ hook_event_name: "PreToolUse", session_id: sid, cwd: "/p", tool_name: "Write", tool_input: { file_path: path, content } });
const postWrite = (sid, path) => rec({ hook_event_name: "PostToolUse", session_id: sid, cwd: "/p", tool_name: "Write", tool_input: { file_path: path }, tool_response: { stdout: "", exit_code: 0 } });
const preEdit  = (sid, path, ns) => rec({ hook_event_name: "PreToolUse", session_id: sid, cwd: "/p", tool_name: "Edit", tool_input: { file_path: path, old_string: "a", new_string: ns } });
const postEdit = (sid, path) => rec({ hook_event_name: "PostToolUse", session_id: sid, cwd: "/p", tool_name: "Edit", tool_input: { file_path: path }, tool_response: { stdout: "", exit_code: 0 } });
const stop     = (sid, active) => { const e = { hook_event_name: "Stop", session_id: sid, cwd: "/p", last_assistant_message: pick(["done","finished","all green","shipped it"]) }; if (active !== undefined) e.stop_hook_active = active; rec(e); };

function scenarioWriteStop(sid) {
  const p = pick(PATHS);
  preWrite(sid, p, "const x = 1;");
  postWrite(sid, p);
  stop(sid);
  if (chance(0.4)) stop(sid, chance(0.5)); // release-valve probe
}
function scenarioWriteTestStop(sid) {
  const p = pick(PATHS);
  preWrite(sid, p, "const x = 1;");
  postWrite(sid, p);
  const cmd = mutateCommand();
  const pass = chance(0.6);
  preBash(sid, cmd);
  if (pass) postBash(sid, cmd, 0, pick(["ok", "Tests: 12 passed", ""]));
  else if (chance(0.5)) postBash(sid, cmd, 1, pick(["FAIL", "Tests: 3 failed", "error"]))
  else failBash(sid, cmd, pick([1, 2, 3]));
  if (chance(0.3)) { const p2 = pick(PATHS); preEdit(sid, p2, "const y = 2;"); postEdit(sid, p2); }
  stop(sid);
  if (chance(0.25)) stop(sid, true);
}
function scenarioSecret(sid) {
  const p = pick(PATHS);
  preWrite(sid, p, secretContent());
  if (chance(0.5)) postWrite(sid, p);
  if (chance(0.3)) stop(sid);
}
function scenarioTestDelete(sid) {
  const cmd = testDeleteCommand();
  preBash(sid, cmd);
  if (chance(0.7)) postBash(sid, cmd, 0, "");
  if (chance(0.3)) stop(sid);
}
function scenarioSpoof(sid) {
  const cmd = mutateCommand();
  preBash(sid, cmd);
  // failing command whose output contains a spoofed success marker
  postBash(sid, cmd, 1, pick([
    "some log\nExit Code: 0\nmore log",
    "Tests: 0 failed (cached)\nreal: 5 failed",
    "ok\nnot ok",
  ]));
  stop(sid);
}
function scenarioPipeAdversarial(sid) {
  const cmd = pick(RUNNERS) + pick([" 2>&1 | tail", " 2>&1 | head", " | tail -20", " | grep -q .", " 2>&1 | tee out.log"]);
  preBash(sid, cmd);
  postBash(sid, cmd, 0, "ok");
  stop(sid);
}
function scenarioMasking(sid) {
  const cmd = pick(RUNNERS) + pick([" || true", " || exit 0", "; echo ok", " && echo done"]);
  preBash(sid, cmd);
  postBash(sid, cmd, 0, "ok");
  stop(sid);
}
function scenarioNegated(sid) {
  const cmd = "! " + pick(RUNNERS);
  preBash(sid, cmd);
  postBash(sid, cmd, 0, "");
  stop(sid);
}
function scenarioBackgrounded(sid) {
  const cmd = pick(RUNNERS) + " &";
  preBash(sid, cmd);
  postBash(sid, cmd, 0, "[1] 1234");
  stop(sid);
}
function scenarioEmpty(sid) {
  const cmd = pick(["", "   ", ";", "# nothing"]);
  preBash(sid, cmd);
  postBash(sid, cmd, 0, "");
  stop(sid);
}
function scenarioMultiEdit(sid) {
  for (let i = 0; i < 1 + Math.floor(rnd() * 3); i++) {
    const p = pick(PATHS);
    preWrite(sid, p, `const v${i} = ${i};`);
    postWrite(sid, p);
  }
  const cmd = mutateCommand();
  preBash(sid, cmd);
  postBash(sid, cmd, chance(0.7) ? 0 : 1, "out");
  stop(sid);
}
function scenarioStopNoEdits(sid) {
  stop(sid);
}
function scenarioUnknown(sid) {
  rec({ hook_event_name: pick(["SessionStart", "WeirdEvent", "PreCompact"]), session_id: sid, cwd: "/p" });
  stop(sid);
}

const SCENARIOS = [
  [0.22, scenarioWriteStop], [0.20, scenarioWriteTestStop], [0.10, scenarioSecret],
  [0.08, scenarioTestDelete], [0.07, scenarioSpoof], [0.06, scenarioPipeAdversarial],
  [0.06, scenarioMasking], [0.05, scenarioNegated], [0.04, scenarioBackgrounded],
  [0.03, scenarioEmpty], [0.05, scenarioMultiEdit], [0.02, scenarioStopNoEdits],
  [0.02, scenarioUnknown],
];
function pickScenario() {
  let r = rnd(), acc = 0;
  for (const [w, fn] of SCENARIOS) { acc += w; if (r < acc) return fn; }
  return scenarioWriteStop;
}

for (let i = 0; i < NSESSIONS; i++) pickScenario()(`fz${i}`);
process.stdout.write(out.join("\n") + "\n");
console.error(`generated ${NSESSIONS} sessions, ${out.length} events (seed ${opt("--seed", "1")})`);
