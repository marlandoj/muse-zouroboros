#!/usr/bin/env bash
# Verity hybrid Phase 2 — `verity run`, `verity gate`, the push guard and
# `verity feedback`, end to end through engine/cli.js with fake harness
# children (shell scripts) over scratch repos: children that edit code, delete
# a test, plant a secret, push to a local bare remote, crash, and get
# interrupted; the exit-code table in shadow and (promoted) live; gate refusing
# every allowance-shaped flag (K7); the push guard on a secret and a clean
# push; chaining to a repo's own hooks path, including a failing hook; a
# non-git workspace through the shadow-git path and its caps; a shared-cwd
# second run; shadow-store pruning; report grouping and the K5 read.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/engine/cli.js"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
unset VERITY_MODE VERITY_CHECKS VERITY_DISABLE VERITY_LOG VERITY_RUN_ID GIT_CONFIG_COUNT
export VERITY_HOME="$T/vh" VERITY_ENGINE_HOME="$T/eh"
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
STORE="$VERITY_HOME/verdicts.jsonl"
GHP="ghp_$(printf 'B2%.0s' $(seq 1 18))"   # GitHub-token-shaped; must never reach any Verity record or file
K="$T/kids"; mkdir -p "$K"

# A repo with code, a test, a passing check script and a trusted .verity.json naming it.
mkrepo() {  # $1 = dir, $2 = check command (default: bash ./run-tests.sh)
  mkdir -p "$1" && (cd "$1" && git init -q -b main && git config commit.gpgsign false
    mkdir -p src tests
    echo 'export const a = 1;' > src/a.ts
    echo 'import "../src/a"; it("a", () => {});' > tests/a.test.ts
    printf '#!/usr/bin/env bash\necho "ran tests"\nexit "${FAIL_CODE:-0}"\n' > run-tests.sh
    jq -nc --arg c "${2:-bash ./run-tests.sh}" '{check: $c}' > .verity.json
    git add -A && git commit -qm init
    node "$CLI" trust >/dev/null)
}
kid() { printf '#!/usr/bin/env bash\n%s\n' "$2" > "$K/$1.sh"; chmod +x "$K/$1.sh"; }
# vrun <dir> <args...> → runs the wrapper in <dir>; RX = its exit code
vrun() { local d="$1"; shift; (cd "$d" && node "$CLI" run --headless "$@" 2>"$T/stderr"); RX=$?; }
last() { tail -n 1 "$STORE"; }
lastj() { last | jq -r "$1"; }
cfg() { mkdir -p "$VERITY_HOME"; printf '%s\n' "$1" > "$VERITY_HOME/config.json"; }
LIVE='{"mode":"live","run":{"promoted":true}}'

# ---------------------------------------------------------------- 1. a child that edits code (shadow)
R="$T/r1"; mkrepo "$R"
kid edit 'echo "export const b = 2;" > src/b.ts; exit 3'
vrun "$R" -- "$K/edit.sh"
check "shadow: the wrapper exits with the child's own code" "$RX" "3"
check "edit + trusted check passing → pass, recorded on the cli surface" "$(lastj '[.surface, .event, .verdict.decision, .kind, .mode, .applied, .verdict.childExit] | map(tostring) | join(" ")')" "cli run pass none shadow false 3"
RUN1="$(lastj .session)"
check "the base lands outside the workspace, its sha256 recorded" "$(jq -r '(.basePath | startswith("'"$VERITY_HOME"'/runs/")) and (.baseSha256 | length == 64)' "$VERITY_HOME/runs/$RUN1/run.json") $(git -C "$R" status --porcelain | grep -c verity)" "true 0"
check "the check came from the trusted project config, overhead excludes it" "$(lastj '[.verdict.check.source, (.checkMs >= 0), (.ms >= 0)] | map(tostring) | join(" ")')" "verity-json-trusted true true"
check "the child saw its run id and the git guard environment" "$(cd "$R" && node "$CLI" run --headless -- bash -c 'echo "$VERITY_RUN_ID $GIT_CONFIG_COUNT $GIT_CONFIG_KEY_0 ${GIT_CONFIG_VALUE_0##*/}"' 2>/dev/null | sed -E 's/^r-[0-9T]+-[0-9a-f]{6}/RID/')" "RID 1 core.hooksPath hooks"

# ---------------------------------------------------------------- 2. delete a test, plant a secret, failing check
R="$T/r2"; mkrepo "$R"
kid deltest 'git rm -q tests/a.test.ts'
vrun "$R" -- "$K/deltest.sh"
check "test deletion → fail, deny kind, shadow exit = child's 0" "$RX $(lastj '[.verdict.decision, .kind] | join(" ")')" "0 fail deny"
FB="$VERITY_HOME/runs/$(lastj .session)/feedback.md"
check "feedback file carries the verdict message" "$(grep -c 'tests/a.test.ts was removed from the tests' "$FB")" "1"
git -C "$R" checkout -q -- . && git -C "$R" reset -q --hard
kid secret "echo 'const k = \"$GHP\";' > src/k.ts"
vrun "$R" -- "$K/secret.sh"
check "planted secret → fail, deny kind" "$(lastj '[.verdict.decision, .kind, .verdict.findings[0].rule, .verdict.findings[0].label] | join(" ")')" "fail deny secret a GitHub token"
check "the secret value appears in no Verity record or file" "$(grep -rl "$GHP" "$VERITY_HOME" | wc -l | tr -d ' ')" "0"
rm -f "$R/src/k.ts"
kid failcheck 'echo "export const c = 3;" > src/c.ts'
FAIL_CODE=1 vrun "$R" -- "$K/failcheck.sh"
FB="$VERITY_HOME/runs/$(lastj .session)/feedback.md"
check "failing check → fail, done kind" "$(lastj '[.verdict.decision, .kind] | join(" ")')" "fail done"
check "feedback = message + the check log tail in the orchestrator's wording" "$(grep -c 'Last 40 lines of the trusted check (`bash ./run-tests.sh`, exit 1):' "$FB") $(grep -c 'ran tests' "$FB")" "1 1"
rm -f "$R/src/c.ts"
printf '#!/usr/bin/env bash\nfor i in $(seq 1 60); do echo "line $i"; done\necho "token %s"\nexit 1\n' "$GHP" > "$R/run-tests.sh"
echo 'export const d = 4;' > "$R/src/d.ts"
node "$CLI" verify --cwd "$R" --base "$VERITY_HOME/runs/$RUN1/base.json" --json >/dev/null 2>&1
V="$T/v.json"; (cd "$R" && node "$CLI" snapshot --cwd "$R" --out "$T/b.json" >/dev/null && echo 'export const e = 5;' > src/e.ts && node "$CLI" verify --cwd "$R" --base "$T/b.json" --check "bash ./run-tests.sh" --check-log "$T/v.log" --json > "$V")
OUTF="$(node "$CLI" feedback --verdict "$V" --plain)"
check "feedback CLI: last 40 lines only, credential named by label, never shown" "$(printf '%s\n' "$OUTF" | grep -c '^line ') $(printf '%s' "$OUTF" | grep -c "$GHP") $(printf '%s' "$OUTF" | grep -c 'token \[redacted: a GitHub token\]')" "39 0 1"
git -C "$R" checkout -q -- . && git -C "$R" clean -qfd

# ---------------------------------------------------------------- 3. crash, untrusted config, interrupt
kid crash 'echo "export const f = 6;" > src/f.ts; kill -SEGV $$'
vrun "$R" -- "$K/crash.sh"
check "a crashing child: verified and recorded, shadow exit = 128+SIGSEGV" "$RX $(lastj '[.verdict.decision, .verdict.childExit] | map(tostring) | join(" ")')" "139 pass 139"
rm -f "$R/src/f.ts"
R3="$T/r3"; mkrepo "$R3"; echo '{}' > "$R3/.verity.json"   # edited after trust: untrusted, and no check at the base revision either
git -C "$R3" commit -qam 'untrusted'
kid code 'echo "export const g = 7;" > src/g.ts'
vrun "$R3" -- "$K/code.sh"
check "no trusted check → unverifiable, done kind" "$(lastj '[.verdict.decision, .kind] | join(" ")')" "unverifiable done"
rm -f "$R3/src/g.ts"
kid sleepy 'echo "export const h = 8;" > src/h.ts; trap "exit 0" INT TERM; while :; do sleep 0.1; done'
for sig in INT TERM; do
  cfg "$LIVE"; jq '.run.relaunch.cli = "touch '"$T"'/relaunched"' "$VERITY_HOME/config.json" > "$T/c" && mv "$T/c" "$VERITY_HOME/config.json"
  (cd "$R" && exec node "$CLI" run --headless --session s1 -- "$K/sleepy.sh" 2>/dev/null) & W=$!
  sleep 1.5; kill -"$sig" "$W"; wait "$W"; RX=$?
  check "SIG$sig to the wrapper (live, relaunch configured): verified, recorded, never relaunched, 128+n" "$RX $(lastj '[.verdict.signal, .verdict.decision, .verdict.relaunches] | map(tostring) | join(" ")') $([ -e "$T/relaunched" ] && echo relaunched || echo none)" "$([ $sig = INT ] && echo 130 || echo 143) SIG$sig pass 0 none"
  rm -f "$R/src/h.ts"; echo '{}' > "$VERITY_HOME/config.json"
done
cfg '{}'
git -C "$R" checkout -q -- . 2>/dev/null; git -C "$R" clean -qfd

# ---------------------------------------------------------------- 4. the exit-code table, live (promoted) vs shadow
kid passexit5 'echo "export const i = 9;" > src/i.ts; exit 5'
cfg "$LIVE"; vrun "$R" -- "$K/passexit5.sh"
check "live: non-zero child + passing workspace → 0, child's code recorded" "$RX $(lastj '[.mode, .verdict.decision, .verdict.childExit] | map(tostring) | join(" ")')" "0 live pass 5"
git -C "$R" clean -qfd
vrun "$R" -- "$K/deltest.sh"
check "live: fail → 1, applied" "$RX $(lastj '.applied')" "1 true"
git -C "$R" reset -q --hard
vrun "$R3" -- "$K/code.sh"
check "live: unverifiable → 2" "$RX" "2"
git -C "$R3" clean -qfd
cfg '{"mode":"live"}'; vrun "$R" -- "$K/passexit5.sh"
check "resolver says live but run is not promoted → shadow, downgraded, child's code" "$RX $(lastj '[.mode, .requestedMode, .downgraded] | join(" ")')" "5 shadow live not_promoted"
git -C "$R" clean -qfd
cfg '{"run":{"promoted":true}}'; VERITY_MODE=live vrun "$R" -- "$K/passexit5.sh"
check "the mode resolver is the posture's single source (VERITY_MODE env honoured)" "$RX $(lastj .mode)" "0 live"
git -C "$R" clean -qfd

# ---------------------------------------------------------------- 5. relaunch (live headless), TUI, shadow
cfg '{"mode":"live","run":{"promoted":true,"relaunch":{"cli":"cp {feedbackFile} '"$T"'/seen.md && git checkout -q HEAD -- tests && echo {session} > '"$T"'/session"}}}'
vrun "$R" --session sess-1 -- "$K/deltest.sh"
check "live headless: one relaunch with the feedback file and session, then pass → 0" "$RX $(lastj '[.verdict.decision, .verdict.relaunches] | map(tostring) | join(" ")') $(cat "$T/session") $(grep -c 'verity-run-feedback' "$T/seen.md")" "0 pass 1 sess-1 2"
cfg '{"mode":"live","run":{"promoted":true,"relaunch":{"cli":"true"}}}'
vrun "$R" --session sess-2 -- "$K/deltest.sh"
check "live: default budget is one relaunch, then the gate's code" "$RX $(lastj '.verdict.relaunches')" "1 1"
git -C "$R" reset -q --hard
(cd "$R" && node "$CLI" run --tui --session sess-3 -- "$K/deltest.sh" 2>"$T/stderr"); RX=$?
check "live TUI: no automatic relaunch; verdict and the resume command printed" "$RX $(lastj '.verdict.relaunches') $(grep -c "not relaunched automatically; to resume with the feedback: true" "$T/stderr")" "1 0 1"
git -C "$R" reset -q --hard
cfg '{"run":{"relaunch":{"cli":"touch '"$T"'/shadow-relaunch"}}}'
vrun "$R" --session s -- "$K/deltest.sh"
check "shadow: relaunch stays inert, the command is only suggested" "$RX $([ -e "$T/shadow-relaunch" ] && echo ran || echo inert) $(grep -c 'shadow: not relaunched' "$T/stderr")" "0 inert 1"
git -C "$R" reset -q --hard; cfg '{}'
check "presets ship only for verified harnesses; gemini has none" "$(node --input-type=module -e 'import { RELAUNCH_PRESETS, HARNESSES_WITHOUT_PRESET } from "'"$ROOT"'/engine/run.js"; process.stdout.write(Object.keys(RELAUNCH_PRESETS).sort().join(",") + " | " + HARNESSES_WITHOUT_PRESET.join(","))')" "claude,codex,hermes,kimi,opencode,pi | gemini"

# ---------------------------------------------------------------- 6. gate: K7 and the checkpoint
codes=""
for f in --check --check-source --check-cwd --check-timeout --check-log --policy --ignore --exclude --max-depth; do
  (cd "$R" && node "$CLI" gate "$f" x >/dev/null 2>&1); codes="$codes$?,"
done
for f in --waived --allow-test-deletion --allow-secrets --allow-check-edits --require-check --allow-secrets=1; do
  (cd "$R" && node "$CLI" gate --base "$T/b.json" "$f" >/dev/null 2>&1); codes="$codes$?,"
done
check "K7: gate rejects every allowance-, waiver- and check-shaped flag with a usage error" "$codes" "64,64,64,64,64,64,64,64,64,64,64,64,64,64,64,"
codes=""
for f in --allow-secrets --check --waived --ignore=x; do (cd "$R" && node "$CLI" run "$f" -- true >/dev/null 2>&1); codes="$codes$?,"; done
check "K7: run rejects them too, before anything is spawned" "$codes" "64,64,64,64,"
kid selfcheck "echo 'const k = \"$GHP\";' > src/k.ts; echo '{\"check\":\"true\",\"allow\":[\"secrets\"]}' > .verity.json; node $CLI gate > $T/gate.json; echo \$? > $T/gate.rc"
vrun "$R" -- "$K/selfcheck.sh"
check "K7: a child that rewrites .verity.json to allow secrets still fails its own gate and the run" "$(cat "$T/gate.rc") $(jq -r '.decision + " " + (.findings[0].rule)' "$T/gate.json") $(lastj .verdict.decision)" "1 fail secret fail"
check "gate from inside the session judged against the run's base (run id from the env)" "$(jq -r '.runId' "$T/gate.json")" "$(lastj .session)"
git -C "$R" checkout -q -- . && git -C "$R" clean -qfd
(cd "$R" && node "$CLI" gate >/dev/null 2>&1); G1=$?
echo 'export const z = 1;' > "$R/src/z.ts"
(cd "$R" && node "$CLI" gate --base "$T/b.json" > "$T/g2.json" 2>/dev/null); G2=$?
check "gate: no active run → usage 64; a named base → the verify codes, recorded as event gate" "$G1 $G2 $(lastj '[.event, .surface] | join(" ")')" "64 0 gate cli"
rm -f "$R/src/z.ts"

# ---------------------------------------------------------------- 7. push guard
BARE="$T/remote.git"; git init -q --bare "$BARE"
printf '#!/usr/bin/env bash\ntouch "%s/remote-pre-receive"\n' "$T" > "$BARE/hooks/pre-receive"; chmod +x "$BARE/hooks/pre-receive"
R7="$T/r7"; mkrepo "$R7"; git -C "$R7" remote add origin "$BARE"; git -C "$R7" push -q origin main 2>/dev/null
kid pushsecret "echo 'k = \"$GHP\"' > src/s.ts && git add -A && git commit -qm s && git push -q origin main 2>/dev/null; echo \$? > $T/push.rc"
vrun "$R7" -- "$K/pushsecret.sh"
P="$(grep '"event":"prepush"' "$STORE" | tail -n 1)"
check "push guard: a secret in the outgoing range → prepush deny verdict; shadow lets the push through" "$(cat "$T/push.rc") $(jq -r '[.verdict.decision, .kind, .applied, .verdict.findings[0].rule, .verdict.chain] | map(tostring) | join(" ")' <<<"$P")" "0 fail deny false secret none"
check "push guard: the remote's own hooks still run" "$([ -e "$T/remote-pre-receive" ] && echo ran)" "ran"
kid pushhist "echo 'k = \"$GHP\"' > src/h.ts && git add -A && git commit -qm a && git rm -q src/h.ts && git commit -qm b && git push -q origin main 2>/dev/null"
vrun "$R7" -- "$K/pushhist.sh"
check "push guard: a secret added and removed inside the range is still in the pushed history" "$(grep '"event":"prepush"' "$STORE" | tail -n 1 | jq -r '.verdict.decision + " " + .verdict.findings[0].path')" "fail src/h.ts"
kid pushclean 'echo "export const q = 1;" > src/q.ts && git add -A && git commit -qm q && git push -q origin main 2>/dev/null'
vrun "$R7" -- "$K/pushclean.sh"
check "push guard: a clean push passes, kind none" "$(grep '"event":"prepush"' "$STORE" | tail -n 1 | jq -r '.verdict.decision + " " + .kind')" "pass none"
check "the user's repo config and hooks dir are untouched" "$(git -C "$R7" config --get core.hooksPath || echo unset) $(ls "$R7/.git/hooks" | grep -vc '\.sample$')" "unset 0"

# ---------------------------------------------------------------- 8. chaining to the repo's own hooks
R8="$T/r8"; mkrepo "$R8"; git -C "$R8" remote add origin "$BARE"
mkdir -p "$R8/.husky/_"; git -C "$R8" config core.hooksPath .husky/_
printf '#!/usr/bin/env bash\nread -r line; echo "$line" > "%s/husky-stdin"; echo "$1" > "%s/husky-ran"\n' "$T" "$T" > "$R8/.husky/_/pre-push"; chmod +x "$R8/.husky/_/pre-push"
printf '#!/usr/bin/env bash\ntouch "%s/husky-pre-commit"\n' "$T" > "$R8/.husky/_/pre-commit"; chmod +x "$R8/.husky/_/pre-commit"
kid pushbranch 'git checkout -q -b feat && echo "export const w = 1;" > src/w.ts && git add -A && git commit -qm w && git push -q origin feat 2>/dev/null; echo $? > '"$T"'/push.rc'
vrun "$R8" -- "$K/pushbranch.sh"
check "chaining: the repo's hooks path (husky layout) still runs, with git's stdin and args" "$(cat "$T/push.rc") $(cat "$T/husky-ran") $(cut -d' ' -f1 "$T/husky-stdin") $([ -e "$T/husky-pre-commit" ] && echo pre-commit)" "0 origin refs/heads/feat pre-commit"
check "chaining recorded on the prepush verdict" "$(grep '"event":"prepush"' "$STORE" | tail -n 1 | jq -r '.verdict.chain + " " + (.verdict.repoHookExit|tostring)')" "chained 0"
printf '#!/usr/bin/env bash\necho "repo hook says no" >&2\nexit 1\n' > "$R8/.husky/_/pre-push"
(cd "$R8" && echo x >> src/w.ts && git commit -qam x && git push -q origin feat 2>/dev/null); UNWRAPPED=$?
kid pushfail 'git push -q origin feat 2>/dev/null; echo $? > '"$T"'/push.rc'
vrun "$R8" -- "$K/pushfail.sh"
check "chaining: a failing repo hook fails the push exactly as unwrapped; Verity still records" "$UNWRAPPED $(cat "$T/push.rc") $(grep '"event":"prepush"' "$STORE" | tail -n 1 | jq -r '.verdict.chain + " " + (.verdict.repoHookExit|tostring)')" "1 1 chained 1"
chmod -x "$R8/.husky/_/pre-push"
vrun "$R8" -- "$K/pushfail.sh"
check "chaining: a non-executable repo hook is ignored, as git ignores it" "$(cat "$T/push.rc") $(grep '"event":"prepush"' "$STORE" | tail -n 1 | jq -r '.verdict.chain')" "0 ignored_not_executable"
kid pushself 'git config core.hooksPath "$GIT_CONFIG_VALUE_0"; echo y >> src/w.ts; git commit -qam y; git push -q origin feat 2>/dev/null; echo $? > '"$T"'/push.rc'
vrun "$R8" -- "$K/pushself.sh"
check "unchainable layout (hooks path is the guard itself): guard still runs, layout recorded unverifiable" "$(cat "$T/push.rc") $(grep '"event":"prepush"' "$STORE" | tail -n 1 | jq -r '.verdict.chain + " " + .verdict.decision')" "0 unverifiable:hooks_path_is_the_guard pass"

# ---------------------------------------------------------------- 9. non-git workspace: shadow git, caps, pruning
N="$T/plain"; mkdir -p "$N/src" "$N/node_modules/x"; echo 'export const a = 1;' > "$N/src/a.ts"
printf '#!/usr/bin/env bash\necho ok\n' > "$N/run-tests.sh"; mkdir -p "$N/tests"; echo 'it("a")' > "$N/tests/a.test.ts"
echo '{"check":"bash ./run-tests.sh"}' > "$N/.verity.json"; (cd "$N" && node "$CLI" trust >/dev/null)
SG="$VERITY_HOME/shadow-git/$(node --input-type=module -e 'import { rootKey } from "'"$ROOT"'/engine/run.js"; process.stdout.write(rootKey(process.argv[1]))' "$N")"
kid plainedit 'echo "export const b = 2;" > src/b.ts; echo "dep" > node_modules/x/i.js; ls -d "'"$SG"'" > '"$T"'/sg-during'
vrun "$N" -- "$K/plainedit.sh"
check "non-git: judged through the shadow git, code change seen, heavy dirs excluded" "$(lastj '[.verdict.decision, .verdict.code, .verdict.shadowGit] | map(tostring) | join(" ")') $(cat "$T/sg-during" | wc -l | tr -d ' ')" "pass 1 true 1"
check "non-git: the workspace never gains a .git; the shadow store is pruned when the run completes" "$([ -e "$N/.git" ] && echo git || echo nogit) $([ -e "$SG" ] && echo kept || echo pruned)" "nogit pruned"
kid plaintest 'rm tests/a.test.ts'
vrun "$N" -- "$K/plaintest.sh"
check "non-git: test deletion through the shadow git → fail" "$(lastj '.verdict.decision + " " + .kind')" "fail deny"
echo 'it("a")' > "$N/tests/a.test.ts"
mkdir -p "$N/many"; (cd "$N/many" && seq 1 5001 | xargs touch)
vrun "$N" -- "$K/plainedit.sh"
check "non-git above the file cap: unverifiable with truncation stated, never a pass" "$(lastj '[.verdict.decision, .verdict.truncated, .verdict.truncatedReason] | map(tostring) | join(" ")') $(lastj .verdict.reason | grep -c 'above the shadow-git caps')" "unverifiable true files_over_cap 1"
rm -rf "$N/many" "$N/src/b.ts"

# ---------------------------------------------------------------- 10. shared cwd: second run downgraded and attributed, store kept for the first
cfg "$LIVE"
kid holder 'echo "export const s1 = 1;" > src/s1.ts; while [ ! -e "'"$T"'/release" ]; do sleep 0.1; done'
(cd "$N" && exec node "$CLI" run --headless -- "$K/holder.sh" 2>/dev/null) & H=$!
for _ in $(seq 1 50); do [ -n "$(ls "$VERITY_HOME/locks/"*/ 2>/dev/null)" ] && break; sleep 0.1; done
kid second 'echo "export const s2 = 1;" > src/s2.ts; exit 4'
vrun "$N" -- "$K/second.sh"
check "shared cwd: the second run is attributed shared and live drops to shadow (child's code)" "$RX $(lastj '[.attribution, .mode, .requestedMode, .downgraded] | join(" ")')" "4 shared shadow live shared_workspace"
check "shared cwd: the shadow store survives while the first run is alive" "$([ -e "$SG" ] && echo kept)" "kept"
touch "$T/release"; wait "$H"
check "shared cwd: the first run is attributed shared too, and its completion prunes the store" "$(lastj '[.attribution, .mode] | join(" ")') $([ -e "$SG" ] && echo kept || echo pruned)" "shared shadow pruned"
cfg '{}'

# ---------------------------------------------------------------- 11. report: grouping by surface, the K5 read, old stores
REP="$(bash "$ROOT/scripts/report.sh")"
check "report groups by surface and prints the K5 unverifiable rate for wrapper verdicts" "$(printf '%s\n' "$REP" | grep -c '^  cli: ') $(printf '%s\n' "$REP" | grep -c '^cli run unverifiable (K5): ')" "1 1"
K5="$(jq -s -r '[.[] | select(.surface == "cli" and .event == "run")] | "\(map(select(.verdict.decision == "unverifiable")) | length)/\(length)"' "$STORE")"
check "the K5 line matches the store read directly" "$(printf '%s\n' "$REP" | sed -n 's/^cli run unverifiable (K5): \([0-9]*\/[0-9]*\).*/\1/p')" "$K5"
OLD="$T/old.jsonl"; printf '%s\n' '{"ts":"2026-10-01T00:00:00Z","ms":5,"harness":"claude","mode":"shadow","kind":"none","applied":false,"event":"Stop","session":"s","verdict":{}}' > "$OLD"
OREP="$(VERITY_LOG="$OLD" bash "$ROOT/scripts/report.sh")"
check "report on a store that predates the surface field: old output intact, counted as hook" "$(printf '%s\n' "$OREP" | head -n 1) | $(printf '%s\n' "$OREP" | grep '^  hook: ')" "claude: 1 verdicts, 0 applied, p50 5 ms |   hook: 1 verdicts, 0 applied"

# ---------------------------------------------------------------- 12. installer prints aliases, edits nothing
FH="$T/fakehome"; mkdir -p "$FH"
AL="$(HOME="$FH" bash "$ROOT/scripts/install.sh" --print-aliases)"
check "installer --print-aliases prints a run alias per harness and writes nothing" "$(printf '%s\n' "$AL" | grep -c "^alias v[a-z]*='node .*cli.js run --harness ") $(find "$FH" -mindepth 1 | wc -l | tr -d ' ')" "7 0"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
