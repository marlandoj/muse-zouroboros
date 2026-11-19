# Hermes Executor Capability Guide

## Production identity

- Executor ID: `hermes`
- Runtime: Hermes Agent `0.19.0`
- Source: live `/home/workspace/hermes-agent` Git checkout
- Transport: native ACP through `hermes acp --accept-hooks`
- Fallback: one-shot bridge only when `HERMES_ACP_ENABLED=0`
- Model control: ACP `session/set_model`

## Best use

Use Hermes for deep web research, multi-source investigation, external tool orchestration, data gathering, security review, multimodal work, and long-running tasks that benefit from autonomous tool selection.

## Runtime API surface

Hermes does not ship a separate executor SDK package. The indexed production source covers:

- native ACP server, sessions, events, permissions, and provenance
- provider and model switching
- the main agent loop and one-shot runner
- toolset selection and distribution
- MCP tool transport
- delegated tasks and session state
- web, browser, terminal, file, memory, vision, and messaging tools
- scheduled tasks and background process management

## Swarm usage

The swarm launches the native ACP adapter, applies a task-scoped provider/model through `session/set_model`, and records the actual endpoint class for provider-diversity accounting. The shared ACP transport supplies MCP configuration, timeout, cancellation, and session-update forwarding.

The indexed source version is the live project version plus its Git revision. This makes retrieval match the code that production executes rather than a similarly named package release.

## Boundaries

- Prefer read-only evidence gathering before consequential actions.
- External messages, publishing, and destructive actions require explicit authority.
- Child delegation must remain bounded and non-recursive.
- Preserve source citations and separate verified evidence from inference.
- Do not infer provider diversity from model names alone; use the recorded endpoint class.
