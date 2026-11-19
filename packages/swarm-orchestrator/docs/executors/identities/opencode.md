# OpenCode Executor Capability Guide

## Production identity

- Executor ID: `opencode`
- Runtime: OpenCode CLI `1.18.4`
- Transport: native `opencode acp --pure`
- Indexed SDK: `@opencode-ai/sdk@1.18.4`
- Model control: ACP session configuration category `model`

## Best use

Use OpenCode when the swarm needs one model-neutral coding harness across independently operated providers. It is the preferred executor for harness-controlled model comparisons, repository-aware implementation, and task-scoped provider or model pinning.

## SDK surface

The TypeScript SDK exposes the OpenCode client and server contract, including:

- typed client creation
- server lifecycle and configuration
- projects and workspace context
- sessions, messages, prompts, and commands
- file search, read, status, and diff operations
- tools and permission responses
- providers, models, authentication, and configuration
- event subscription and streamed updates

## Swarm usage

Production execution remains on native ACP. The registry normalizes task model identifiers, selects provider templates, injects only task-scoped configuration, and rejects unsupported `byok:` identifiers rather than forwarding them as provider-native model names.

## Boundaries

- Keep provider diversity separate from model-family diversity.
- Do not mutate global OpenCode configuration for a single swarm task.
- Preserve the actual endpoint class and serving provider in result provenance.
- SDK indexing does not authorize a change from ACP to direct SDK execution.
