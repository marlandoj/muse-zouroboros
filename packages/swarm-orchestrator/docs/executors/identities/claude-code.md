# Claude Code Executor Capability Guide

## Production identity

- Executor ID: `claude-code`
- Runtime: Claude Code CLI `2.1.220`
- Transport: ACP through `claude-agent-acp`
- Indexed SDK: `@anthropic-ai/claude-agent-sdk@0.3.220`
- Swarm model control: `ANTHROPIC_MODEL`

## Best use

Use Claude Code for complex multi-file implementation, architecture work, code review, debugging, refactoring, testing, and repository operations that need sustained codebase context.

## SDK surface

The Claude Agent SDK programmatically exposes Claude Code capabilities. The indexed declarations cover:

- async `query()` message streams
- session creation, continuation, and resume
- built-in tools and permission modes
- custom tools and in-process MCP servers
- external MCP server configuration
- hooks and lifecycle callbacks
- subagents and agent definitions
- structured output and partial-message streaming
- file checkpointing and usage metadata
- browser and compiled-binary integration surfaces

## Swarm usage

Production swarm execution remains on ACP. The adapter process receives task-scoped model selection from `ANTHROPIC_MODEL`, workspace context from the task, and the shared transport timeout and cancellation contract.

The Agent SDK corpus is available to routing, implementation, and evaluation agents. It does not silently change the executor from ACP to direct SDK embedding. Any such transport change requires isolated evaluation and promotion.

## Boundaries

- Read the target repository before editing.
- Keep writes within the task worktree and declared mutation scope.
- Require explicit authority for destructive Git or external publishing actions.
- Never expose credentials in output or persisted configuration.
- Verify compilation, tests, and requested behavior before reporting completion.
