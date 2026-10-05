# Executor Capability and Routing Matrix

This document describes the seven supported CLI executors, the capabilities exposed by their production transports, and how the DAG chooses an executor and model for each task.

## Inventory scope (RB-16)

The CLI inventory is `claude-code`, `codex`, `gemini`, `hermes`, `kimi`, `opencode`, and `pi`. Counts refer to configured support, not a claim that every binary is healthy or eligible for automatic routing.

| Source | Active entries | Scope |
|---|---|---|
| `packages/swarm/src/executor/registry/harness-contract.json` | 7 | Portable CLI harnesses |
| `packages/swarm/src/executor/registry/executor-registry.json` | 7 | The same CLI executors |
| `Skills/zo-swarm-executors/registry/executor-registry.json` | 7 | Byte-identical generated copy of the canonical package registry (RB-2) |

Mimir uses `transport: "mimir"` and has no bridge. It is not a CLI harness, is excluded from the portability contract, and is not supported by the packaged transport factory (which supports ACP and bridge transports). Its complete entry is preserved under `services` in both registries, outside the active executor list (RB-2).

RB-2 gives the native loader, CC runtime, and doctors one registry resolver: an explicit registry argument or `SWARM_EXECUTOR_REGISTRY` wins; an explicit workspace selects its canonical package registry; otherwise the installed package uses its bundled registry. Missing selections never silently fall back to Skills. CC v5 still requires a bridge when loading campaign executors. See [runtime authority and migration](runtime-authority.md) for the full precedence and generated compatibility paths.

Cursor is deprecated and removed from registry metadata, bridges, and automatic routing.

## Capability matrix

| Executor | Production transport | Best fit | Production tools | Hierarchical delegation | Model route | Indexed SDK or API corpus |
|---|---|---|---|---|---|---|
| `claude-code` | ACP via `claude-agent-acp` | Architecture, complex multi-file implementation, review, debugging, and repository operations | File read/write, shell, MCP, streaming | Conditional parent; summary-only child telemetry | Qualified catalog winner by tier; static floor is Haiku/Sonnet/Opus | `@anthropic-ai/claude-agent-sdk@0.3.220` |
| `hermes` | Native ACP via `hermes acp --accept-hooks` | Web research, external tools, investigation, security review, multimodal work, and long autonomous workflows | File read/write, shell, web/browser, image, MCP, streaming, messaging, and scheduled tools | Enabled parent; bounded child records | `light`, `mid`, and `heavy` aliases resolved by Hermes provider routing; `swarm-failover` on failover | Live `hermes-agent@0.19.0` source |
| `gemini` | Native ACP via `gemini --acp` | Large-context analysis, multimodal review, research synthesis, UI work, and independent cross-checks | File read/write, shell, web, MCP, streaming, policy and sandbox services | Leaf | Qualified catalog winner by tier; static floor is Flash/Pro | `@google/gemini-cli-core@0.50.0` |
| `codex` | ACP via `codex-acp` | Fast repository implementation, backend work, refactoring, shell automation, and focused review | File read/write, shell, MCP, streaming | Leaf | Qualified catalog winner by tier; static floor is Luna/Sol/Astra | `@openai/codex-sdk@0.144.0` |
| `opencode` | Native ACP via `opencode acp --pure` | Vendor-neutral coding, harness-controlled model comparisons, and provider-pinned implementation | File read/write, shell, web, MCP, streaming | Leaf | GPT-OSS 20B for trivial, GLM-5.2 for simple/moderate, Grok Build for complex/failover; provider-qualified passthrough | `@opencode-ai/sdk@1.18.4` |
| `kimi` | Native ACP through the Kimi bridge | Large-context and long-running coding, multimodal analysis, Moonshot-family review, and repository-wide debugging | File read/write, shell, web, shared MCP roster, authenticated Zo tools, memory briefing, streaming | Leaf; SDK agent-loop primitives are not wired into DAG delegation | Kimi K3 for every tier; model is session-scoped while provider endpoint and credentials are launch-scoped | `kimi-sdk==0.2.1` |
| `pi` | Isolated one-shot bridge with Pi MCP adapter | Fast focused implementation, ephemeral review, minimal-harness comparisons, and cross-provider coding | File read/write, shell, web, shared MCP roster, authenticated Zo tools, memory briefing; final-result transport | Leaf; SDK sessions and extensions are not wired into DAG delegation | OpenRouter Kimi K3 by default; provider-qualified task overrides; Kimi Latest failover | `@earendil-works/pi-coding-agent@0.82.1` |

Pi's indexed SDK reference above is separate from its installed VPS CLI:
`@mariozechner/pi-coding-agent@0.73.1`, verified on 2026-09-08 and recorded in
`sdk.runtimeVersion`. See the [Pi capability guide](identities/pi.md) for the
command-level evidence and SDK/runtime distinction.

## DAG executor selection

The selector applies these controls in order:

1. An explicit `task.executor` wins, subject to persona tool restrictions and circuit-breaker fallback.
2. A healthy role-registry executor is authoritative. If its circuit is open or it is unavailable, the selector uses the role's fallback chain and then composite routing.
3. Without the routing engine, budget below 20 percent forces the cheapest healthy eligible executor.
4. The routing engine scores every auto-routable executor. It normally uses six signals: capability, health, complexity fit, history, procedure knowledge, and temporal health. When budget or role context exists, budget and role affinity extend the decision to eight signals.
5. If no routing engine is supplied, legacy tag matching selects among the seven registered CLI executors, subject to eligibility controls.
6. Persona restrictions remove executors whose declared tools violate the persona boundary. An open circuit breaker advances through the executor-specific fallback chain.

OpenCode participates in automatic routing only when `SWARM_OPENCODE_ENABLED=1`. The other six active CLI executors have no rollout gate, although unhealthy or unauthenticated binaries are excluded by health controls.

## Model selection and dispatch

After selecting the executor, the orchestrator resolves the model from the shared catalog in this order:

1. Explicit model or role alias, normalized to light, mid, or heavy.
2. Operator pin for the executor and tier.
3. Fresh qualified catalog model.
4. Last-known-good catalog model.
5. Static floor or compatible fallback, with a recorded fallback reason.

The catalog is generated from the model-intelligence feed. Light candidates are capped at $2/M output and mid candidates at $15/M; heavy candidates have no price ceiling. A candidate becomes routable only after a real bridge probe and three-task canary. A stale or missing catalog never blocks the swarm.

The DAG passes the resolved value to every transport as `SWARM_RESOLVED_MODEL`. ACP adapters apply it through an environment variable, ACP session configuration, or an ACP extension according to the registry. Bridge executors receive the same task-scoped environment value. A fallback executor re-resolves the model against its own accepted model family before dispatch.

## Subagents and SDK boundaries

Hierarchical DAG delegation is a control-plane feature, not an automatic consequence of an SDK exposing sessions or agents. Only Hermes and Claude Code currently have production delegation profiles. Kimi, Pi, Gemini, Codex, and OpenCode remain leaf executors until their child-task lifecycle, write isolation, cancellation, telemetry, and recursion limits are separately implemented and promoted.

SDK sources are indexed in RAG for implementation and routing knowledge. Indexing an SDK does not switch the production transport from ACP or bridge execution to direct SDK embedding.
