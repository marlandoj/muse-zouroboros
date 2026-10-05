> **Compatibility repository.** Executor policy lives in [zouroboros-workspace/packages/swarm](https://github.com/marlandoj/zouroboros-workspace/tree/main/packages/swarm). Bridges and registry tools forward there; `registry/executor-registry.json` is a byte-identical generated copy. Edit the package registry, then run `bun packages/swarm/scripts/sync-runtime-copies.ts --write` from the complete workspace. Do not edit the generated copy.

---

# Zouroboros Swarm Executors

> Turn any CLI tool into a first-class AI persona on [Zo Computer](https://zo.computer). Each executor gets consistent identity, shared memory, and full swarm integration through a simple bash bridge script.
>
> Part of the [Zouroboros](https://github.com/marlandoj/zouroboros) ecosystem — self-improving AI development tools for Zo Computer.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

---

## What This Is

This skill manages the local executors that power the [zouroboros-swarm-orchestrator](https://github.com/marlandoj/zouroboros-swarm-orchestrator). Instead of routing every task through a remote API, the orchestrator can send work to CLI tools running on your machine:

- **7 Active CLI Executors** -- Claude Code, Hermes, Gemini, Codex, OpenCode, Kimi, and Pi. Cursor is deferred; Mimir is service metadata, not an active CLI transport
- **Shared Identity** -- All executors read the same SOUL.md, IDENTITY files, and memory system as API personas
- **Simple Interface** -- A bridge script accepts a prompt on stdin and returns text on stdout. That's the whole contract
- **Health Checks** -- Doctor script validates all bridges, environment variables, and CLI tools
- **Custom Executors** -- Add your own CLI tool as an executor with a template bridge script and a registry entry

Hermes runs through native ACP by default using `hermes acp --accept-hooks`, which provides streamed output, tool events, cancellation, and session-local model selection. Set `HERMES_ACP_ENABLED=0` only for temporary bridge rollback. The v1 routing boundary keeps Hermes focused on research, audit, investigation, security, summarization, and tool orchestration rather than code generation.

### Available Executors

| Executor | CLI Tool | Speed | Good at |
|----------|----------|-------|---------|
| Claude Code | `claude` | ~25-120s | Complex multi-file changes, codebase analysis, git operations |
| Hermes | `hermes` | ~15-60s | Web research, security audits, data gathering |
| Gemini | `gemini` | ~2-12s (daemon) | Large-context analysis (1M+ tokens), multimodal tasks |
| Codex | `codex` | ~3s | Fast code generation, shell commands, rapid prototyping |
| OpenCode | `opencode` | ~10-120s | Vendor-neutral provider/model routing, repository-aware implementation |
| Kimi | `kimi` | provider-dependent | Native ACP, large-context coding, multimodal tasks, MCP forwarding |
| Pi | `pi` | provider-dependent | Minimal-harness coding, focused implementation, model comparisons |
| Cursor (deferred) | `cursor-agent` | provider-dependent | Cursor rules, repository-aware implementation, MCP-enabled coding |

---

## Quick Start

There are two ways to use executors: through the **Zo chat window** (natural language) or the **terminal** (direct commands).

### Option 1: Natural Language via Zo Chat

You don't need to call bridge scripts directly. The swarm orchestrator routes tasks to executors automatically. Just describe what you need:

```
Run a security audit on my project using a swarm.
Use Claude Code for the code review and Hermes for the web research.
```

You can also call individual executors:

- *"Ask Claude Code to review src/auth.ts for security issues"*
- *"Use Hermes to research the top 5 competitors to Acme Corp"*
- *"Have Codex generate a rate-limiting middleware for Express.js"*
- *"Ask Gemini to analyze this 500-page PDF"*

Zo selects the registered ACP or bridge transport and handles the invocation.

### Option 2: Terminal (Direct Bridge Calls)

#### Call an executor directly

```bash
# Ask Claude Code to review a file
bash Skills/zo-swarm-executors/bridges/claude-code-bridge.sh \
  "Review src/auth.ts for security issues"

# Research with Hermes
bash Skills/zo-swarm-executors/bridges/hermes-bridge.sh \
  "Find the top 5 competitors to Acme Corp and summarize their pricing"

# Fast code generation with Codex
bash Skills/zo-swarm-executors/bridges/codex-bridge.sh \
  "Create a rate-limiting middleware for Express.js"

# Large-context analysis with Gemini
bash Skills/zo-swarm-executors/bridges/gemini-bridge.sh \
  "Summarize the key points from this 200-page document"
```

#### Check executor health

```bash
cd Skills/zo-swarm-executors
bun scripts/doctor.ts
```

#### Run integration tests

```bash
bun scripts/test-harness.ts
```

---

## Using Executors with the Swarm Orchestrator

The orchestrator discovers executors through the registry file. When a task's persona matches a local executor, it routes the task to the bridge script instead of the API.

### Example: Website review with mixed executors

Create a task file (`tasks/site-review.json`):

```json
[
  {
    "id": "plan",
    "persona": "product-manager",
    "task": "Create a review plan for the e-commerce site at example.com"
  },
  {
    "id": "security",
    "persona": "claude-code",
    "task": "Audit the codebase for security vulnerabilities",
    "dependsOn": ["plan"]
  },
  {
    "id": "research",
    "persona": "hermes",
    "task": "Research competitor sites and compare features",
    "dependsOn": ["plan"]
  },
  {
    "id": "synthesis",
    "persona": "technical-writer",
    "task": "Combine all findings into a final report",
    "dependsOn": ["security", "research"]
  }
]
```

Run it:

```bash
cd Skills/zo-swarm-orchestrator/scripts
bun orchestrate-v4.ts ../tasks/site-review.json --swarm-id site-review
```

The `product-manager` and `technical-writer` tasks go to the API. The `claude-code` and `hermes` tasks run locally through bridge scripts. The orchestrator handles routing automatically.

Or via Zo chat:

```
Run the swarm task file at Skills/zo-swarm-orchestrator/tasks/site-review.json
```

---

## Adding Your Own Executor

You can turn any CLI tool into a swarm executor in two steps.

### Step 1: Create a bridge script

Use the template as a starting point:

```bash
cp Skills/zo-swarm-executors/bridges/template-bridge.sh \
   Skills/zo-swarm-executors/bridges/my-tool-bridge.sh
chmod +x Skills/zo-swarm-executors/bridges/my-tool-bridge.sh
```

Edit the script. The contract is simple: accept a prompt as `$1`, return text on stdout.

```bash
#!/usr/bin/env bash
set -euo pipefail

PROMPT="${1:?Usage: my-tool-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-/home/workspace}"
TIMEOUT="${MY_TOOL_TIMEOUT:-300}"

cd "$WORKDIR"
timeout "$TIMEOUT" my-tool --prompt "$PROMPT" 2>/dev/null
```

### Step 2: Register in the executor registry

Add an entry to `registry/executor-registry.json`:

```json
{
  "id": "my-tool",
  "name": "My Tool",
  "executor": "local",
  "bridge": "Skills/zo-swarm-executors/bridges/my-tool-bridge.sh",
  "expertise": ["my-domain"],
  "best_for": ["tasks my tool excels at"],
  "healthCheck": {
    "command": "command -v my-tool",
    "expectedPattern": "my-tool"
  }
}
```

Or via Zo chat:

```
Register a new executor called "My Tool" for the swarm.
The bridge script is at Skills/zo-swarm-executors/bridges/my-tool-bridge.sh.
It's good at my-domain tasks.
```

---

## Environment Variables

| Variable | Bridge | Default |
|----------|--------|---------|
| `SWARM_RESOLVED_MODEL` | all | OmniRoute combo/model, or CLI default |
| `CLAUDE_CODE_MODEL` | claude-code | CLI default (Opus 4.6) |
| `CLAUDE_CODE_TIMEOUT` | claude-code | 600s |
| `HERMES_PROJECT_DIR` | hermes | `/home/workspace/hermes-agent` |
| `GEMINI_MODEL` | gemini | `gemini-2.5-flash` |
| `GEMINI_NO_DAEMON` | gemini | `0` (daemon enabled) |
| `CODEX_MODEL` | codex | `gpt-5.2-codex` |
| `OPENROUTER_API_KEY` | kimi/pi | Required for the verified default Kimi K3 route |
| `KIMI_MODEL_API_KEY` | kimi | Optional explicit provider key |
| `KIMI_MODEL_BASE_URL` | kimi | Optional OpenAI-compatible provider base URL |
| `KIMI_MODEL_NAME` | kimi | `moonshotai/kimi-k3` |
| `KIMI_TIMEOUT` | kimi | `600s` |
| `PI_MODEL` | pi | `openrouter/moonshotai/kimi-k3` |
| `PI_TIMEOUT` | pi | `600s` |

---

## Model Routing via OmniRoute

> Powered by [OmniRoute](https://github.com/diegosouzapw/OmniRoute) — a unified AI proxy/router for multi-provider LLM aggregation.

When used with the [zouroboros-swarm-orchestrator](https://github.com/marlandoj/zouroboros-swarm-orchestrator) (v4.7+), each bridge receives a `SWARM_RESOLVED_MODEL` env var that tells it which OmniRoute combo or model to use. The orchestrator picks this based on the task's complexity tier — trivial tasks get cheap models, complex tasks get powerful ones.

### Fallback chain per bridge

Each bridge reads the model in this priority order:

| Bridge | Priority 1 | Priority 2 | Priority 3 |
|--------|-----------|-----------|-----------|
| claude-code | `SWARM_RESOLVED_MODEL` | `CLAUDE_CODE_MODEL` | CLI default |
| codex | `SWARM_RESOLVED_MODEL` | `CODEX_MODEL` | CLI default |
| hermes | `SWARM_RESOLVED_MODEL` | `LLM_MODEL` | CLI default |
| gemini | `SWARM_RESOLVED_MODEL` | `GEMINI_MODEL` | `gemini-2.5-flash` |

The Gemini bridge has special handling: if the resolved model is an OmniRoute combo (contains `swarm-`), it skips it and falls back to the native Gemini model, since the Gemini CLI talks directly to Google's API rather than through OmniRoute.

### Standalone usage

When calling bridges directly (without the orchestrator), `SWARM_RESOLVED_MODEL` won't be set and the bridge falls through to the executor-specific env var or CLI default. No behavior change for standalone use.

---

## Repository Structure

```
zouroboros-swarm-executors/
├── SKILL.md                         # Skill manifest
├── README.md                        # This file
├── bridges/                         # Bridge scripts (the core interface)
│   ├── claude-code-bridge.sh
│   ├── hermes-bridge.sh
│   ├── gemini-bridge.sh
│   ├── codex-bridge.sh
│   └── template-bridge.sh          # Starting point for custom bridges
├── registry/
│   └── executor-registry.json      # Executor metadata (consumed by orchestrator)
├── scripts/                         # Management tools
│   ├── doctor.ts                   # Health checker for all executors
│   ├── test-harness.ts             # Integration tester
│   └── register.ts                 # Register new executors
├── types/                           # TypeScript interfaces
└── docs/
    └── BRIDGE_PROTOCOL.md          # Full protocol specification
```

---

## How the Bridge Protocol Works

Every bridge script follows the same contract:

```
Input:  bash bridge.sh "prompt" [workdir]
Output: plain text on stdout
Errors: stderr + non-zero exit code
```

The bridge handles binary resolution, timeout enforcement, output cleanup, and environment setup. The orchestrator (or you) doesn't need to know how the CLI works internally. Just send a prompt, get text back.

---

## Related Skills

- [zouroboros-swarm-orchestrator](https://github.com/marlandoj/zouroboros-swarm-orchestrator) -- The orchestrator that routes tasks to these executors
- [zouroboros-memory-system](https://github.com/marlandoj/zouroboros-memory-system) -- Shared memory that all executors can read and write
- [zouroboros-persona-creator](https://github.com/marlandoj/zouroboros-persona-creator) -- Create personas that can be assigned to executors

---

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/my-improvement`)
3. Commit your changes
4. Push to the branch (`git push origin feature/my-improvement`)
5. Open a Pull Request

---

## License

MIT License -- Use freely, commercially or personally.
