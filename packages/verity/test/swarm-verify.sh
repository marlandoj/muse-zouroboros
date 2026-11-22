#!/usr/bin/env bash
# Verity×Swarm (Stage 2b) — hermetic tests for `engine/cli.js snapshot` / `verify`
# over scratch git fixtures. Covers the Stage 1 memo's acceptance list at the
# engine level: no check → unverifiable/fail, passing check, failing check,
# masked check (64), deleted/renamed tests, planted secret (no value in any
# output), untracked new code, docs-only (check provably not run), hollow pass,
# check-definition tampering, base-revision-only .verity.json, factory shape
# (non-git root + nested clone judged against the upstream merge-base), missing
# base tree (70), policy by remote, info/exclude hiding, and the engine fixes
# #3 (trusted pattern masking) and #4 (every credential match).
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/engine/cli.js"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
GHP="ghp_$(printf 'A1%.0s' $(seq 1 18))"   # a GitHub-token-shaped string (letters+digits) that must never appear in any output

# A repo with code, a test, a package.json test script that runs ./run-tests.sh
# (exit $FAIL_CODE, touches $MARKER when set) and a README.
mkrepo() {  # $1 = dir
  mkdir -p "$1" && (cd "$1" && git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false
    mkdir -p src tests
    echo 'export const a = 1;' > src/a.ts
    echo 'import "../src/a";' > tests/a.test.ts
    printf '{"name":"fx","scripts":{"test":"bash ./run-tests.sh"}}\n' > package.json
    printf '#!/usr/bin/env bash\n[ -n "${MARKER:-}" ] && touch "$MARKER"\necho "ran tests"\nexit "${FAIL_CODE:-0}"\n' > run-tests.sh
    echo '# fixture' > README.md
    git add -A && git commit -qm init)
}
snap()   { node "$CLI" snapshot --cwd "$1" --out "$2" >/dev/null; echo $?; }
# verify → prints the verdict JSON; VX holds the exit code
verify() { OUT="$(node "$CLI" verify --cwd "$@" --json)"; VX=$?; printf '%s' "$OUT"; }
jqv()    { jq -r "$1" <<<"$OUT"; }

# ---------------------------------------------------------------- 1. workspace root IS a repo
W="$T/w1"; mkrepo "$W"
IDX_BEFORE="$(sha256sum "$W/.git/index" | cut -d' ' -f1)"
check "snapshot ok" "$(snap "$W" "$T/w1.base.json")" "0"
check "base records root repo" "$(jq -r '.repos[0].path' "$T/w1.base.json")" "."
check "base has no loose manifest for a repo root" "$(jq -r '.loose' "$T/w1.base.json")" "null"

echo more >> "$W/README.md"
verify "$W" --base "$T/w1.base.json" --check "bash ./run-tests.sh" --check-log "$T/w1.docs.log" >/dev/null
check "docs-only passes" "$VX $(jqv .decision)" "0 pass"
check "docs-only: check not run" "$(jqv '.check')" "null"
check "docs-only: no code" "$(jqv '.changes.code | length')" "0"

echo 'export const b = 2;' > "$W/src/b.ts"            # untracked, never git-added
verify "$W" --base "$T/w1.base.json" >/dev/null
check "untracked code, no check → unverifiable (2)" "$VX $(jqv .decision)" "2 unverifiable"
check "untracked code counted" "$(jqv '.changes.untrackedCode[0]')" "src/b.ts"
verify "$W" --base "$T/w1.base.json" --require-check >/dev/null
check "untracked code, --require-check → fail (1)" "$VX $(jqv .decision)" "1 fail"
check "no_passing_check finding" "$(jqv '.findings[0].rule + ":" + .findings[0].detail')" "no_passing_check:no trusted check configured"

MARKER="$T/w1.marker" verify "$W" --base "$T/w1.base.json" --check "bash ./run-tests.sh" --check-log "$T/w1.pass.log" >/dev/null
check "code + passing check → pass" "$VX $(jqv .decision)" "0 pass"
check "check recorded with source" "$(jqv '.check.source + ":" + (.check.exitCode|tostring)')" "task:0"
check "check actually ran (marker)" "$([ -f "$T/w1.marker" ] && echo yes)" "yes"
check "check log holds output, verdict only its hash" "$(grep -c 'ran tests' "$T/w1.pass.log") $(jqv '.check.outputSha256 | length')" "1 64"
check "verdict never carries output text" "$(grep -c 'ran tests' <<<"$OUT")" "0"

FAIL_CODE=3 verify "$W" --base "$T/w1.base.json" --check "bash ./run-tests.sh" >/dev/null
check "failing check → fail" "$VX $(jqv .decision)" "1 fail"
check "failing check finding" "$(jqv '[.findings[]|select(.rule=="no_passing_check")][0].detail')" "exit 3"
check "message names the file and the exit" "$(jqv .message | grep -c 'src/b.ts changed, but no check has passed.*(exit 3)')" "1"

for masked in "bash ./run-tests.sh || true" "bash ./run-tests.sh; echo ok" "bash ./run-tests.sh &" "bash ./run-tests.sh | tail"; do
  verify "$W" --base "$T/w1.base.json" --check "$masked" >/dev/null
  check "masked check [$masked] → usage error 64" "$VX $(jqv .decision)" "64 error"
done
verify "$W" --base "$T/w1.base.json" --check "set -o pipefail && bash ./run-tests.sh | tail -n 5" >/dev/null
check "pipefail-safe pipe is a runnable check" "$VX $(jqv .decision)" "0 pass"

# untracked work must stay untracked: the real index is never touched
check "real index untouched by snapshot/verify" "$(sha256sum "$W/.git/index" | cut -d' ' -f1)" "$IDX_BEFORE"
check "b.ts still untracked" "$(git -C "$W" status --porcelain -- src/b.ts)" "?? src/b.ts"

# ---------------------------------------------------------------- 2. test deletion (rm, git rm, committed) + rename
W="$T/w2"; mkrepo "$W"; snap "$W" "$T/w2.base.json" >/dev/null
rm "$W/tests/a.test.ts"
verify "$W" --base "$T/w2.base.json" --check "bash ./run-tests.sh" >/dev/null
check "plain rm of a test → fail" "$VX $(jqv '[.findings[]|select(.rule=="test_deletion")][0].path')" "1 tests/a.test.ts"
check "check skipped on blocking findings" "$(jqv '.check.skipped')" "blocking_findings"
git -C "$W" checkout -q -- tests/a.test.ts && git -C "$W" rm -q tests/a.test.ts
verify "$W" --base "$T/w2.base.json" --check "bash ./run-tests.sh" >/dev/null
check "git rm of a test → fail" "$VX $(jqv .decision)" "1 fail"
git -C "$W" commit -qm "drop test"
verify "$W" --base "$T/w2.base.json" --check "bash ./run-tests.sh" >/dev/null
check "committed test deletion → fail" "$VX $(jqv '.changes.deletedTests[0]')" "1 tests/a.test.ts"
verify "$W" --base "$T/w2.base.json" --check "bash ./run-tests.sh" --allow-test-deletion >/dev/null
check "--allow-test-deletion lets the task's requested removal through" "$VX $(jqv .decision)" "0 pass"
W="$T/w2b"; mkrepo "$W"; snap "$W" "$T/w2b.base.json" >/dev/null
mkdir -p "$W/test" && git -C "$W" mv tests/a.test.ts test/a.test.ts
verify "$W" --base "$T/w2b.base.json" --check "bash ./run-tests.sh" >/dev/null
check "test renamed to another test path is not a deletion" "$VX $(jqv '.changes.deletedTests|length')" "0 0"
git -C "$W" mv test/a.test.ts src/old.ts
verify "$W" --base "$T/w2b.base.json" --check "bash ./run-tests.sh" >/dev/null
check "test renamed away from the tests → deletion" "$VX $(jqv '[.findings[]|select(.rule=="test_deletion")][0] | .path + ">" + .renamedTo')" "1 tests/a.test.ts>src/old.ts"
# python / go naming (looksLikeTestFile, not only isTestPath)
W="$T/w2c"; mkrepo "$W"; echo x > "$W/src/test_core.py"; echo y > "$W/src/core_test.go"; git -C "$W" add -A; git -C "$W" commit -qm py; snap "$W" "$T/w2c.base.json" >/dev/null
rm "$W/src/test_core.py" "$W/src/core_test.go"
verify "$W" --base "$T/w2c.base.json" --check "bash ./run-tests.sh" >/dev/null
check "test_x.py and x_test.go deletions caught" "$(jqv '[.findings[]|select(.rule=="test_deletion")|.path]|sort|join(",")')" "src/core_test.go,src/test_core.py"

# ---------------------------------------------------------------- 3. secrets in added lines (path + label + fingerprint only)
W="$T/w3"; mkrepo "$W"; snap "$W" "$T/w3.base.json" >/dev/null
printf 'export const cfg = { password: "changeme", token: "%s" };\n' "$GHP" > "$W/src/cfg.ts"
verify "$W" --base "$T/w3.base.json" --check "bash ./run-tests.sh" > "$T/w3.verdict.json"
check "planted GitHub token → fail" "$VX $(jqv .decision)" "1 fail"
check "secret finding names path + label" "$(jqv '[.findings[]|select(.rule=="secret")]|map(.path + ":" + .label)|join("|")')" "src/cfg.ts:a GitHub token|src/cfg.ts:a hardcoded credential"
check "fingerprint is hash16, not the value" "$(jqv '[.findings[]|select(.rule=="secret")][0].fingerprint|length')" "16"
check "NO token text in the verdict" "$(grep -c "$GHP" "$T/w3.verdict.json")" "0"
check "message names path and label only" "$(jqv .message | grep -c 'src/cfg.ts would contain what looks like a GitHub token')" "1"
verify "$W" --base "$T/w3.base.json" --check "bash ./run-tests.sh" --allow-secrets >/dev/null
check "--allow-secrets (policy waiver) → the check decides" "$VX $(jqv .decision)" "0 pass"
# seeded fixture values (fake marker inside the value) in added lines: no finding,
# as the hook path allows them; an unmarked value beside them still fails
W="$T/w3s"; mkrepo "$W"; snap "$W" "$T/w3s.base.json" >/dev/null
printf 'export const fx = { aws: "%s", gh: "%s" };\n' "AKIA""FAKESEED00000000" "ghp_""FAKEfakeseed""000000000000000000000000" > "$W/src/fixture.ts"
verify "$W" --base "$T/w3s.base.json" --check "bash ./run-tests.sh" >/dev/null
check "seeded-only fixture in diff → no secret finding, pass" "$VX $(jqv '[.findings[]|select(.rule=="secret")]|length') $(jqv .decision)" "0 0 pass"
printf 'export const real = "%s";\n' "$GHP" >> "$W/src/fixture.ts"
verify "$W" --base "$T/w3s.base.json" --check "bash ./run-tests.sh" >/dev/null
check "seeded + unmarked in diff → only the unmarked finding" "$VX $(jqv '[.findings[]|select(.rule=="secret")]|map(.label)|join("|")')" "1 a GitHub token"
# the token was already in the clone before the task: only ADDED lines are scanned
W="$T/w3b"; mkrepo "$W"; printf 'const old = "%s";\n' "$GHP" > "$W/src/fixture.ts"; git -C "$W" add -A; git -C "$W" commit -qm fixture; snap "$W" "$T/w3b.base.json" >/dev/null
echo 'export const c = 3;' >> "$W/src/a.ts"
verify "$W" --base "$T/w3b.base.json" --check "bash ./run-tests.sh" >/dev/null
check "pre-existing token in the clone is not a finding" "$VX $(jqv '.findings|length')" "0 0"

# ---------------------------------------------------------------- 4. hollow pass: test runner in a repo with no test files
W="$T/w4"; mkrepo "$W"; git -C "$W" rm -q -r tests; printf '{"name":"fx","scripts":{"test":"echo ok"}}\n' > "$W/package.json"; git -C "$W" add -A; git -C "$W" commit -qm notests; snap "$W" "$T/w4.base.json" >/dev/null
echo 'export const d = 4;' > "$W/src/d.ts"
if command -v npm >/dev/null 2>&1; then
  verify "$W" --base "$T/w4.base.json" --check "npm test" >/dev/null
  check "test runner passing in a repo with no test files is hollow → fail" "$VX $(jqv '.check.hollow')" "1 true"
  check "hollow finding" "$(jqv '[.findings[]|select(.rule=="no_passing_check")][0].detail')" "hollow pass (no test files)"
else
  echo "skip: npm not installed (hollow-pass case)"
fi

# ---------------------------------------------------------------- 5. check definition tampering; base-revision .verity.json only
W="$T/w5"; mkrepo "$W"; printf '{"check":"bash ./run-tests.sh","ignore":["generated/**"]}\n' > "$W/.verity.json"; git -C "$W" add -A; git -C "$W" commit -qm cfg; snap "$W" "$T/w5.base.json" >/dev/null
echo 'export const e = 5;' > "$W/src/e.ts"
verify "$W" --base "$T/w5.base.json" >/dev/null
check "check from .verity.json at the BASE revision" "$VX $(jqv '.check.source')" "0 verity-json-base"
mkdir -p "$W/generated" && echo 'x' > "$W/generated/out.ts"
verify "$W" --base "$T/w5.base.json" >/dev/null
check "base .verity.json ignore globs apply" "$(jqv '.changes.code|join(",")')" "src/e.ts"
printf '{"check":"true"}\n' > "$W/.verity.json"          # the executor rewrites the working-tree copy
verify "$W" --base "$T/w5.base.json" >/dev/null
check "working-tree .verity.json is ignored and its change is tampering" "$VX $(jqv '[.findings[]|select(.rule=="check_definition_changed")][0].path')" "1 .verity.json"
git -C "$W" checkout -q -- .verity.json
printf '{"name":"fx","scripts":{"test":"echo ok"}}\n' > "$W/package.json"
verify "$W" --base "$T/w5.base.json" --check "npm test" >/dev/null
check "package.json test script rewritten → check_definition_changed" "$VX $(jqv '[.findings[]|select(.rule=="check_definition_changed")][0].path')" "1 package.json"
verify "$W" --base "$T/w5.base.json" --check "npm test" --allow-check-edits >/dev/null
check "allowCheckEdits records but does not block" "$(jqv '[.findings[]|select(.rule=="check_definition_changed")][0].allowed')" "true"
git -C "$W" checkout -q -- package.json
printf '{"name":"fx","scripts":{"test":"bash ./run-tests.sh","lint":"echo lint"}}\n' > "$W/package.json"
verify "$W" --base "$T/w5.base.json" --check "npm test" >/dev/null
check "another script changing is not tampering with the check" "$(jqv '[.findings[]|select(.rule=="check_definition_changed")]|length')" "0"

# ---------------------------------------------------------------- 6. factory shape: non-git root, nested clone appears during the run
UP="$T/upstream"; mkrepo "$UP"
W="$T/w6"; mkdir -p "$W"; echo '# task' > "$W/TASK.md"; echo 'log' > "$W/run.log"
snap "$W" "$T/w6.base.json" >/dev/null
check "non-git root: no repos, loose manifest excludes TASK.md/run.log" "$(jq -r '(.repos|length|tostring) + ":" + (.loose.files|length|tostring)' "$T/w6.base.json")" "0:0"
git clone -q "$UP" "$W/repo" 2>/dev/null
echo 'export const f = 6;' > "$W/repo/src/f.ts"; git -C "$W/repo" add -A; git -C "$W/repo" -c user.email=t@t -c user.name=t commit -qm "work"
echo 'export const g = 7;' > "$W/repo/src/g.ts"       # uncommitted
echo '## summary done' > "$W/RESULT.md"; mkdir -p "$W/evidence"; echo '{"ok":true}' > "$W/evidence/r.json"
verify "$W" --base "$T/w6.base.json" --check "bash ./run-tests.sh" >/dev/null
check "nested clone judged against the upstream merge-base" "$(jqv '.base.repos[0].baseSource + ":" + (.base.repos[0].appeared|tostring)')" "upstream-merge-base:true"
check "committed + uncommitted work both count" "$(jqv '.changes.code|sort|join(",")')" "repo/src/f.ts,repo/src/g.ts"
check "RESULT.md / evidence at the root are never code" "$(jqv '.changes.code|map(select(startswith("repo/")|not))|length')" "0"
check "check ran in the nested repo and passed" "$VX $(jqv '.check.cwd + ":" + (.check.exitCode|tostring)')" "0 repo:0"
printf 'summary: done\ntoken = "%s"\n' "$GHP" > "$W/RESULT.md"
verify "$W" --base "$T/w6.base.json" --check "bash ./run-tests.sh" > "$T/w6.verdict.json"
check "loose RESULT.md with a credential → secret finding (scanned, not code)" "$VX $(jqv '[.findings[]|select(.rule=="secret")][0] | .path + ":" + (.loose|tostring)')" "1 RESULT.md:true"
check "NO token text in the factory-shape verdict" "$(grep -c "$GHP" "$T/w6.verdict.json")" "0"
# a repo the agent created with git init (no upstream) → empty-tree base, everything is new
W="$T/w6b"; mkdir -p "$W"; snap "$W" "$T/w6b.base.json" >/dev/null
mkdir -p "$W/fresh" && (cd "$W/fresh" && git init -q && echo 'x' > a.ts)
verify "$W" --base "$T/w6b.base.json" >/dev/null
check "git-init repo: empty-tree base, all new code" "$VX $(jqv '.base.repos[0].baseSource + ":" + (.changes.code|join(","))')" "2 empty:fresh/a.ts"

# ---------------------------------------------------------------- 7. gate errors: missing base tree, bad base, wrong cwd
W="$T/w7"; mkrepo "$W"; echo 'u' > "$W/src/untracked.ts"; snap "$W" "$T/w7.base.json" >/dev/null
git -C "$W" prune --expire=now 2>/dev/null                 # the unreferenced base tree is gone
verify "$W" --base "$T/w7.base.json" >/dev/null
check "missing base tree → internal error 70" "$VX $(jqv '.errorKind')" "70 internal"
echo '{"schema":"nope"}' > "$T/bad.json"
verify "$W" --base "$T/bad.json" >/dev/null
check "malformed base → usage 64" "$VX" "64"
verify "$T/w2" --base "$T/w1.base.json" >/dev/null
check "base for another cwd → usage 64" "$VX" "64"
node "$CLI" verify --cwd "$W" >/dev/null 2>&1; check "verify without --base → 64" "$?" "64"
node "$CLI" snapshot --cwd "$T/does-not-exist" --out "$T/x.json" >/dev/null 2>&1; check "snapshot of a missing dir → 64" "$?" "64"

# ---------------------------------------------------------------- 8. operator policy by repo remote
W="$T/w8"; git clone -q "$UP" "$W" 2>/dev/null; git -C "$W" remote set-url origin https://github.com/example/fixture.git
snap "$W" "$T/w8.base.json" >/dev/null
printf '{"mode":"shadow","enabled":true,"repos":{"github.com/example/fixture":{"check":"bash ./run-tests.sh","ignore":["*.snap"]}}}\n' > "$T/policy.json"
echo 'export const h = 8;' > "$W/src/h.ts"; echo s > "$W/src/x.snap"
verify "$W" --base "$T/w8.base.json" --policy "$T/policy.json" >/dev/null
check "policy check resolved by normalized remote" "$VX $(jqv '.check.source')" "0 policy"
check "policy ignore globs apply" "$(jqv '.changes.code|join(",")')" "src/h.ts"
verify "$W" --base "$T/w8.base.json" --policy "$T/policy.json" --check "false" >/dev/null
check "explicit task check wins over policy" "$VX $(jqv '.check.source')" "1 task"
verify "$W" --base "$T/w8.base.json" --policy "$T/policy.json" --waived >/dev/null
check "explicit waiver → unverifiable, waived recorded" "$VX $(jqv '.decision + ":" + (.waived|tostring)')" "2 unverifiable:true"

# ---------------------------------------------------------------- 9. info/exclude edited to hide new code (info finding, non-blocking)
W="$T/w9"; mkrepo "$W"; snap "$W" "$T/w9.base.json" >/dev/null
echo 'src/hidden.ts' >> "$W/.git/info/exclude"; echo 'x' > "$W/src/hidden.ts"
verify "$W" --base "$T/w9.base.json" --check "bash ./run-tests.sh" >/dev/null
check "info/exclude change detected" "$(jqv '.changes.excludeChanged')" "true"
check "newly ignored code reported as info" "$(jqv '[.findings[]|select(.rule=="ignored_new_code")][0] | .path + ":" + .severity')" "src/hidden.ts:info"
check "info finding does not block (no other change → pass)" "$VX $(jqv .decision)" "0 pass"

# ---------------------------------------------------------------- 10. engine fixes #3 and #4 (unit, via the engine modules)
node --input-type=module -e '
import { isVerify, detectSecret } from "'"$ROOT"'/engine/checks.js";
const pat = ["bun test"];
const r3 = ["bun test | tail", "bun test; echo ok", "echo bun test", "bun test || true", "bun test &"].map((c) => isVerify(c, pat));
const ok3 = ["bun test", "cd pkg && bun test", "set -o pipefail && bun test | tail"].map((c) => isVerify(c, pat));
const r4 = detectSecret("/p/a.ts", "password = \"changeme\"\ntoken = \"abcdefghij0123456789\"", "/p");
console.log(JSON.stringify({ masked: r3, real: ok3, cred: r4 !== null }));
' > "$T/fixes.json"
check "#3 trusted pattern no longer rescues masked forms" "$(jq -c .masked "$T/fixes.json")" "[false,false,false,false,false]"
check "#3 trusted pattern still prefixes real checks" "$(jq -c .real "$T/fixes.json")" "[true,true,true]"
check "#4 a benign credential first no longer hides the real one" "$(jq -r .cred "$T/fixes.json")" "true"

# ---------------------------------------------------------------- 11. rework fix B: pre-flight contamination stop & verdict attribution
# (a) Pre-flight contamination stop:
# clean workspace passes pre-flight
W="$T/w11_clean"; mkrepo "$W"
OUT="$(node "$CLI" preflight --cwd "$W" --json)"; VX=$?
check "clean workspace preflight passes" "$VX $(jqv .decision) $(jqv .contaminated)" "0 pass false"

# contaminated workspace (secret-shaped string in scratch debris outside candidate base) stops pre-flight
W="$T/w11_dirty"; mkdir -p "$W/scratch"
echo '# task' > "$W/TASK.md"
printf 'dirty token = "%s"\n' "$GHP" > "$W/scratch/dirty.txt"
OUT="$(node "$CLI" preflight --cwd "$W" --json)"; VX=$?
check "contaminated workspace stops preflight" "$VX $(jqv .decision) $(jqv .contaminated)" "1 fail true"
check "preflight identifies contamination errorKind" "$(jqv .errorKind)" "contamination"
check "preflight report names contaminated path" "$(jqv '[.findings[]|select(.rule=="secret")][0].path')" "scratch/dirty.txt"
check "preflight finding marked inDiff false" "$(jqv '[.findings[]|select(.rule=="secret")][0].inDiff')" "false"

# (b) Verdict attribution:
# all-outside-diff findings set records as contamination, not candidate failure
UP="$T/upstream11"; mkrepo "$UP"
W="$T/w11_attr"; mkdir -p "$W"; echo '# task' > "$W/TASK.md"
snap "$W" "$T/w11_attr.base.json" >/dev/null
git clone -q "$UP" "$W/repo" 2>/dev/null
echo 'export const cleanCode = 42;' > "$W/repo/src/clean.ts"
mkdir -p "$W/scratch"
printf 'scratch secret = "%s"\n' "$GHP" > "$W/scratch/debris.txt"
verify "$W" --base "$T/w11_attr.base.json" --check "bash ./run-tests.sh" >/dev/null
check "all-outside-diff findings fail gate" "$VX $(jqv .decision)" "1 fail"
check "finding on outside file marked inDiff false" "$(jqv '[.findings[]|select(.rule=="secret")][0].inDiff')" "false"
check "all-outside-diff flag is true" "$(jqv .allOutsideDiff)" "true"
check "verdict class is contamination, not defect" "$(jqv .verdictClass)" "contamination"

# contrast: finding inside candidate diff records as defect (inDiff true)
W="$T/w11_cand_secret"; mkrepo "$W"; snap "$W" "$T/w11_cand_secret.base.json" >/dev/null
printf 'export const token = "%s";\n' "$GHP" > "$W/src/token.ts"
verify "$W" --base "$T/w11_cand_secret.base.json" --check "bash ./run-tests.sh" >/dev/null
check "in-diff secret finding marked inDiff true" "$(jqv '[.findings[]|select(.rule=="secret")][0].inDiff')" "true"
check "in-diff secret allOutsideDiff is false" "$(jqv .allOutsideDiff)" "false"
check "in-diff secret verdict class is defect" "$(jqv .verdictClass)" "defect"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
