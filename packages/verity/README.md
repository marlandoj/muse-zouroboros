# Verity

**No done without proof. One done-gate for every coding agent.**

![Verity workflow](assets/verity-workflow.png)

Coding agents say "done" before anything has been run. Verity stops that across four harnesses at once: Claude Code, Codex CLI, Kimi Code and Gemini CLI. Every edit and every check the agent runs is recorded. When the agent tries to finish after changing code with no passing test, build, lint or type-check since, Verity can refuse the finish and tell the agent what's missing. It also catches secrets written into files, deleted or skipped tests, and piped test commands (`npm test | tail`) that hide a failure.

It installs in **shadow mode**: every verdict is logged and nothing is blocked. One command switches it to **live**, for all harnesses or one, and for all checks or only the ones you trust.

## How it works

1. **Your agent** fires a hook on session start, before and after each edit or shell command, and when it tries to finish.
2. **The Verity hook** (`scripts/verity-hook.sh <harness>`) receives the event. Kimi and Gemini events are translated into the engine's shape by `scripts/adapter.mjs`. Claude Code and Codex are native.
3. **The Verity engine** (`engine/`) updates its ledger and returns a verdict: allow, refuse the finish, deny or ask about a tool call, rewrite a command, or add a note.
4. **Verity** logs the verdict, then:
   - in **shadow**, answers `{}` so the agent is unaffected;
   - in **live**, returns the verdict in the harness's own format (translated back for Kimi and Gemini);
   - in **live**, if the analyzer can't answer (missing, crashed, timed out, malformed output), refuses the finish or the tool call instead of silently passing — a dead gate fails closed, and the outage is logged.

The Verity engine runs with no model in both modes: the API key is stripped and the endpoint points at a dead port, so no text leaves the host. If anything fails (analyzer missing, a timeout, malformed output), Verity fails closed in live mode — it refuses the finish or the tool call rather than silently passing — and answers `{}` in shadow mode, where the gate only observes.

| Harness | Config written | Scope | Translation |
|---|---|---|---|
| Claude Code | `<project>/.claude/settings.json` | that project | native |
| Codex CLI | `<project>/.codex/hooks.json` | that project | native. Codex runs a new hook only after you approve it once with `/hooks` in an interactive session |
| Kimi Code | `~/.kimi-code/config.toml` | every Kimi session | `adapter.mjs kimi` / `--out kimi` |
| Gemini CLI | `~/.gemini/settings.json` | every Gemini session | `adapter.mjs gemini` / `--out gemini` |

OpenCode, Pi and Hermes are not supported: none has a hook that can refuse a finish.

## Install

Requires Node 22+, `jq`, `git` and bash. The Verity engine has no dependencies.

```bash
bash scripts/install.sh --project /path/to/project                 # all four harnesses, shadow mode
bash scripts/install.sh --harness claude,gemini --project .         # a subset
bash scripts/install.sh --dry-run                                   # preview the changes
```

The installer backs up every config file to `~/.verity/backups/` first, and adds one hook group per event. Existing hooks are kept, re-running changes nothing, and entries from the earlier `canny-shadow` name are repointed.

## Shadow and live

```bash
bash scripts/verity.sh status                                   # mode and checks, per harness
bash scripts/verity.sh mode live                                # enforce everything, everywhere
bash scripts/verity.sh mode live --harness claude               # enforce in Claude Code only
bash scripts/verity.sh mode live --checks deny                  # enforce only secret/test-deletion denies
bash scripts/verity.sh mode live --harness gemini --checks done,deny
bash scripts/verity.sh mode shadow                              # back to logging only
bash scripts/verity.sh reset [--harness kimi]                   # clear overrides
```

The setting is stored in `~/.verity/config.json` and read on every hook call, so a switch takes effect on the agent's next action without restarting anything. Precedence: `VERITY_MODE` / `VERITY_CHECKS` environment variables, then the per-harness setting, then the global setting, then shadow. `VERITY_DISABLE=1` turns Verity off in one process.

One resolver answers for every consumer: `node engine/cli.js mode --harness NAME` prints the posture the hook applies as JSON (`mode`, `checks`, `disabled`, the `source` of each, the file-only `configured` and `global` layers, `override`, the env overrides, and the config path and state). `verity-hook.sh`, `verity.sh status` and the orchestrator's gates report all read it; the hook falls back to reading the same keys directly only when the resolver cannot run, so a live gate still fails closed.

| Check | Verity verdict | Claude Code / Codex | Kimi Code | Gemini CLI |
|---|---|---|---|---|
| `done` | refuse the finish | block the stop; the agent continues | deny; reason sent back once | `AfterAgent` block; the agent continues |
| `deny` | block a tool call | deny | deny | deny |
| `ask` | confirm a tool call | ask (Claude), deny (Codex) | deny (no ask support) | ask |
| `rewrite` | add `pipefail` | rewritten command | message only (no rewrite support) | rewritten `tool_input` |
| `note` | context for the agent | `additionalContext` | message | `additionalContext` |
| `warn` | warning | `systemMessage` | message | `systemMessage` |

## Report

```bash
bash scripts/report.sh     # verdicts by harness and check, how many were applied, latency, crashes
```

| Path | Holds |
|---|---|
| `~/.verity/engine/sessions/*.jsonl` | Verity's ledger: command lines, exit codes, edited paths. Command lines can contain secrets, so the directory is owner-only |
| `~/.verity/verdicts.jsonl` | Every non-empty verdict, with harness, mode, check, whether it was applied, and latency |
| `~/.verity/config.json` | The shadow/live setting |
| `~/.verity/engine/errors.log` | Engine crashes |

Environment overrides: `CANNY_DIR`, `CANNY_CLI`, `CANNY_HOME`, `VERITY_HOME`, `VERITY_LOG`.

**Rollback:** `verity.sh mode shadow` stops enforcement immediately. To remove the hooks, copy each backup from `~/.verity/backups/` over its config file.

## Going live safely

1. Run in shadow for a week or two and read `report.sh`.
2. Check every would-be `done` block against the session. It's a false positive when the work was verified by something Verity doesn't count, such as `bun some.test.ts` or a curl smoke test. Add those as `verify` patterns in a trusted `.verity.json` before enforcing.
3. Every `deny` should be a real secret or a real test deletion. Enforce that check first: `verity.sh mode live --checks deny`.
4. Keep median latency under 250 ms per tool call, with no crashes.
5. Add `done` once its false positives are handled.

**Release valve (fail closed by default).** A repeated stop with no new tool
calls after a block stays blocked. The old "stop twice to walk through"
degrade now requires an explicit opt-in: `"releaseValve": true` in the
project's trusted `.verity.json` (bound with `verity trust`). Every trip is
audited as `"valve": true` on the ledger's stop verdict. Opt in only where a
genuine "no check applies" flow exists.

**Semantic anchor.** A test-runner-shaped pass (`npm test`, `pytest`,
`go test`, …) in a repo with no test files does not count as verification —
the `"test": "echo ok"` bypass. The gate blocks and says why. Build, lint,
and typecheck passes are unaffected. The check is skipped when the tree
can't be scanned; every withheld pass is audited as `"hollowPass": true`.

**Engine test runners.** A headless Godot run of a project's own test runner counts as a check with no project config: the binary must run with `--headless` and a `-s` / `--script` path under a `tests` directory or with `test` or `check` in the script's name (the usual shape is `res://tests/run_tests.gd`). Running a game or scene script never counts, and the masking rules still apply — a piped run, or one whose reported exit status is not the runner's own, does not count.

**Seeded test data.** The secret scan judges values, not files: when every credential-shaped value in a file carries an explicit fake-data marker inside the value itself — `fake`, `seed`, `example`, `dummy`, `placeholder`, `sample`, `test` or `redacted`, alone or compounded (as in `fakeseed`) — the write is treated as test data and is not denied. One unmarked value denies the write as usual. Env files are judged exactly as before; the marker rule does not apply to them.

**Known limitation: no coverage linkage.** Verity verifies that a check
passed after the last edit; it does not verify the check exercised the
edited code. A full-suite run is assumed to cover the tree. The ledger
records edited files alongside the files named in each passing command
(the `code` arrays), so the linkage is answerable on review — but the gate
itself does not enforce it. Coverage-gated checks remain a project-config
decision, not a heuristic the gate will guess at.

## Adapters

Kimi and Gemini input shapes were captured from live sessions (Kimi Code 0.41.0, Gemini CLI 0.58.0). Their output formats were read from the same installed versions.

- **Kimi** uses Claude-style event and tool names but calls the file argument `path`, returns `tool_output` as a string, and reports failures as a structured `error` whose message carries the exit code. It blocks only on `permissionDecision: "deny"` or exit code 2, and feeds a Stop block back to the model once.
- **Gemini** uses `BeforeTool`/`AfterTool`/`AfterAgent`, tools named `write_file`, `replace` and `run_shell_command`, and reports a command's exit code as `Exit Code: N` inside `llmContent`. It reads a top-level `decision` and `reason`, and rewrites through `hookSpecificOutput.tool_input`.

Kimi and Gemini ledgers are named `claude-kimi-<id>` / `claude-gemini-<id>` because the engine parses them as Claude events.

## Swarm gate (orchestrator-run)

The hooks above gate an interactive session from inside the harness. The swarm
(`packages/zo-swarm-orchestrator/scripts/orchestrate-v5.ts`) cannot rely on
them: executors run as detached bridges, three harnesses have no hook at all,
and an agent's own report of "tests pass" is not evidence. So the orchestrator
runs Verity itself, in two phases, with the workspace diff as the ledger:

```bash
node engine/cli.js snapshot --cwd <workspace> --out <base.json> [--max-depth 3] [--exclude <abs-path>]...
node engine/cli.js verify   --cwd <workspace> --base <base.json> --json
                            [--check <cmd>] [--check-source task|policy|verity-json-base] [--waived]
                            [--check-cwd <rel>] [--check-timeout <s, default 900>] [--check-log <file>]
                            [--policy <operator-policy.json>] [--require-check]
                            [--allow-test-deletion] [--allow-secrets] [--allow-check-edits]
                            [--ignore <glob>]... [--exclude <abs-path>]...
```

- **snapshot** records, for every git repo in the workspace (depth ≤ 3,
  `node_modules` skipped), the tree of its *current working state* written
  through a temporary index copy (tracked, staged, unstaged and untracked
  files; `.gitignore` and `info/exclude` honoured; the real index is never
  touched), plus a sha256 of `info/exclude`. A workspace root that is not a
  repo gets a path/size/sha256 manifest of its loose files (`run.log`,
  `TASK.md`, `.verity/` and the orchestrator's own output files excluded).
  The base record lives *outside* the workspace; the orchestrator keeps its
  hash in memory and treats a mismatch as an error.
- **verify** builds the post tree the same way and diffs base → post
  (`git diff -M --name-status` plus `--unified=0` for added lines). A repo
  that appeared during the run (the factory `./repo` clone) is judged against
  its upstream merge-base, else the remote default branch, else the empty
  tree. Loose files are scanned for secrets only — never counted as code.
- **Rules** reuse the engine's primitives: code change = `isCodeFile` minus
  ignore globs (lockfiles by default, plus policy / base `.verity.json`
  `ignore`); test deletion = status `D`, or `R` away from a test path, on
  `looksLikeTestFile`; secrets = `findSecrets` over added lines (every
  match); `check_definition_changed` when the diff touches the check's own
  definition (`package.json` script, Makefile when the command uses make,
  jest/vitest/pytest config, `.verity.json`); "no passing check" via
  `decideStop` with the orchestrator-run check's real exit code (so a passing
  test runner in a repo with no test files is still a hollow pass).
- **The trusted check** is resolved highest-source-first: the task's
  dispatcher-written `verify` (`--check` / `--waived`), the operator policy
  file's entry for the repo's remote (`--policy`), then `check` in
  `.verity.json` **at the base revision** (the working-tree copy and
  `~/.verity/trusted.json` are ignored — the executor can write both). The
  command must own its exit status: `||`, `;`, a trailing `&`, `--help`, or a
  pipe without `set -o pipefail` is a usage error (exit 64). It runs as
  `bash -o pipefail -c` in its own process group, with a timeout, with
  secret-looking variables stripped from the environment. Its output goes to
  `--check-log`; the verdict carries only its sha256 and byte count.
- **Exit codes:** `0` pass · `1` fail (a rule was violated) · `2`
  unverifiable (code changed, no check, `--require-check` off, or an explicit
  waiver) · `64` usage · `70` internal (the gate cannot answer). The
  orchestrator treats 64, 70, any other code, a timeout, unparseable stdout
  or a missing CLI as `error` and fails closed in live mode.
- **Verdict (`verity.swarm.verdict/1`, stdout):** decision, base trees and
  their sources, changed code paths, deleted tests, untracked code,
  findings as `{rule, path, label, fingerprint}`, the check record
  (command, source, cwd, exit code, duration, output hash) and the message.
  Never file contents, never command output, never the text of a detected
  credential.

Orchestrator side (mode resolution, shadow/live, retry semantics, the
operator policy file, rollout): `packages/zo-swarm-orchestrator/docs/verity-swarm-gate.md`.

## Supervising wrapper: `verity run`, `verity gate`, the push guard (hybrid Phase 2, shadow)

Phase 2 adds a CLI surface that gates a whole session from outside the harness,
with the same snapshot / verify machinery and diff core the swarm gate uses (no
second rules engine). **It ships in shadow:** verdicts are recorded and reported,
nothing is blocked, and no relaunch happens on its own. Promotion is Phase 3.

```bash
node engine/cli.js run [--harness H] [--session ID] [--tui|--headless] -- <command> [args...]
node engine/cli.js gate [--run ID | --base FILE] [--cwd DIR]
node engine/cli.js feedback --verdict FILE [--check-log FILE] [--out FILE] [--plain]
bash scripts/verity.sh run|gate|feedback ...          # the same, through the control script
bash scripts/install.sh --print-aliases               # suggested shell aliases; prints only, edits nothing
```

**`verity run`** composes snapshot → spawn → verify → feedback → record:

- A run id (`r-<utc>-<hex>`); the base goes to `$VERITY_HOME/runs/<run-id>/base.json`,
  outside the workspace, and its sha256 is held in the wrapper's memory and
  re-checked before verify (a changed base record is an `error` verdict).
- The child inherits stdio (TUIs keep working) and every INT / TERM / HUP / QUIT
  the wrapper receives. Its environment carries `VERITY_RUN_ID`, `VERITY_RUN_DIR`,
  `VERITY_RUN_MODE` and the git guard (below).
- On child exit: verify against the base, append the verdict to the verdict
  store, write `runs/<run-id>/verdict.json` and `feedback.md`, then relaunch or
  exit per the exit contract.
- Workspace: the enclosing repository's top level, else the directory itself.
  A **non-git** workspace is recorded through a shadow git dir at
  `$VERITY_HOME/shadow-git/<sha256(root)[:16]>` (work tree = the directory; heavy
  directories such as `node_modules`, `.venv`, `dist`, `build`, `target`, caches
  excluded; nested repositories judged on their own). The gate's existing caps
  apply (5,000 files, 128 MiB): above them the verdict is `unverifiable` with
  `truncated: true` and the reason, never a pass. The shadow store is removed
  when the last run on that directory completes.
- Concurrent runs on one directory: run locks in `$VERITY_HOME/locks/<key>/`
  mark the tree shared. Both runs record `attribution: "shared"`, and a live
  posture drops to shadow (`downgraded: "shared_workspace"`), as in the
  orchestrator's shared-workspace rule.
- Check and allowances come from the **trusted project config only**: `check`,
  `allow: ["secrets"]` and `ignore` in a `.verity.json` bound with `verity trust`,
  read once before the child starts; failing that, `check` in `.verity.json` at
  the base revision. No flag, environment variable or file the supervised
  process can write supplies one.

**`verity gate`** verifies the tree now against the active run's base (`VERITY_RUN_ID`
in a session, else the newest live run on this workspace, else `--run`) or a named
`--base`: the operator's checkpoint and the agent's sanctioned self-check. It takes
**no allowance input**: `--check`, `--check-source`, `--check-cwd`, `--check-timeout`,
`--check-log`, `--waived`, `--allow-test-deletion`, `--allow-secrets`,
`--allow-check-edits`, `--ignore`, `--exclude`, `--policy`, `--require-check` and
`--max-depth` (and their `--flag=value` forms) are usage errors (64), and so are they
on `verity run` (kill criterion K7, tested in `test/run-wrapper.sh`). Gate verdicts are
recorded (`event: "gate"`) and never applied.

**Exit codes** (no new ones):

| Command / case | Exit |
|---|---|
| `verify`, `gate` | `0` pass · `1` fail · `2` unverifiable · `64` usage · `70` internal |
| `run`, live | the gate's code for the final verdict; a non-zero child exit with a passing workspace is `0`, the child's code recorded in the verdict (`childExit`) |
| `run`, shadow | the child's own exit code (a child killed by signal N: `128+N`) |
| `run`, INT or TERM delivered to the wrapper | verify and record, never relaunch, `128 + signal number` (130 / 143), both modes |

**Posture.** `engine/mode.js` (`engine/cli.js mode`) is the single source, as for the
hooks. Phase 2 honours a resolved `live` only when the Verity config also carries
`run.promoted: true`, which is the Phase 3 switch: this phase sets it nowhere and
it is not an operator step yet. Without it the run is shadow and records
`requestedMode: "live", downgraded: "not_promoted"`.

**Feedback and relaunch.** `verity feedback` renders the block a relaunched or
resumed session reads, with wording owned by the engine (`engine/feedback.js`): the verdict
message, then for a verdict that did not pass and whose check ran, a "Last 40 lines of the
trusted check (command, exit N):" header and the log tail. That is the orchestrator's wording,
with any credential-shaped value in the tail replaced by `[redacted: <label>]`. Relaunch
templates come from the Verity config, `run.relaunch.<harness>` (a string with
`{feedbackFile}` and `{session}`, substituted shell-quoted), and the budget from
`run.relaunchBudget` (default 1). Presets ship only where the resume invocation was
checked against the installed harness's `--help`: claude 2.1.306, codex-cli 0.160.0,
kimi 0.43.1, opencode 1.18.31, pi 0.85.1 and Hermes 0.22.2. **Gemini 0.59.0 has no
preset**, because its `--resume` takes `latest` or an index, not a session id. Relaunch
happens only in live (promoted), headless, with a `--session`, within budget, and never
after INT or TERM. A TUI child (both stdin and stdout are terminals, or `--tui`) is never
relaunched automatically: the verdict and the suggested resume command are printed and
the human decides. In shadow the command is only suggested.

**Git guard and `verity prepush`.** The wrapper appends one entry to the child's
`GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>` (any entries the
parent already set are kept), so `core.hooksPath` resolves to `runs/<run-id>/hooks` for
the session. The user's repository, its config and its hooks directory are untouched. Every
client-side hook name there is a dispatcher. It resolves the repository's own hooks
path exactly as git would without the session entry (`git rev-parse --git-path hooks`:
`core.hooksPath` from husky and its kin, else `.git/hooks`), then runs the repo's hook of
that name with git's arguments and stdin. A non-executable hook is ignored as git ignores
it, and the repo hook's exit status is the hook's status, so a repo hook failure behaves
exactly as it would unwrapped. For `pre-push` it then runs `engine/cli.js prepush` over the
outgoing range of every pushed ref: test deletion and skip markers over the net diff, and
the secret scan over **every** outgoing commit, since a credential added and removed inside
the range is still in the pushed history. The result is recorded as a verdict
(`event: "prepush"`, with `chain` and `repoHookExit`). In shadow it only logs. Layout
the guard cannot chain: when the repo's hooks path resolves to the guard dir itself, or
cannot be resolved at all, the guard runs without chaining and records
`chain: "unverifiable:<reason>"` on the verdict, with a warning on stderr. The repo's hooks
are not skipped silently, and the guard is not dropped.

**Deliberate bypass is out of the threat model.** `git push --no-verify`,
`git -c core.hooksPath=… push` (command-line config outranks the session's env entry),
unsetting `GIT_CONFIG_COUNT`, editing the trusted `.verity.json` or the Verity home: these
are subversion, not premature "done", and are documented here, not chased. Verity is a
done-gate for honest mistakes, not a sandbox.

**Records.** Run, gate and prepush verdicts go to the hooks' verdict store
(`$VERITY_LOG`, else `$VERITY_HOME/verdicts.jsonl`) in the line shape `report.sh` reads,
with `surface: "cli"`, `event: run|gate|prepush`, `session: <run-id>`, `ms` = the gate's
own overhead (wall time minus the check's `checkMs`), and kind mapped as the memo
specified: a secret or test-deletion finding is `deny`, no passing check (including an
unverifiable change) is `done`, a pass is `none`, and a gate that could not answer is
`error`. Provenance only: rule, path and label per finding, the trusted command and exit
codes, never a fingerprint, value, file content or check output. `report.sh` adds a "by
surface" section (lines that predate the field count as `hook`) and, for the CLI
surface, per-event counts, the gate overhead with the check excluded, and the **K5 measure**:
`cli run unverifiable (K5): U/N (P%)`, the share of wrapper verdicts that are
unverifiable. The same number straight from the store:

```bash
jq -s '[.[] | select(.surface == "cli" and .event == "run")]
       | {runs: length, unverifiable: map(select(.verdict.decision == "unverifiable")) | length,
          truncated: map(select(.verdict.truncated == true)) | length}' ~/.verity/verdicts.jsonl
```

## Tests

```bash
bash test/run.sh                                 # hook / adapter / installer suite
bash test/engine-parity.sh "$PWD/engine/cli.js"  # golden fixture corpus (all 45 assert current behaviour: mv-testdel / testdel-ask / testdel-deny-codex expect `deny` since the 2026-10-14 governance change; secret-near-miss / secret-nested-path / secret-ts-string expect AWS's documented AKIAIOSFODNN7EXAMPLE to be allowed under the 2026-10-25 seeded-value rule; refreshed 2026-10-25)
bash test/swarm-verify.sh                        # the swarm gate: snapshot/verify over scratch git fixtures
bash test/hook-diff.sh                           # hybrid Phase 1: the diff ledger under the hook path (record-only)
bash test/run-wrapper.sh                         # hybrid Phase 2: verity run / gate / push guard / feedback (shadow)
```

`run.sh` is hermetic: a fake engine CLI and a temporary `HOME`, project and Verity home. Covers translation in both directions, shadow mode for every harness, the Jev key never reaching the engine, the kill switch, the mode CLI, live mode per harness and per check, environment precedence, failing closed on bad output in live mode (including the Kimi/Gemini translated refusal), and the installer's merge, preservation, migration and idempotency.

`swarm-verify.sh` covers the Stage 2 acceptance list at the engine level: no check → unverifiable / fail under `--require-check`, passing and failing checks, masked commands (64), deleted and renamed tests (including `test_x.py` / `x_test.go`), a planted GitHub token with a no-token-text-in-any-output grep, untracked new code, docs-only with the check provably not run, hollow pass, check-definition tampering and base-revision-only `.verity.json`, the factory shape (non-git root plus a nested clone judged against the upstream merge-base), a `git init` repo, missing base tree (70), policy by remote, `info/exclude` hiding, and the two engine fixes from Stage 1 (#3 trusted-pattern masking, #4 every credential match).

`hook-diff.sh` covers hybrid Phase 1 through the real engine over scratch repos: work the event ledger cannot see (`git apply`, a heredoc write, `sed -i`, a test removed by a non-`rm` command, a human edit after the agent's passing check), the skip-marker rule and its near-misses, secrets on added lines with no value in any record, the non-repo / over-cap / unwritable-home / diff-error fallbacks, live mode answering from the event verdict alone, replay, and the K2 disagreement recipe (`scripts/diff-disagreements.sh`).

`run-wrapper.sh` covers hybrid Phase 2 end to end, with fake harness children (shell scripts) over scratch repos. The children edit code, delete a test, plant a secret, fail the check, crash, get INT and TERM, and push to a local bare remote. It covers the exit-code table in shadow and promoted live; relaunch with the feedback file and session, the budget, TUI and shadow inertness; the preset list; K7 (gate and run reject every allowance-shaped flag, and a child that rewrites `.verity.json` to allow secrets still fails); the push guard on a secret, on a secret added and removed inside the range, and on a clean push; chaining to a husky-style hooks path, including a failing repo hook compared against the same push unwrapped, a non-executable hook, and the unchainable self layout; a non-git workspace through the shadow git, including its file cap; a shared-cwd second run; shadow-store pruning; report grouping, the K5 read, a pre-field store; and the installer's print-only alias flag.
