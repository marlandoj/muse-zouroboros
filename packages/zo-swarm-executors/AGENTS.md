# AGENTS.md — zo-swarm-executors

Agent memory for AI coding assistants working on this project.

## Design Decisions

1. **Registry-based integration** — The orchestrator reads `executor-registry.json` via a configurable path (`SWARM_EXECUTOR_REGISTRY`). No TypeScript import coupling between skills.

2. **Transport abstraction as interface** — Executors use native ACP where available and retain shell bridges for compatibility or explicit rollback.

3. **Identity files are references** — Canonical identity files live in `/home/workspace/IDENTITY/`. The `docs/identities/` copies are for documentation only.

4. **Backwards compatibility** — The orchestrator falls back to `persona-registry.json` (filtering `executor === "local"`) if the executor registry is not found.

## File Layout

```
bridges/          — Executable bridge scripts (the core interface)
registry/         — Executor registry JSON (consumed by orchestrator)
scripts/          — Management tools (doctor, test-harness, register)
types/            — TypeScript interfaces for the registry schema
docs/             — Protocol spec and reference identity files
```

## Key Patterns

- All paths in the registry are relative to `SWARM_WORKSPACE` (default: `/home/workspace`)
- Bridge scripts use `set -euo pipefail` and validate `$1` is provided
- Doctor checks: bridge exists, executable, health command, env vars
- Test harness sends `"Respond with exactly: BRIDGE_OK"` and validates output

## Known Limitations

- The Hermes one-shot bridge is retained only for `HERMES_ACP_ENABLED=0` rollback and direct scripted use. It must use `hermes -z`, which auto-bypasses interactive approvals, emits only the final response, and exits non-zero when no final response is produced.
- Claude Code bridge discovers MCP tool names dynamically by querying each server's `tools/list` endpoint at startup. Results are cached for 1 hour at `/tmp/claude-bridge-mcp-tools-cache.txt`. Delete the cache to force re-discovery. Only HTTP/Streamable-HTTP MCP servers with a `url` in `.mcp.json` are queried (stdio servers are skipped).
- ACP OpenCode sessions load the workspace `.mcp.json`, add an authenticated Zo MCP server, and inject the memory-gate session briefing per task. The registry is the source of truth for this task-scoped wiring; do not rely on global OpenCode MCP state.
- No Windows support — bridges are bash scripts.

## Integration Notes

- Orchestrator file: `Skills/zo-swarm-orchestrator/scripts/orchestrate-v4.ts`
- Orchestrator reads registry at: `PATHS.executorRegistry`
- Orchestrator creates the registry-selected transport through `packages/swarm/src/transport/factory.ts`.
- Split concurrency: `localConcurrency` pool separate from `maxConcurrency` (API)

## ACP Transport Layer (Phase 1-3 Complete — 2026-04-04)

The executor system now has a transport abstraction layer. All executors implement `ExecutorTransport` via either `BridgeTransport` (shell bridge) or `ACPTransport` (Agent Client Protocol over stdio).

### Current Transport Map

| Executor | Transport | Adapter |
|---|---|---|
| claude-code | **acp** | `claude-agent-acp` at `/usr/bin/claude-agent-acp` |
| hermes | **acp** | `hermes acp --accept-hooks`; rollback: `HERMES_ACP_ENABLED=0` |
| gemini | **acp** | `gemini --acp` |
| codex | **acp** | `codex-acp` |
| opencode | **acp** | `opencode acp --pure` |
| kimi | **acp** | `kimi acp` through `kimi-bridge.sh --acp` |
| pi | **bridge** | `pi --print --no-session` |
| cursor | **bridge** | `cursor-agent -p --force --output-format json` |

Hermes v1 ACP routing is scoped to research, audit, investigation, security, summarization, and tool orchestration. Code-generation routing remains outside this canary boundary.

### Flipping an Executor to ACP

1. Install the adapter binary (e.g., `npm install -g codex-acp`)
2. Update `registry/executor-registry.json`: set `"transport": "acp"` for the executor
3. Run `bun scripts/doctor.ts` — verify `acp-adapter ✓`

### Transport Abstraction Files (monorepo)

- `packages/swarm/src/transport/types.ts` — `ExecutorTransport`, `SessionUpdate`, `TransportOptions`
- `packages/swarm/src/transport/bridge-transport.ts` — wraps `BridgeExecutor`
- `packages/swarm/src/transport/acp-transport.ts` — ACP session lifecycle
- `packages/swarm/src/transport/factory.ts` — `createTransport(entry, cb)` dispatch
