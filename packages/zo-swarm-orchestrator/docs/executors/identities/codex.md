# Codex Executor Capability Guide

## Production identity

- Executor ID: `codex`
- Runtime: Codex CLI `0.144.0`
- Transport: ACP through `codex-acp`
- Indexed SDK: `@openai/codex-sdk@0.144.0`
- Swarm model control: `CODEX_MODEL`

## Best use

Use Codex for fast repository-aware implementation, debugging, refactoring, shell automation, and focused review. It is most effective when the task has an explicit working directory, bounded write scope, and mechanical verification commands.

## SDK surface

The TypeScript SDK embeds the Codex agent by spawning the CLI and exchanging JSONL events over stdin and stdout. Its main surfaces are:

- `Codex.startThread()` for a new agent session
- `Codex.resumeThread()` for a persisted session
- `Thread.run()` for buffered turns
- `Thread.runStreamed()` for tool, file-change, response, and usage events
- `outputSchema` for schema-constrained JSON results
- text plus local-image inputs
- `workingDirectory` and `skipGitRepoCheck` controls
- explicit environment isolation through the `Codex` constructor
- global and thread-scoped configuration overrides

## Swarm usage

The current swarm executor uses ACP, not the TypeScript SDK. The SDK corpus is operational knowledge for routing, evaluation, and future adapter work. Moving production execution to the SDK requires a separate promotion gate because it changes transport, session lifecycle, and event handling.

## Boundaries

- Do not treat SDK availability as production SDK transport enablement.
- Keep model selection task-scoped through the registry and environment contract.
- Preserve worktree isolation and expected-mutation verification for write tasks.
- Record requested, resolved, and served model identities when a provider fallback occurs.
