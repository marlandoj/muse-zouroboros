# Kimi Executor Capability Guide

## Production Transport

The `kimi` executor uses Kimi Code CLI through native ACP. It receives the
workspace MCP roster, authenticated Zo tools, and the memory-gate briefing for
each task. The one-shot shell bridge is a fallback, not the preferred path.

Route Kimi tasks that benefit from:

- large repository context and long implementation sessions;
- Moonshot-family independent review;
- multimodal analysis supported by the selected Kimi model;
- ACP tool use with task-scoped MCP servers;
- coding, debugging, testing, refactoring, and repository-wide analysis.

## Official SDK

The pinned Python package is `kimi-sdk==0.2.1`. Its public surface includes:

- `Kimi`, `generate`, and `step` for async completion and agent loops;
- streaming message parts and token usage;
- typed messages and text, image, audio, and video content parts;
- `CallableTool2`, `SimpleToolset`, and structured tool results;
- Kimi file APIs, including video upload;
- provider errors, timeout handling, and thinking-effort control.

Use the SDK instead of ACP when Zouroboros needs an embedded Python workflow,
typed custom tools, direct streaming callbacks, explicit history control,
multimodal file upload, or per-step usage accounting.

## Boundary

The SDK is a Kimi API integration surface; it is not the Kimi Code CLI harness.
An SDK-native swarm transport must explicitly recreate MCP, memory briefing,
workspace permissions, cancellation, telemetry, and process isolation before
promotion. Until that is evaluated, normal swarm tasks use ACP.

Model selection is task-scoped through the ACP session. Provider credentials and
base URL are launch-scoped. Do not assume an ACP model change also changes the
provider endpoint.

Official sources:

- https://github.com/MoonshotAI/kimi-cli
- https://github.com/MoonshotAI/kimi-cli/tree/main/sdks/kimi-sdk
