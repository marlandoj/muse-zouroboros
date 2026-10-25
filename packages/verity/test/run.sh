#!/usr/bin/env bash
# Hermetic tests: adapter translation both ways, shadow and live modes, the mode CLI, and the installer.
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
pass=0; fail=0
check() { if [ "$2" = "$3" ]; then pass=$((pass+1)); else fail=$((fail+1)); echo "FAIL $1: expected [$3] got [$2]"; fi; }
adapt() { printf '%s' "$2" | node "$ROOT/scripts/adapter.mjs" "$1"; }

o=$(adapt kimi '{"hook_event_name":"PreToolUse","session_id":"s1","tool_name":"Write","tool_input":{"path":"/p/a.ts","content":"x"}}')
check "kimi path->file_path" "$(jq -r .tool_input.file_path <<<"$o")" "/p/a.ts"
check "kimi session prefix" "$(jq -r .session_id <<<"$o")" "kimi-s1"
o=$(adapt kimi '{"hook_event_name":"PostToolUseFailure","session_id":"s1","tool_name":"Bash","error":{"message":"Command exited with code 3"}}')
check "kimi exit code kept" "$(jq -r .error <<<"$o" | head -1)" "Exit code 3"
o=$(adapt gemini '{"hook_event_name":"BeforeTool","session_id":"g","tool_name":"replace","tool_input":{"file_path":"/p/b.ts","old_string":"a","new_string":"b"}}')
check "gemini BeforeTool->PreToolUse" "$(jq -r .hook_event_name <<<"$o")" "PreToolUse"
check "gemini replace->Edit" "$(jq -r .tool_name <<<"$o")" "Edit"
o=$(adapt gemini '{"hook_event_name":"AfterTool","session_id":"g","tool_name":"run_shell_command","tool_input":{"command":"npm test","dir_path":"/p"},"tool_response":{"llmContent":"Output: ok\nExit Code: 1"}}')
check "gemini exit code parsed" "$(jq -r .tool_response.exit_code <<<"$o")" "1"
check "gemini dir_path->cwd" "$(jq -r .cwd <<<"$o")" "/p"
o=$(adapt gemini '{"hook_event_name":"AfterAgent","session_id":"g","prompt_response":"Done."}')
check "gemini AfterAgent->Stop" "$(jq -r .hook_event_name,.last_assistant_message <<<"$o" | paste -sd' ')" "Stop Done."

# Shadow mode (default): a blocking verdict is logged but the hook still answers {}.
cat > "$T/cli.js" <<'JS'
if (process.env.TYPESAFE_API_KEY) { process.stdout.write('{"leak":true}'); process.exit(0); }
process.stdout.write(process.env.FAKE_VERDICT || '{"decision":"block","reason":"no passing check"}');
JS
export CANNY_CLI="$T/cli.js" VERITY_HOME="$T/v" TYPESAFE_API_KEY=should-not-pass
hook() { printf '%s' "$2" | bash "$ROOT/scripts/verity-hook.sh" "$1"; }
STOP='{"hook_event_name":"Stop","session_id":"x"}'
for h in claude codex kimi gemini; do check "$h shadow answers {}" "$(hook $h "$STOP")" "{}"; done
check "verdicts logged" "$(wc -l < "$T/v/verdicts.jsonl" | tr -d ' ')" "4"
check "jev key stripped" "$(jq -r .verdict.decision "$T/v/verdicts.jsonl" | sort -u)" "block"
check "shadow not applied" "$(jq -r .applied "$T/v/verdicts.jsonl" | sort -u)" "false"
check "kind classified" "$(jq -r .kind "$T/v/verdicts.jsonl" | sort -u)" "done"
check "kill switch answers {}" "$(printf 'not json' | VERITY_DISABLE=1 bash "$ROOT/scripts/verity-hook.sh")" "{}"

# Mode CLI.
V="bash $ROOT/scripts/verity.sh"
$V mode live >/dev/null
check "cli global live" "$(jq -r .mode "$T/v/config.json")" "live"
$V mode shadow --harness kimi >/dev/null
check "cli harness override" "$(jq -r .harness.kimi.mode "$T/v/config.json")" "shadow"
$V mode live --checks nope >/dev/null 2>&1; check "cli rejects unknown check" "$?" "2"

# Live mode: Claude and Codex get Canny's verdict verbatim; Kimi and Gemini get it translated.
check "claude live passes verdict" "$(hook claude "$STOP" | jq -r .decision)" "block"
check "codex live passes verdict" "$(hook codex "$STOP" | jq -r .decision)" "block"
check "kimi override stays shadow" "$(hook kimi "$STOP")" "{}"
$V reset --harness kimi >/dev/null
check "kimi live stop -> deny" "$(hook kimi "$STOP" | jq -r .hookSpecificOutput.permissionDecision)" "deny"
check "gemini live stop -> block" "$(hook gemini '{"hook_event_name":"AfterAgent","session_id":"g"}' | jq -r .decision,.reason | paste -sd' ')" "block no passing check"
DENY='{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"secret"}}'
check "gemini live deny" "$(FAKE_VERDICT=$DENY hook gemini '{"hook_event_name":"BeforeTool","tool_name":"write_file","tool_input":{}}' | jq -r .decision)" "deny"
check "kimi live deny" "$(FAKE_VERDICT=$DENY hook kimi '{"hook_event_name":"PreToolUse","tool_name":"Write"}' | jq -r .hookSpecificOutput.permissionDecisionReason)" "secret"
RW='{"hookSpecificOutput":{"hookEventName":"PreToolUse","updatedInput":{"command":"set -o pipefail; npm test | tail"},"additionalContext":"added pipefail"}}'
o=$(FAKE_VERDICT=$RW hook gemini '{"hook_event_name":"BeforeTool","tool_name":"run_shell_command","tool_input":{"command":"npm test | tail","dir_path":"/p"}}')
check "gemini rewrite keeps dir_path" "$(jq -r .hookSpecificOutput.tool_input.dir_path <<<"$o")" "/p"
check "gemini rewrite command" "$(jq -r .hookSpecificOutput.tool_input.command <<<"$o")" "set -o pipefail; npm test | tail"
check "kimi rewrite is advisory" "$(FAKE_VERDICT=$RW hook kimi '{"hook_event_name":"PreToolUse","tool_name":"Bash"}' | jq -r .message)" "added pipefail"
$V mode live --checks deny >/dev/null
check "check filter shadows other kinds" "$(hook claude "$STOP")" "{}"
check "check filter applies listed kind" "$(FAKE_VERDICT=$DENY hook claude '{"hook_event_name":"PreToolUse"}' | jq -r .hookSpecificOutput.permissionDecision)" "deny"
check "env overrides config" "$(VERITY_MODE=shadow FAKE_VERDICT=$DENY hook claude '{"hook_event_name":"PreToolUse"}')" "{}"
check "live applied logged" "$(jq -s 'map(select(.applied)) | length > 0' "$T/v/verdicts.jsonl")" "true"
check "bad verdict fails closed" "$(FAKE_VERDICT='not json' hook claude "$STOP" | jq -r .decision)" "block"
check "kimi bad verdict fails closed" "$(FAKE_VERDICT='not json' hook kimi "$STOP" | jq -r .hookSpecificOutput.permissionDecision)" "deny"
$V reset >/dev/null
check "reset to shadow" "$(hook claude "$STOP")" "{}"

# report.sh counts hook crashes from the engine's own errors.log (engine home), not ~/.canny.
mkdir -p "$T/rh/.verity/engine" "$T/rh/.canny" "$T/reh"
printf '2026-10-25T00:00:00.000Z boom\n' > "$T/rh/.verity/engine/errors.log"
printf 'legacy 1\nlegacy 2\nlegacy 3\n' > "$T/rh/.canny/errors.log"
check "report counts crashes in default engine home" "$(HOME="$T/rh" bash "$ROOT/scripts/report.sh" | tail -n 1)" "hook crashes: 1"
printf 'a\nb\n' > "$T/reh/errors.log"
check "report honours VERITY_ENGINE_HOME" "$(HOME="$T/rh" VERITY_ENGINE_HOME="$T/reh" bash "$ROOT/scripts/report.sh" | tail -n 1)" "hook crashes: 2"

# One mode resolver: engine/cli.js mode prints the hook's posture as JSON.
mkdir -p "$T/mo"; echo '{"mode":"shadow","harness":{"codex":{"mode":"live","checks":["deny"]}}}' > "$T/mo/config.json"
emode() { VERITY_HOME="$T/mo" node "$ROOT/engine/cli.js" mode "$@"; }
check "mode cli: per-harness override" "$(emode --harness codex | jq -c '[.mode, .checks, .source.mode, .override]')" '["live",["deny"],"harness",true]'
check "mode cli: global layer" "$(emode --harness kimi | jq -c '[.mode, .checks, .source.mode, .override, .global.mode]')" '["shadow",["all"],"global",false,"shadow"]'
check "mode cli: env beats config, configured keeps the file" "$(VERITY_MODE=live VERITY_CHECKS=done,ask emode --harness kimi | jq -c '[.mode, .checks, .source.mode, .configured.mode]')" '["live",["done","ask"],"env","shadow"]'
check "mode cli: VERITY_DISABLE is reported, not a mode" "$(VERITY_DISABLE=1 emode --harness codex | jq -c '[.mode, .disabled]')" '["live",true]'
# The hook's resolver path and its degraded fallback (engine tree absent) give one answer.
mkdir -p "$T/nofb/scripts"; cp "$ROOT/scripts/verity-hook.sh" "$ROOT/scripts/adapter.mjs" "$T/nofb/scripts/"
posture_of() {  # $1 = hook script, $2 = config text ('' = none), rest = env; prints mode/applied for a deny verdict
  local d; d="$(mktemp -d "$T/mp.XXXX")"; [ -n "$2" ] && printf '%s' "$2" > "$d/config.json"
  local s="$1"; shift 2
  env "$@" VERITY_HOME="$d" FAKE_VERDICT="$DENY" bash "$s" codex <<<'{"hook_event_name":"PreToolUse"}' >/dev/null
  jq -r '"\(.mode):\(.applied)"' "$d/verdicts.jsonl"
}
same=0; n=0
for c in '' '{"mode":"live"}' '{"mode":"shadow","harness":{"codex":{"mode":"live","checks":["deny"]}}}' \
         '{"mode":"live","checks":[]}' '{"mode":"live","checks":["done"]}' '{"harness":"bogus","mode":"live"}' 'not json' \
         '{"mode":false,"harness":{"codex":{"mode":null,"checks":["ask","deny"]}}}' '{"mode":"live","harness":{"codex":{"mode":"shadow"}}}'; do
  for e in X=1 VERITY_MODE=live VERITY_CHECKS=done; do
    n=$((n+1))
    a="$(posture_of "$ROOT/scripts/verity-hook.sh" "$c" "$e")"; b="$(posture_of "$T/nofb/scripts/verity-hook.sh" "$c" "$e")"
    if [ "$a" = "$b" ]; then same=$((same+1)); else echo "  resolver/fallback differ for [$c] $e: $a vs $b"; fi
  done
done
check "hook resolver and fallback agree on every config x env case" "$same/$n" "$n/$n"
mkdir -p "$T/mlive"; echo '{"mode":"live"}' > "$T/mlive/config.json"
check "engine tree absent in live still fails closed" "$(env -u CANNY_CLI VERITY_HOME="$T/mlive" bash "$T/nofb/scripts/verity-hook.sh" claude <<<"$STOP" | jq -r .decision)" "block"
check "status reads the resolver, overrides marked" "$(VERITY_HOME="$T/mo" $V status | paste -sd'|')" "global: shadow (checks: all)|  claude: shadow (checks: all)|  codex: live (checks: deny)  [override]|  kimi: shadow (checks: all)|  gemini: shadow (checks: all)"
mkdir -p "$T/mbad"; echo 'not json' > "$T/mbad/config.json"
check "status survives an invalid config and says how the hook reads it" "$(VERITY_HOME="$T/mbad" $V status | sed -n 2p)" "config: $T/mbad/config.json is invalid; the hook reads it as shadow (checks: all)"
unset CANNY_CLI TYPESAFE_API_KEY VERITY_HOME

# Installer: wires all four harnesses, keeps existing hooks, and is idempotent.
mkdir -p "$T/home/.gemini" "$T/proj/.claude"
echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}' > "$T/proj/.claude/settings.json"
inst() { HOME="$T/home" bash "$ROOT/scripts/install.sh" --project "$T/proj" --backup-dir "$T/bk" >/dev/null 2>&1; }
inst; check "installer exit" "$?" "0"; inst
check "claude keeps existing hook" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$T/proj/.claude/settings.json")" "keep-me"
check "claude wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/proj/.claude/settings.json")" "5"
check "codex wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/proj/.codex/hooks.json")" "4"
check "gemini wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/home/.gemini/settings.json")" "4"
check "kimi wired once" "$(grep -c verity-hook "$T/home/.kimi-code/config.toml")" "5"
mkdir -p "$T/old/.claude"; echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bash /x/Skills/canny-shadow/scripts/canny-shadow-hook.sh claude"}]}]}}' > "$T/old/.claude/settings.json"
HOME="$T/home" bash "$ROOT/scripts/install.sh" --harness claude --project "$T/old" --backup-dir "$T/bk" >/dev/null 2>&1
check "legacy entry migrated" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/old/.claude/settings.json")" "5"
check "no legacy left" "$(grep -c canny-shadow "$T/old/.claude/settings.json")" "0"
check "backup written" "$(ls "$T/bk" | grep -c proj_.claude_settings)" "1"

# Real engine (not the fake CLI): end-to-end verdicts through verity-hook.sh.
# Hermetic: temp engine home, live mode, session ids unique to this run.
export VERITY_ENGINE_CLI="$ROOT/engine/cli.js" VERITY_ENGINE_HOME="$T/eh" VERITY_HOME="$T/v2"
unset CANNY_CLI
bash "$ROOT/scripts/verity.sh" mode live >/dev/null
ehook() { printf '%s' "$2" | bash "$ROOT/scripts/verity-hook.sh" "$1"; }
SID="eng-$RANDOM"
W='{"hook_event_name":"PostToolUse","session_id":"'$SID'","cwd":"/p","tool_name":"Write","tool_input":{"file_path":"/p/a.ts"},"tool_response":{"stdout":"","exit_code":0}}'
S='{"hook_event_name":"Stop","session_id":"'$SID'","cwd":"/p","last_assistant_message":"done"}'
ehook claude "$W" >/dev/null
check "engine stop after edit blocks" "$(ehook claude "$S" | jq -r .decision)" "block"
check "engine block names file" "$(ehook claude "$S" | jq -r .reason | grep -c 'a.ts changed')" "1"
SID2="eng2-$RANDOM"
W2='{"hook_event_name":"PostToolUse","session_id":"'$SID2'","cwd":"/p","tool_name":"Write","tool_input":{"file_path":"/p/a.ts"},"tool_response":{"stdout":"","exit_code":0}}'
T2='{"hook_event_name":"PostToolUse","session_id":"'$SID2'","cwd":"/p","tool_name":"Bash","tool_input":{"command":"npm test"},"tool_response":{"stdout":"ok","exit_code":0}}'
S2='{"hook_event_name":"Stop","session_id":"'$SID2'","cwd":"/p","last_assistant_message":"done"}'
ehook claude "$W2" >/dev/null; ehook claude "$T2" >/dev/null
check "engine stop after passing check allows" "$(ehook claude "$S2")" "{}"
# Unmarked value (AWS's documented AKIAIOSFODNN7EXAMPLE carries the
# `example` seed marker and is allowed since the 2026-10-25 seed fix).
SECRET='{"hook_event_name":"PreToolUse","session_id":"'$SID2'","cwd":"/p","tool_name":"Write","tool_input":{"file_path":"/p/k.ts","content":"x = AKIA''ABCDEFGHIJKLMNOP"}}'
check "engine secret denied" "$(ehook claude "$SECRET" | jq -r .hookSpecificOutput.permissionDecision)" "deny"
NOTE='{"hook_event_name":"SessionStart","session_id":"'$SID2'","cwd":"/p"}'
check "engine session note" "$(ehook claude "$NOTE" | jq -r .hookSpecificOutput.hookEventName)" "SessionStart"
check "engine ledger written" "$(ls "$T/eh/sessions" | wc -l | tr -d ' ')" "2"

# 2026-10-25 FP fix 1: headless Godot test-runner runs count as checks.
isv() { node --input-type=module -e 'import { isVerify } from "'"$ROOT"'/engine/checks.js"; process.stdout.write(String(isVerify(process.argv[1], JSON.parse(process.argv[2]))));' "$1" "${2:-[]}"; }
GD="/home/u/.local/share/godot/bin/godot --headless --path /g/proj"
check "godot test runner counts" "$(isv "$GD -s res://tests/run_tests.gd")" "true"
check "godot --script= form counts" "$(isv "$GD --script=res://tests/run_tests.gd")" "true"
check "godot check script counts" "$(isv "$GD -s res://tools/check_scenes.gd")" "true"
check "godot game script not a check" "$(isv "$GD -s res://scripts/main.gd")" "false"
check "godot non-headless not a check" "$(isv "godot --path /g/proj -s res://tests/run_tests.gd")" "false"
check "godot piped into tail masked" "$(isv "$GD -s res://tests/run_tests.gd | tail -20")" "false"
check "godot || true masked" "$(isv "$GD -s res://tests/run_tests.gd || true")" "false"
check "godot ; echo masked" "$(isv "$GD -s res://tests/run_tests.gd; echo ok")" "false"
check "godot pipefail counts" "$(isv "set -o pipefail && $GD -s res://tests/run_tests.gd | tail -20")" "true"
check "trusted prefix still counts" "$(isv "mycheck --all" '["mycheck"]')" "true"
check "trusted prefix piped still masked" "$(isv "mycheck | tail" '["mycheck"]')" "false"
gd_session() { # $1 = command, $2 = exit code -> Stop verdict decision (or "allow")
  local sid="gd-$RANDOM-$RANDOM"
  ehook codex "$(jq -nc --arg s "$sid" '{hook_event_name:"PostToolUse",session_id:$s,cwd:"/g/proj",tool_name:"Write",tool_input:{file_path:"/g/proj/scripts/player.gd"},tool_response:{stdout:"",exit_code:0}}')" >/dev/null
  ehook codex "$(jq -nc --arg s "$sid" --arg c "$1" --argjson e "$2" '{hook_event_name:"PostToolUse",session_id:$s,cwd:"/g/proj",tool_name:"Bash",tool_input:{command:$c},tool_response:{stdout:"All tests passed",exit_code:$e}}')" >/dev/null
  local out; out="$(ehook codex "$(jq -nc --arg s "$sid" '{hook_event_name:"Stop",session_id:$s,cwd:"/g/proj",last_assistant_message:"done"}')")"
  [ "$out" = "{}" ] && echo allow || jq -r .decision <<<"$out"
}
check "e2e godot test runner allows stop" "$(gd_session "$GD -s res://tests/run_tests.gd" 0)" "allow"
check "e2e godot failing runner blocks" "$(gd_session "$GD -s res://tests/run_tests.gd" 1)" "block"
check "e2e godot game script blocks" "$(gd_session "$GD -s res://scripts/main.gd" 0)" "block"
check "e2e godot | tail blocks" "$(gd_session "$GD -s res://tests/run_tests.gd | tail -5" 0)" "block"
mkdir -p "$T/tp"; printf '%s' '{"verify":["mycheck"]}' > "$T/tp/.verity.json"
(cd "$T/tp" && node "$ROOT/engine/cli.js" trust >/dev/null 2>&1)
TS="tp-$RANDOM"
ehook claude "$(jq -nc --arg s "$TS" --arg d "$T/tp" '{hook_event_name:"PostToolUse",session_id:$s,cwd:$d,tool_name:"Write",tool_input:{file_path:($d+"/a.ts")},tool_response:{stdout:"",exit_code:0}}')" >/dev/null
ehook claude "$(jq -nc --arg s "$TS" --arg d "$T/tp" '{hook_event_name:"PostToolUse",session_id:$s,cwd:$d,tool_name:"Bash",tool_input:{command:"mycheck --all"},tool_response:{stdout:"ok",exit_code:0}}')" >/dev/null
check "e2e trusted verifyPatterns still allows" "$(ehook claude "$(jq -nc --arg s "$TS" --arg d "$T/tp" '{hook_event_name:"Stop",session_id:$s,cwd:$d,last_assistant_message:"done"}')")" "{}"

# 2026-10-25 FP fix 2: seeded fixture values (fake markers inside the value)
# are not denied. Credential shapes are built by concatenation; every
# unmarked one is an obviously synthetic alphabet run.
ds() { node --input-type=module -e 'import { detectSecret } from "'"$ROOT"'/engine/checks.js"; const r = detectSecret(process.argv[1], process.argv[2], "/p"); process.stdout.write(r === null ? "allow" : r);' "$1" "$2"; }
SEED_AWS="AKIA""FAKESEED00000000"; SEED_GH="ghp_""FAKEfakeseed""000000000000000000000000"
SEED_SK="sk-ant-""FAKE-fakeseed-0000000000"; SEED_SL="xoxb-""fake-seed-000000000000"
SEED_CRED='token = "fakeseed0123456789abcdef"'
REAL_AWS="AKIA""ABCDEFGHIJKLMNOP"; REAL_GH="ghp_""Abcdefghijklmnopqrstuvwxyz0123456789"
REAL_SK="sk-ant-""Q1w2E3r4Y5u6I7o8P9a0"; REAL_SL="xoxb-""1234567890-abcdefghij"
REAL_CRED="token = \"Zq9Xw8""Vu7Ny6Rq5Pn4\""
SEEDED="# sanitizer fixture: every value below is seeded fake data
aws = $SEED_AWS
gh = $SEED_GH
ai = $SEED_SK
slack = $SEED_SL
$SEED_CRED"
UNMARKED="aws = $REAL_AWS
gh = $REAL_GH
ai = $REAL_SK
slack = $REAL_SL
$REAL_CRED"
check "seeded fixture allowed" "$(ds /p/mi/scratch/sanitizer_fixture.py "$SEEDED")" "allow"
check "seed marker past AKIA span allowed" "$(ds /p/a.py "k = AKIA""0000000000000000_FAKE")" "allow"
check "seeded REDACTED/example/test markers allowed" "$(ds /p/a.py "a = sk-ant-""REDACTED0000000000 b = ghp_""example""00000000000000000000000000000 c = AKIA""TEST000000000000")" "allow"
check "unmarked shapes denied with all labels" "$(ds /p/mi/scratch/sanitizer_fixture.py "$UNMARKED")" "Verity: mi/scratch/sanitizer_fixture.py would contain what looks like a AWS access key and a GitHub token and a OpenAI or Anthropic key and a Slack token and a hardcoded credential. Read the value from the environment or a git-ignored env file instead of writing it into the file."
check "mixed seeded + unmarked denied" "$(ds /p/a.py "$SEEDED
other = $REAL_GH" | grep -c 'a GitHub token')" "1"
check "mixed same pattern denied" "$(ds /p/a.py "a = $SEED_AWS b = $REAL_AWS" | grep -c '^Verity:')" "1"
check "mixed hardcoded credential denied" "$(ds /p/a.py "$SEED_CRED
$REAL_CRED" | grep -c 'a hardcoded credential')" "1"
check "seeded value in env file still denied" "$(ds /p/.env "AWS_KEY=$SEED_AWS" | grep -c 'An env file is only the place')" "1"
check "file name is not a marker" "$(ds /p/fake_test_fixture.py "k = $REAL_AWS" | grep -c '^Verity:')" "1"
check "private key header never seeded" "$(ds /p/fake.pem "-----BEGIN RSA PRIVATE KEY-----
FAKE" | grep -c 'a private key')" "1"
check "e2e seeded fixture write not denied" "$(ehook claude "$(jq -nc --arg c "$SEEDED" '{hook_event_name:"PreToolUse",session_id:"seed-e2e",cwd:"/p",tool_name:"Write",tool_input:{file_path:"/p/mi/scratch/sanitizer_fixture.py",content:$c}}')" | jq -r '.hookSpecificOutput.permissionDecision // "none"')" "none"
check "e2e mixed fixture write denied" "$(ehook claude "$(jq -nc --arg c "$SEEDED
k = $REAL_AWS" '{hook_event_name:"PreToolUse",session_id:"seed-e2e",cwd:"/p",tool_name:"Write",tool_input:{file_path:"/p/mi/scratch/sanitizer_fixture.py",content:$c}}')" | jq -r .hookSpecificOutput.permissionDecision)" "deny"

# Phase 0 item 1: one corpus through both the hook scan (detectSecret) and the
# diff scan (findSecrets); each prints its sorted, de-duplicated label set.
both() { node --input-type=module -e 'import { detectSecret, findSecrets } from "'"$ROOT"'/engine/checks.js";
const t = process.argv[1];
const d = detectSecret("/p/a.py", t, "/p");
const dl = d === null ? [] : d.replace(/^Verity: .*? would contain what looks like /, "").replace(/\. Read the value[\s\S]*$/, "").split(" and ");
const fl = [...new Set(findSecrets(t).map((s) => s.label))];
process.stdout.write(JSON.stringify(dl.sort()) + " " + JSON.stringify(fl.sort()));' "$1"; }
ALL5='["a AWS access key","a GitHub token","a OpenAI or Anthropic key","a Slack token","a hardcoded credential"]'
check "parity seeded-only: no findings from either" "$(both "$SEEDED")" "[] []"
check "parity mixed same pattern: unmarked finding from both" "$(both "a = $SEED_AWS b = $REAL_AWS")" '["a AWS access key"] ["a AWS access key"]'
check "parity mixed credential: unmarked finding from both" "$(both "$SEED_CRED
$REAL_CRED")" '["a hardcoded credential"] ["a hardcoded credential"]'
check "parity unmarked: unchanged, all labels from both" "$(both "$UNMARKED")" "$ALL5 $ALL5"
unset VERITY_ENGINE_CLI VERITY_ENGINE_HOME VERITY_HOME

# Hybrid Phase 1, unit level: the skip-marker set, the shared diff-rule core,
# the done rule, and the hook-side base record. End to end: test/hook-diff.sh.
skips() { node --input-type=module -e 'import { findSkipMarkers } from "'"$ROOT"'/engine/checks.js"; process.stdout.write(JSON.parse(process.argv[1]).map((l) => (findSkipMarkers([l])[0] || { label: "-" }).label).join("|"));' "$1"; }
check "skip markers: the pinned JS set" "$(skips '["it.skip(\"a\", () => {})","  test.skip(\"b\")","describe.skip(\"c\", fn)","xit(\"d\", fn)","xdescribe(\"e\", fn)","  this.skip();"]')" "js .skip(|js .skip(|js .skip(|js x-prefixed test|js x-prefixed test|mocha this.skip()"
check "skip markers: the pinned Python set" "$(skips '["@pytest.mark.skip","@pytest.mark.skipif(sys.platform == \"win32\", reason=\"x\")","    pytest.skip(\"later\")","@unittest.skip(\"x\")","@unittest.skipIf(True, \"x\")","        self.skipTest(\"x\")"]')" "pytest.mark.skip|pytest.mark.skip|pytest.skip(|unittest.skip|unittest.skip|unittest skipTest("
check "skip markers: the pinned Go set" "$(skips '["\tt.Skip(\"flaky\")","\tt.Skipf(\"%s\", x)","\tb.SkipNow()"]')" "go t.Skip(|go t.Skip(|go t.Skip("
check "skip near-misses: comments do not fire" "$(skips '["// it.skip(\"a\")","# pytest.skip(\"x\")","x = 1  # @pytest.mark.skip","/* xit(\"a\") */"," * t.Skip(\"x\")","foo(); // test.skip(1)"]')" "-|-|-|-|-|-"
check "skip near-misses: strings do not fire" "$(skips '["log(\"it.skip(\")","msg = '"'"'pytest.skip(x)'"'"'","s := `t.Skip(`"]')" "-|-|-"
check "skip near-misses: identifiers containing the marker do not fire" "$(skips '["submit.skip(1)","fixit(\"a\")","mytest.skip()","it.skipped = true","t.Skipper()","self.skipTests(1)","pytest.skipper(1)","@pytest.mark.skipped","const xitCount = 1"]')" "-|-|-|-|-|-|-|-|-"
dr() { node --input-type=module -e 'import { diffRules, blockingFindings, decideDone } from "'"$ROOT"'/engine/swarm.js"; const a = JSON.parse(process.argv[1]);
const r = diffRules({ abs: "/nonexistent", entries: a.entries, added: new Map(Object.entries(a.added || {})), command: null });
process.stdout.write(JSON.stringify({ rules: r.findings.map((f) => f.rule + ":" + f.path + (f.severity ? ":" + f.severity : "")), code: r.code, blocking: blockingFindings(r.findings).length }));' "$1"; }
check "diffRules: D and R test entries are test_deletion, code counted" "$(dr '{"entries":[{"status":"D","path":"tests/a.test.ts"},{"status":"R","from":"src/x_test.go","path":"src/x.go"},{"status":"M","path":"README.md"}]}' | jq -c '[.rules, .code, .blocking]')" '[["test_deletion:tests/a.test.ts","test_deletion:src/x_test.go"],["tests/a.test.ts","src/x.go"],2]'
check "diffRules: a skip marker in a test file is advisory, never blocking" "$(dr '{"entries":[{"status":"M","path":"tests/a.test.ts"}],"added":{"tests/a.test.ts":["it.skip(\"x\", f)"],"src/a.ts":["it.skip(\"x\", f)"]}}' | jq -c '[.rules, .blocking]')" '[["test_skipped:tests/a.test.ts:info"],0]'
check "diffRules: a secret on an added line blocks" "$(dr '{"entries":[{"status":"M","path":"src/k.ts"}],"added":{"src/k.ts":["k = AKIA''ABCDEFGHIJKLMNOP"]}}' | jq -c '[.rules, .blocking]')" '[["secret:src/k.ts"],1]'
dd() { node --input-type=module -e 'import { decideDone } from "'"$ROOT"'/engine/swarm.js"; const a = JSON.parse(process.argv[1]); const d = decideDone(a); process.stdout.write(d.decision + (d.hollowPass ? ":hollow" : ""));' "$1"; }
check "decideDone: pass, failing exit, hollow, no check" "$(dd '{"code":["a.ts"],"command":"npm test","exitCode":0,"testFiles":true}') $(dd '{"code":["a.ts"],"command":"npm test","exitCode":1}') $(dd '{"code":["a.ts"],"command":"npm test","exitCode":0,"testFiles":false}') $(dd '{"code":["a.ts"],"command":null}')" "allow block block:hollow block"
hb() { node --input-type=module -e 'import { recordSessionBase, treeHashFor, baseFile } from "'"$ROOT"'/engine/hookdiff.js"; const [h, c] = process.argv.slice(1); const r = recordSessionBase(h, "claude", "s/1", c);
process.stdout.write([String(r && r.state), String(r && r.reason), String(treeHashFor(h, "claude", "s/1")), baseFile(h, "claude", "s/1").slice(h.length)].join(" "));' "$1" "$2"; }
mkdir -p "$T/plain"
check "hook base: a non-repo cwd is recorded unavailable, no tree hash, named like the ledger" "$(hb "$T/hb" "$T/plain")" "unavailable not_a_git_tree undefined /bases/claude-s_1.json"
echo x > "$T/hb2"
check "hook base: an unwritable Verity home never throws" "$(hb "$T/hb2" "$T/plain")" "null null undefined /bases/claude-s_1.json"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
