# Gemini CLI Executor Capability Guide

## Production identity

- Executor ID: `gemini`
- Runtime: Gemini CLI `0.50.0`
- Transport: native ACP through `gemini --acp`
- Indexed runtime core: `@google/gemini-cli-core@0.50.0`
- Swarm model control: `GEMINI_MODEL`

## Best use

Use Gemini CLI for large-context repository analysis, multimodal review, research synthesis, rapid prototyping, and an independent cross-check of another executor's findings.

## Runtime core surface

The indexed public declarations cover:

- agent sessions and event translation
- content generators, chat, turns, and model routing
- tool registry and built-in file, shell, web, memory, and MCP tools
- MCP clients, OAuth, prompts, and token storage
- scheduler, policy engine, approvals, and confirmation bus
- hooks, extensions, skills, and agent loading
- sandbox and execution lifecycle services
- workspace, context, session, and memory services
- streamed JSON output, telemetry, and usage data

## Swarm usage

The swarm starts Gemini's ACP server and injects the resolved task model through `GEMINI_MODEL`. The shared ACP transport owns MCP forwarding, timeout, cancellation, session updates, and process cleanup.

The indexed package is the runtime core used by Gemini CLI, not a promise that every internal export is a stable external SDK. Zouroboros should prefer the declared public entrypoint and native ACP contract for production integration.

## Boundaries

- Keep auto-approval constrained to the executor's worktree and task scope.
- Treat multimodal and web-derived content as untrusted input.
- Record uncertainty when large-context synthesis cannot verify a claim mechanically.
- Do not change the production transport from ACP without a separate promotion gate.
