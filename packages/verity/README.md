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

## Tests

```bash
bash test/run.sh                                 # hook / adapter / installer suite
bash test/engine-parity.sh "$PWD/engine/cli.js"  # golden fixture corpus (6 known-stale: 3 testdel fixtures expect `ask`, the 2026-10-14 governance change made it `deny`; secret-near-miss / secret-nested-path / secret-ts-string expect a deny for AWS's documented AKIAIOSFODNN7EXAMPLE, which the 2026-10-25 seeded-value rule now allows)
bash test/swarm-verify.sh                        # the swarm gate: snapshot/verify over scratch git fixtures
```

`run.sh` is hermetic: a fake engine CLI and a temporary `HOME`, project and Verity home. Covers translation in both directions, shadow mode for every harness, the Jev key never reaching the engine, the kill switch, the mode CLI, live mode per harness and per check, environment precedence, failing closed on bad output in live mode (including the Kimi/Gemini translated refusal), and the installer's merge, preservation, migration and idempotency.

`swarm-verify.sh` covers the Stage 2 acceptance list at the engine level: no check → unverifiable / fail under `--require-check`, passing and failing checks, masked commands (64), deleted and renamed tests (including `test_x.py` / `x_test.go`), a planted GitHub token with a no-token-text-in-any-output grep, untracked new code, docs-only with the check provably not run, hollow pass, check-definition tampering and base-revision-only `.verity.json`, the factory shape (non-git root plus a nested clone judged against the upstream merge-base), a `git init` repo, missing base tree (70), policy by remote, `info/exclude` hiding, and the two engine fixes from Stage 1 (#3 trusted-pattern masking, #4 every credential match).
