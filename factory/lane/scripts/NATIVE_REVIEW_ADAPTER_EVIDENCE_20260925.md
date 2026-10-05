# Native review adapter source qualification — September 25, 2026

Status: source and credential-free fixtures passed; installed invocation held.

The operator's September 25 continuation explicitly authorizes native subagent
implementation toward standalone Factory activation with existing subscriptions.
This bounded lane used no provider invocation, credentials, deployment, tracker
write, model Consensus or persona enforcement. The parent owns routing and the
production transition. Graph-first lookup was attempted over SSH but sandbox
permissions denied access; targeted local source reads supplied the existing
persona request/result contract and executor-bridge capability comparison.

## Delivered source

`native-review-adapter.ts` exposes `createNativeReviewerCaller`, structurally
compatible with the existing `invoke_persona` dependency. Its default shadow
mode performs zero CLI, model, installation-verifier or ledger calls. The
explicit qualification mode requires an exact plan digest, native reviewer
identity and prompt hash, different implementer vendor, call/input/output/time
bounds, and required injected installation and durable-attempt operations.

Claude Code is the sole supported harness. The parent captured installed help
for `--tools ""`, `--disable-slash-commands`, `--strict-mcp-config`, `--mcp-config`,
`--setting-sources`, `--safe-mode`, `--no-session-persistence` and
`--max-budget-usd`. Help and exact version are checked again before every review.
The adapter checks `auth status --json` for `claude.ai` / `firstParty`, provides
only HOME/PATH/LANG/TZ, supplies zero built-in tools and an empty MCP config,
disables slash commands and setting sources, uses documented safe mode to
disable custom hooks/plugins/instructions, and
never passes `--bare` (which the installed CLI documents as bypassing OAuth).

Model output must be one successful turn, with no permission denials, exactly
the requested reported model, bounded reported cost and strict pass/fail JSON.
Failing review rationale is preserved as redacted dissent. Raw provider errors,
auth output and response session identifiers are not persisted. A durable
reservation precedes any CLI call; terminal persistence must succeed before
returning. Failed or uncertain effects are not retried automatically.

The actual Linux transport uses no shell, bounds combined stdout/stderr,
terminates its process group on timeout/overflow/completion and preserves UTF-8
across chunks. The transport is not selected automatically: the installed
consumer must explicitly provide its verified dependency bundle.

## Verified locally

- Bun 1.3.12: 15 tests passed, 101 assertions, including independent-review
  request/plan asynchronous-mutation regression cases. Zero model/credential calls.
- Strict targeted TypeScript compilation passed (`--noEmit --strict --target
  es2022 --module esnext --moduleResolution bundler --types bun,node
  --skipLibCheck`) for the two new TypeScript files.
- Root subsequently ran the combined current-source suite on Linux: 40 tests,
  228 assertions passed across five files, including four actual Linux transport
  tests with 28 assertions. These verified owned same-process-group cleanup and
  bounded transport behavior; they do not establish cleanup of processes that
  escape into separate groups. The strict TypeScript check remained clean.
- Cases cover shadow zero-call behavior, fixed command/environment controls,
  retained dissent, missing controls, API-key/unavailable auth, malformed and
  multi-turn output, permission denials, model drift, timeout/overflow/process
  failure, cost overrun, redaction, identity/vendor separation, failed-attempt
  caps, caller-policy mutation, and durable receipt failure.

## Remaining obligations before any real call

1. Implement and independently qualify the installation verifier. It must bind
   root-controlled plan provenance, exact executable/runtime bytes, a dedicated
   subscription-only auth profile, an empty work directory and effective
   no-hooks/no-plugins settings, including any admin-managed policy that survives
   safe mode. Fixture claims and help text do not prove installed behavior.
2. Bind exact role-policy coverage and persona definitions to the native
   directory, plus a durable campaign-wide attempt and uncertainty ledger. The
   adapter's in-process cap is supplementary, not a durable quota.
3. Measure the installed CLI envelope and controls, including service-level
   containment of any escaped process groups, then qualify an explicitly bounded
   real subscription review. Passing injected fixtures and the four Linux
   transport tests do not prove installed CLI acceptance. Reported CLI cost is
   usage accounting and is not evidence of zero monetary spend; subscription
   auth is separately required.
4. Wire the native consumer and correct the legacy orchestrator's `zo-ask`
   evidence label, with frozen supplied evidence instead of instructions to
   inspect a worktree. Current orchestrator defaults remain unchanged.
5. Codex no-tools invocation is deliberately unsupported. Read-only sandboxing
   and post-hoc rejection of tool events do not disable tool access. A qualified
   native Codex adapter remains required for the opposite reviewer vendor.

No live Factory path consumes this adapter yet; it grants no production
admission, merge, dispatch or deployment authority.
