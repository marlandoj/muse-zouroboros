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
check "bad verdict fails open" "$(FAKE_VERDICT='not json' hook claude "$STOP")" "{}"
$V reset >/dev/null
check "reset to shadow" "$(hook claude "$STOP")" "{}"
unset CANNY_CLI TYPESAFE_API_KEY VERITY_HOME

# Installer: wires all four harnesses, keeps existing hooks, and is idempotent.
mkdir -p "$T/home/.gemini" "$T/proj/.claude" "$T/canny/.git" "$T/canny/dist"
echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"keep-me"}]}]}}' > "$T/proj/.claude/settings.json"
touch "$T/canny/dist/cli.js"
git -C "$T/canny" init -q 2>/dev/null
inst() { HOME="$T/home" bash "$ROOT/scripts/install.sh" --project "$T/proj" --canny-dir "$T/canny" --backup-dir "$T/bk" >/dev/null 2>&1; }
inst; check "installer exit" "$?" "0"; inst
check "claude keeps existing hook" "$(jq -r '.hooks.Stop[0].hooks[0].command' "$T/proj/.claude/settings.json")" "keep-me"
check "claude wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/proj/.claude/settings.json")" "5"
check "codex wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/proj/.codex/hooks.json")" "4"
check "gemini wired once" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/home/.gemini/settings.json")" "4"
check "kimi wired once" "$(grep -c verity-hook "$T/home/.kimi-code/config.toml")" "5"
check "custom canny dir passed" "$(grep -c "CANNY_DIR=$T/canny" "$T/home/.kimi-code/config.toml")" "5"
mkdir -p "$T/old/.claude"; echo '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"bash /x/Skills/canny-shadow/scripts/canny-shadow-hook.sh claude"}]}]}}' > "$T/old/.claude/settings.json"
HOME="$T/home" bash "$ROOT/scripts/install.sh" --harness claude --project "$T/old" --canny-dir "$T/canny" --backup-dir "$T/bk" >/dev/null 2>&1
check "legacy entry migrated" "$(jq '[.hooks[][] | tostring | select(test("verity-hook"))] | length' "$T/old/.claude/settings.json")" "5"
check "no legacy left" "$(grep -c canny-shadow "$T/old/.claude/settings.json")" "0"
check "backup written" "$(ls "$T/bk" | grep -c proj_.claude_settings)" "1"

echo "$pass passed, $fail failed"
[ "$fail" = 0 ]
