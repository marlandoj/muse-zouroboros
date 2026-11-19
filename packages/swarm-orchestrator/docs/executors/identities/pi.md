# Pi Executor Capability Guide

## Production Transport

The `pi` executor uses an isolated one-shot CLI bridge with no persisted session.
The bridge injects the memory-gate briefing and loads the shared memory and
authenticated Zo MCP servers through the Pi MCP adapter.

The VPS CLI was verified on 2026-09-08 as
`@mariozechner/pi-coding-agent@0.73.1`: `command -v pi` resolves
`/home/zouroboros/.npm-global/bin/pi`, whose target is that package's `dist/cli.js`,
and `pi --version` reports `0.73.1`. The registry's `sdk.runtimeVersion` records
this installed CLI version. Its help has no `--approve` option, and the canonical
bridge does not pass that flag.

Route Pi tasks that benefit from:

- fast, focused repository implementation and review;
- provider-neutral model comparisons;
- ephemeral execution with no session carry-over;
- custom provider/model selection per task;
- coding, debugging, testing, shell work, and file editing.

## Official SDK

The indexed TypeScript SDK reference (`sdk.package` and `sdk.version`) is
`@earendil-works/pi-coding-agent@0.82.1`. This is separate from the installed
CLI recorded above; indexing the reference does not install or upgrade Pi.
Its public surface includes:

- `createAgentSession` and runtime factories for embedded agents;
- model runtime, provider authentication, and scoped model control;
- in-memory, persistent, continued, and branched sessions;
- custom and built-in tools with explicit allowlists;
- extensions, skills, prompt templates, context files, and event buses;
- streaming lifecycle events and direct agent-state access;
- interactive, print, and JSON-RPC run modes;
- compaction, retry, settings, and resource-loader controls.

Use the SDK instead of the one-shot bridge when Zouroboros needs persistent or
branched sessions, event streaming, direct state inspection, programmatic tool
registration, custom extension factories, embedded runtime replacement, or a
language-local TypeScript integration. Use Pi JSON-RPC when process isolation
is required but a structured multi-turn protocol is preferable to the current
text bridge.

## Boundary

The current bridge intentionally disables session persistence and does not
expose the SDK event stream. An SDK- or RPC-native swarm transport must preserve
MCP, memory briefing, workspace scoping, cancellation, telemetry, model-routing,
and output contracts before promotion.

Pi model identifiers are provider-qualified. Runtime overrides should remain
task-scoped; a global `PI_MODEL` overrides the swarm-resolved model and should
not be set for adaptive routing.

Official sources:

- https://github.com/earendil-works/pi
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
