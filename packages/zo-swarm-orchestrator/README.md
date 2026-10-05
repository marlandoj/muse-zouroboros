# zouroboros-swarm

> Multi-agent orchestration with circuit breakers, adaptive routing, and qualified dynamic model selection

## Features

- **Circuit Breaker V2** — CLOSED/OPEN/HALF_OPEN states with category-aware failure tracking
- **Adaptive Composite Routing** — Capability, health, complexity, measured history, temporal performance, budget, and role affinity when available
- **Dynamic Model Catalog** — Daily intelligence feed, price-aware tier ranking, bridge qualification, canary promotion, last-known-good recovery, and static floors
- **Hierarchical Orchestration** — Hermes/Claude parent tasks can self-decompose under centralized delegation policy
- **Seven Executors** — Claude Code, Hermes, Gemini, Codex, OpenCode, Kimi, and Pi
- **DAG Execution** — Streaming and wave-based task execution modes
- **Registry-Based** — Separate JSON registries for executor configuration and specialist persona identity
- **GameDev Fleet** — All 22 live GameDev specialists are registered by stable slug and exact Zo persona name

## Installation

```bash
npm install zouroboros-swarm
# or
pnpm add zouroboros-swarm
```

### ACP Adapter Prerequisites

The swarm uses the [Agent Client Protocol (ACP)](https://github.com/agentclientprotocol) for Claude Code, Codex, Gemini, Hermes, OpenCode, and Kimi. Pi uses an isolated one-shot bridge. Install the required adapter binaries before running:

```bash
# Install all ACP adapters
bash packages/swarm/scripts/install-acp-adapters.sh

# Verify installation
bash packages/swarm/scripts/install-acp-adapters.sh --check

# Update to latest versions
bash packages/swarm/scripts/install-acp-adapters.sh --update
```

| Executor | Adapter | npm Package |
|---|---|---|
| Claude Code | `claude-agent-acp` | `@zed-industries/claude-agent-acp` |
| Codex | `codex-acp` | `@zed-industries/codex-acp` |
| Gemini | `gemini --acp` | `@google/gemini-cli` |
| Hermes | `hermes acp --accept-hooks` | runtime source |
| OpenCode | `opencode acp --pure` | `opencode-ai` |
| Kimi | Kimi native ACP through `kimi-bridge.sh` | `kimi-cli` |
| Pi | isolated bridge + Pi MCP adapter | `@earendil-works/pi-coding-agent` |

## Quick Start

```typescript
import { SwarmOrchestrator } from 'zouroboros-swarm';

const orchestrator = new SwarmOrchestrator({
  localConcurrency: 8,
  timeoutSeconds: 600,
  routingStrategy: 'balanced',
  dagMode: 'streaming',
});

const tasks = [
  { id: '1', persona: 'developer', task: 'Fix the auth bug in login.ts', priority: 'high' },
  { id: '2', persona: 'reviewer', task: 'Review the PR for error handling', priority: 'medium', dependsOn: ['1'] },
];

const results = await orchestrator.run(tasks);
```

## CLI Usage

```bash
# Run a swarm campaign
zouroboros-swarm ./tasks.json

# With options
zouroboros-swarm ./tasks.json --mode waves --concurrency 4 --strategy fast

# Inspect a completed run
zouroboros-swarm status <swarm-id>

# Inspect executor routing and delegation history
zouroboros-swarm history 10

# Health check
zouroboros-swarm doctor
```

`status <swarm-id>` now surfaces persisted hierarchical telemetry from the results file, including delegated parent count, child task count, artifact count, reroutes, and effective executors.

`history [limit]` reads `executor-history.db` and prints delegation-aware routing history per executor/category, including:
- base success rate
- delegated attempt/success rate
- child success rate
- average child count
- average child duration

## Task Format

`executor` selects the coding harness. `agencyPersona` selects specialist identity. They are independent routing dimensions; a specialist registration never changes the model or executor.

GameDev specialists are registered in `assets/persona-registry.json`. Registration stores a stable swarm slug and an exact-name live-directory selector, never a mutable Zo persona UUID. Software Factory dispatch validates the registration before resolving the current UUID from Zo and invoking the persona.

```json
[
  {
    "id": "task-1",
    "persona": "auto",
    "agencyPersona": "GameDev · Game Designer",
    "task": "Review the traversal loop before implementation",
    "priority": "high",
    "executor": "claude-code",
    "dependsOn": [],
    "timeoutSeconds": 600
  },
  {
    "id": "task-2",
    "persona": "tester",
    "task": "Write tests for auth",
    "priority": "medium",
    "dependsOn": ["task-1"]
  }
]
```

Hierarchical delegation is available through an optional `delegation` block on each task:

```json
{
  "id": "implementation-safe",
  "executor": "claude-code",
  "task": "Implement the parser cleanup and synthesize the result.",
  "delegation": {
    "mode": "auto",
    "maxChildren": 2,
    "writeScopes": [
      { "childId": "parser-a", "paths": ["src/parser/a.ts"] },
      { "childId": "parser-b", "paths": ["src/parser/b.ts"] }
    ]
  }
}
```

- `mode: "auto"` enables executor-side self-decomposition when policy allows it.
- Mutation tasks require disjoint `writeScopes`; otherwise they are forced to remain leaf tasks.
- Results now persist parent/child telemetry, including `delegated`, `effectiveExecutor`, `childRecords`, and artifact lists.

Example status output for a completed hierarchical run:

```text
🔍 Swarm Status: hierarchical-broader-validation-test
   Status: complete
   Results: ~/.swarm/results/hierarchical-broader-validation-test.json
   Outcome: 4/4 succeeded, 0 failed
   Duration: 4s
   Delegated: 3 parent / 5 child
   Artifacts: 4
   Reroutes: 1
   Executors: hermes, claude-code
```

For a complete comparison of transports, tools, delegation support, model routes, and indexed SDKs, see the [executor capability matrix](./docs/executors/capability-matrix.md).

## Routing Strategies

| Strategy | Best For | Weight Focus |
|----------|----------|--------------|
| `fast` | Quick iterations | Complexity fit (40%), Health (20%) |
| `reliable` | Production tasks | Health (35%), History (18%) |
| `balanced` | General use | Even distribution |
| `explore` | New domains | Capability (35%), Complexity (18%) |

## Circuit Breaker States

- **CLOSED** — Normal operation, requests pass through
- **OPEN** — Failure threshold exceeded, requests blocked
- **HALF_OPEN** — Testing if service recovered

## Executor Registry

Create `~/.zouroboros/executors.json`:

```json
{
  "executors": [
    {
      "id": "claude-code",
      "name": "Claude Code",
      "executor": "local",
      "bridge": "bridges/claude-code-bridge.sh",
      "expertise": ["code-generation", "debugging", "refactoring"],
      "bestFor": ["Complex multi-file changes"]
    }
  ]
}
```

## License

MIT
