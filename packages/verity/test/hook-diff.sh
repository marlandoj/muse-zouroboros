#!/usr/bin/env bash
# Verity hybrid Phase 1 — the diff ledger under the hook path, dual-run.
# Hermetic sessions through the real engine (engine/cli.js hook) over scratch
# git repos: SessionStart records a base, a passing check records its tree
# hash, Stop appends `diffDecision` next to the authoritative event verdict.
# Covers: work the event ledger cannot see (git apply, heredoc, sed -i, a test
# removed by a non-rm command, a human edit mid-session), skip markers and
# their near-misses, secrets on added lines, the non-repo / over-cap /
# unwritable-home / diff-error fallbacks, live mode answering from the event
# verdict alone, replay, and the K2 disagreement recipe.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/engine/cli.js"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
export VERITY_ENGINE_HOME="$T/eh"

mkrepo() {  # $1 = dir: code, a test, an npm test script, a README; committed
  mkdir -p "$1" && (cd "$1" && git init -q && git config user.email t@t && git config user.name t && git config commit.gpgsign false
    mkdir -p src tests
    printf 'export const a = 1;\n' > src/a.ts
    printf 'import { a } from "../src/a";\nit("a", () => {});\n' > tests/a.test.ts
    printf '{"name":"fx","scripts":{"test":"bash ./run-tests.sh"}}\n' > package.json
    printf '#!/usr/bin/env bash\necho ok\n' > run-tests.sh
    echo '# fixture' > README.md
    git add -A && git commit -qm init)
}
# ev <sid> <cwd> <event-json-fragment> → the hook's answer
ev() { jq -nc --arg s "$1" --arg d "$2" --argjson e "$3" '$e + {session_id: $s, cwd: $d}' | node "$CLI" hook --agent claude; }
start() { ev "$1" "$2" '{"hook_event_name":"SessionStart","source":"startup"}'; }
bash_ev() { ev "$1" "$2" "$(jq -nc --arg c "$3" --argjson x "${4:-0}" '{hook_event_name:"PostToolUse",tool_name:"Bash",tool_input:{command:$c},tool_response:{stdout:"ok",exit_code:$x}}')"; }
write_ev() { ev "$1" "$2" "$(jq -nc --arg f "$2/$3" '{hook_event_name:"PostToolUse",tool_name:"Write",tool_input:{file_path:$f},tool_response:{}}')"; }
stop() { ev "$1" "$2" '{"hook_event_name":"Stop","last_assistant_message":"done"}'; }
ledger() { cat "$VERITY_ENGINE_HOME/sessions/claude-$1.jsonl"; }
lastv() { ledger "$1" | jq -s -c '[.[] | select(.type=="verdict" and .phase=="stop")] | last'; }
# pair <sid> → "event-decision diff-decision diff-reason"
pair() { lastv "$1" | jq -r '[.decision, (.diffDecision.decision // "none"), (.diffDecision.reason // "none")] | join(" ")'; }

# ------------------------------------------------ 1. patch-style edit the event ledger cannot see
R="$T/r1"; mkrepo "$R"
check "SessionStart still answers with the session note" "$(start p1 "$R" | jq -r .hookSpecificOutput.hookEventName)" "SessionStart"
check "base recorded outside the workspace" "$(jq -r '.state + ":" + (.baseTree|length|tostring)' "$VERITY_ENGINE_HOME/bases/claude-p1.json") $(git -C "$R" status --porcelain | wc -l | tr -d ' ')" "ok:40 0"
(cd "$R" && printf 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n' > ../p1.patch && git apply ../p1.patch)
bash_ev p1 "$R" "git apply ../p1.patch" >/dev/null
check "git apply: the hook still answers from the event verdict" "$(stop p1 "$R")" "{}"
check "git apply: event allows, the diff fails it (no passing check)" "$(pair p1)" "allow fail no_passing_check"
check "git apply: the diff names the changed file" "$(lastv p1 | jq -c .diffDecision.code)" '["src/a.ts"]'
bash_ev p1 "$R" "npm test" >/dev/null
check "a passing check records the tree hash it passed on" "$(ledger p1 | jq -s -r '[.[]|select(.fact.kind=="command" and .fact.verify)] | last | .fact.treeHash | length')" "40"
stop p1 "$R" >/dev/null
check "check on the current tree → the pair agrees" "$(pair p1)" "allow pass check_passed_on_tree"
check "diffDecision is provenance only (base, post, check tree hashes)" "$(lastv p1 | jq -r '.diffDecision | [(.baseTree|length), (.postTree|length), (.checkTree == .postTree)] | map(tostring) | join(" ")')" "40 40 true"

# ------------------------------------------------ 2. heredoc shell write, 3. in-place sed
R="$T/r2"; mkrepo "$R"; start h1 "$R" >/dev/null
(cd "$R" && cat > src/h.ts <<'EOF'
export const h = 1;
EOF
)
bash_ev h1 "$R" "cat > src/h.ts <<'EOF'
export const h = 1;
EOF" >/dev/null
stop h1 "$R" >/dev/null
check "heredoc write: event allows, the diff sees untracked src/h.ts" "$(pair h1) $(lastv h1 | jq -r '.diffDecision.code | join(",")')" "allow fail no_passing_check src/h.ts"
R="$T/r3"; mkrepo "$R"; start s1 "$R" >/dev/null
(cd "$R" && sed -i 's/1/3/' src/a.ts); bash_ev s1 "$R" "sed -i 's/1/3/' src/a.ts" >/dev/null
stop s1 "$R" >/dev/null
check "sed -i: event allows, the diff fails it" "$(pair s1) $(lastv s1 | jq -r '.diffDecision.code | join(",")')" "allow fail no_passing_check src/a.ts"

# ------------------------------------------------ 4. a human edit lands mid-session, after the agent's passing check
R="$T/r4"; mkrepo "$R"; start m1 "$R" >/dev/null
echo 'export const a = 5;' > "$R/src/a.ts"; write_ev m1 "$R" src/a.ts >/dev/null
bash_ev m1 "$R" "npm test" >/dev/null
echo 'export const human = 1;' > "$R/src/human.ts"     # no hook event: someone else's edit
check "human edit: the hook answer is the event verdict (allow)" "$(stop m1 "$R")" "{}"
check "human edit: presented as event allow / diff fail tree_moved_since_check" "$(pair m1)" "allow fail tree_moved_since_check"
check "human edit: the diff's change set holds both the agent's and the human's file" "$(lastv m1 | jq -r '.diffDecision.code | sort | join(",")')" "src/a.ts,src/human.ts"

# ------------------------------------------------ 5. non-repo session: today's event path exactly
P="$T/plain"; mkdir -p "$P"; start n1 "$P" >/dev/null
check "non-repo: base recorded plainly as unavailable" "$(jq -r '.state + " " + .reason' "$VERITY_ENGINE_HOME/bases/claude-n1.json")" "unavailable not_a_git_tree"
write_ev n1 "$P" a.ts >/dev/null; bash_ev n1 "$P" "npm test" 1 >/dev/null
OUT_N1="$(stop n1 "$P")"
# The same events in a session that never saw SessionStart (today's behaviour).
write_ev n0 "$P" a.ts >/dev/null; bash_ev n0 "$P" "npm test" 1 >/dev/null
check "non-repo: Stop answer identical to a session without a base" "$(jq -c 'del(.x)' <<<"$OUT_N1")" "$(stop n0 "$P" | jq -c 'del(.x)')"
check "non-repo: no diffDecision, no treeHash on facts" "$(ledger n1 | jq -s -c '[(map(select(.diffDecision)) | length), (map(select(.fact.treeHash)) | length), (map(select(.type=="verdict")) | last | .decision)]')" '[0,0,"block"]'

# ------------------------------------------------ 6. a test deletion visible only in the diff
R="$T/r6"; mkrepo "$R"; start d1 "$R" >/dev/null
CMD="python3 -c \"import os; os.remove('tests/a.test.ts')\""
check "the event path does not see a non-rm deletion (no pre deny)" "$(ev d1 "$R" "$(jq -nc --arg c "$CMD" '{hook_event_name:"PreToolUse",tool_name:"Bash",tool_input:{command:$c}}')")" "{}"
(cd "$R" && eval "$CMD"); bash_ev d1 "$R" "$CMD" >/dev/null; bash_ev d1 "$R" "npm test" >/dev/null
stop d1 "$R" >/dev/null
check "test deletion: event allows, the diff fails on test_deletion" "$(pair d1)" "allow fail test_deletion"
check "test deletion: finding carries rule and path" "$(lastv d1 | jq -c '[.diffDecision.findings[] | select(.rule=="test_deletion") | .path]')" '["tests/a.test.ts"]'

# ------------------------------------------------ 7. a skipped test added, 8. near-miss lines in a test file
R="$T/r7"; mkrepo "$R"; start k1 "$R" >/dev/null
printf 'it.skip("later", () => {});\n' >> "$R/tests/a.test.ts"; write_ev k1 "$R" tests/a.test.ts >/dev/null
bash_ev k1 "$R" "npm test" >/dev/null; stop k1 "$R" >/dev/null
check "skipped test: finding recorded with its label, advisory (pair agrees)" "$(lastv k1 | jq -r '[.diffDecision.findings[] | select(.rule=="test_skipped") | .path + ":" + .label + ":" + .severity] | join(",")') $(pair k1)" "tests/a.test.ts:js .skip(:info allow pass check_passed_on_tree"
R="$T/r8"; mkrepo "$R"; start k2 "$R" >/dev/null
cat >> "$R/tests/a.test.ts" <<'EOF'
// it.skip("commented out", () => {});
const label = "test.skip(";
submit.skip(1);
const xitCount = fixit(2);
EOF
write_ev k2 "$R" tests/a.test.ts >/dev/null; bash_ev k2 "$R" "npm test" >/dev/null; stop k2 "$R" >/dev/null
check "near-miss lines: no test_skipped finding" "$(lastv k2 | jq '[.diffDecision.findings[] | select(.rule=="test_skipped")] | length') $(pair k2)" "0 allow pass check_passed_on_tree"
# The same marker reaches the swarm verdict through the shared core.
R="$T/r9"; mkrepo "$R"; node "$CLI" snapshot --cwd "$R" --out "$T/r9.base.json" >/dev/null
printf 'func TestX(t *testing.T) {\n\tt.Skip("flaky")\n}\n' > "$R/tests/x_test.go"
SW="$(node "$CLI" verify --cwd "$R" --base "$T/r9.base.json" --check "bash ./run-tests.sh" --json)"
check "swarm verdict carries the same test_skipped finding (still passes)" "$(jq -r '[.decision, ([.findings[]|select(.rule=="test_skipped")][0] | .path + ":" + .label)] | join(" ")' <<<"$SW")" "pass tests/x_test.go:go t.Skip("

# ------------------------------------------------ secrets on added lines: label only, never the value
R="$T/r10"; mkrepo "$R"; start c1 "$R" >/dev/null
KEY="AKIA""QWERTYUIOPASDFGH"
printf 'export const k = "%s";\n' "$KEY" > "$R/src/k.ts"; bash_ev c1 "$R" "cat > src/k.ts" >/dev/null; bash_ev c1 "$R" "npm test" >/dev/null
stop c1 "$R" >/dev/null
check "secret: event allows, the diff fails on secret with its label" "$(pair c1) $(lastv c1 | jq -r '[.diffDecision.findings[]|select(.rule=="secret")][0].label')" "allow fail secret a AWS access key"
check "secret: the value is in no ledger or base record" "$(cat "$VERITY_ENGINE_HOME"/sessions/* "$VERITY_ENGINE_HOME"/bases/* | grep -c "$KEY")" "0"

# ------------------------------------------------ 9. snapshot failure at SessionStart: the session stays fully functional
R="$T/r11"; mkrepo "$R"
mkdir -p "$T/eh2"; echo x > "$T/eh2/bases"         # the base store cannot be written
VE="$T/eh2"
check "unwritable base store: SessionStart still answers" "$(VERITY_ENGINE_HOME="$VE" start f1 "$R" | jq -r .hookSpecificOutput.hookEventName)" "SessionStart"
echo 'export const a = 7;' > "$R/src/a.ts"
VERITY_ENGINE_HOME="$VE" write_ev f1 "$R" src/a.ts >/dev/null
check "unwritable base store: an unverified edit still blocks on the event path" "$(VERITY_ENGINE_HOME="$VE" stop f1 "$R" | jq -r .decision)" "block"
VERITY_ENGINE_HOME="$VE" bash_ev f1 "$R" "npm test" >/dev/null
check "unwritable base store: a passing check still allows, no diffDecision, no crash logged" "$(VERITY_ENGINE_HOME="$VE" stop f1 "$R") $(VERITY_ENGINE_HOME="$VE" ledger f1 | jq -s '[.[]|select(.diffDecision)]|length') $([ -f "$VE/errors.log" ] && echo crashed || echo clean)" "{} 0 clean"
R="$T/r12"; mkrepo "$R"; mkdir -p "$R/gen"; (cd "$R/gen" && seq 1 5001 | xargs touch)
start o1 "$R" >/dev/null
check "over the untracked-file cap: base unavailable with the reason, event path intact" "$(jq -r .reason "$VERITY_ENGINE_HOME/bases/claude-o1.json") $(write_ev o1 "$R" src/a.ts >/dev/null; stop o1 "$R" | jq -r .decision) $(pair o1)" "untracked_files_over_cap block block none none"

# ------------------------------------------------ diff computation error → unverifiable, Stop unbroken
R="$T/r13"; mkrepo "$R"; start e1 "$R" >/dev/null
jq -c '.baseTree = "0123456789012345678901234567890123456789"' "$VERITY_ENGINE_HOME/bases/claude-e1.json" > "$T/e1" && cp "$T/e1" "$VERITY_ENGINE_HOME/bases/claude-e1.json"
echo 'export const a = 9;' > "$R/src/a.ts"; write_ev e1 "$R" src/a.ts >/dev/null
check "diff error: the event block still answers" "$(stop e1 "$R" | jq -r .decision)" "block"
check "diff error: recorded unverifiable with its error class" "$(lastv e1 | jq -r '.diffDecision | .decision + " " + .reason + " " + .errorClass')" "unverifiable error Error"

# ------------------------------------------------ resume keeps the first base; replay; live mode
start p1 "$T/r1" >/dev/null
check "a resumed SessionStart keeps the session's first base" "$(jq -r .createdAt "$VERITY_ENGINE_HOME/bases/claude-p1.json" | wc -l | tr -d ' ') $(jq -r .baseTree "$VERITY_ENGINE_HOME/bases/claude-p1.json" | cut -c1-7)" "1 $(lastv p1 | jq -r .diffDecision.baseTree | cut -c1-7)"
check "replay reproduces every Stop verdict with diffDecision present" "$(node "$CLI" replay "$VERITY_ENGINE_HOME/sessions/claude-m1.jsonl")" "all Stop verdicts reproduced"
R="$T/r14"; mkrepo "$R"
export VERITY_ENGINE_CLI="$CLI" VERITY_HOME="$T/vh"
bash "$ROOT/scripts/verity.sh" mode live >/dev/null
hk() { jq -nc --arg s "$1" --arg d "$2" --argjson e "$3" '$e + {session_id: $s, cwd: $d}' | bash "$ROOT/scripts/verity-hook.sh" claude; }
hk l1 "$R" '{"hook_event_name":"SessionStart"}' >/dev/null
(cd "$R" && sed -i 's/1/4/' src/a.ts)
check "live mode: diff fail does not reach the harness (event allow answers)" "$(hk l1 "$R" '{"hook_event_name":"Stop"}') $(pair l1)" "{} allow fail no_passing_check"
echo 'export const b = 1;' > "$R/src/b.ts"; hk l1 "$R" "$(jq -nc --arg f "$R/src/b.ts" '{hook_event_name:"PostToolUse",tool_name:"Write",tool_input:{file_path:$f},tool_response:{}}')" >/dev/null
check "live mode: the event block is what the harness gets" "$(hk l1 "$R" '{"hook_event_name":"Stop"}' | jq -r .decision)" "block"
unset VERITY_ENGINE_CLI VERITY_HOME

# ------------------------------------------------ K2: the disagreement recipe over this run's verdict store
K2="$(bash "$ROOT/scripts/diff-disagreements.sh" "$VERITY_ENGINE_HOME")"
echo "K2 recipe over this run: $K2"
check "K2 recipe counts every diff-bearing Stop, unverifiable apart" "$(jq -r '[.stops, .unverifiable, .agree + .disagree + .unverifiable == .stops] | map(tostring) | join(" ")' <<<"$K2")" "$(cat "$VERITY_ENGINE_HOME"/sessions/*.jsonl | jq -s '[.[]|select(.type=="verdict" and .phase=="stop" and .diffDecision)]|length') 1 true"
check "K2 recipe: human edit counted as a disagreement pair" "$(jq -r '[.pairs[]|select(.reason=="tree_moved_since_check")][0] | .event + " " + .diff' <<<"$K2")" "allow fail"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
