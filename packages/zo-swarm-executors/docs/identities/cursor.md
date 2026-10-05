# Cursor CLI Executor

## Production Transport

The `cursor` executor uses Cursor Agent in isolated print mode through
`cursor-agent -p --output-format json`. The bridge adds `--force` for approved
noninteractive swarm mutations, scopes execution to the task worktree, returns
only the final result on stdout, and sends diagnostics to stderr.

Cursor is best suited to repository-aware implementation, refactoring,
debugging, code review, and tasks that benefit from Cursor rules, `AGENTS.md`,
or configured MCP servers.

## Authentication And Models

Cursor Agent supports browser login and `CURSOR_API_KEY`. The bridge does not
require the environment variable because an existing browser session is also
valid. `cursor-agent status` is the authority for readiness.

Model selection defaults to Cursor's `auto` route. A task-scoped
`CURSOR_MODEL` or `SWARM_RESOLVED_MODEL` is forwarded only when it names a
concrete Cursor model; Zouroboros `byok:` and tier aliases are deliberately not
passed through.

## Official SDK

The canonical swarm RAG corpus pins `@cursor/sdk@1.0.26`. The TypeScript SDK
supports local or cloud agents, streamed events, custom tools, structured
review, JSONL or custom state stores, and nested subagents. The CLI and SDK are
separate integration surfaces: the current production executor remains the
process-isolated CLI bridge until an SDK-native transport preserves workspace,
cancellation, telemetry, routing, and output contracts.

Official sources:

- https://docs.cursor.com/en/cli/headless
- https://docs.cursor.com/en/cli/reference/parameters
- https://docs.cursor.com/en/cli/reference/authentication
- https://docs.cursor.com/en/cli/using
- https://cursor.com/changelog/sdk-release
- https://cursor.com/changelog/sdk-updates-jun-2026
