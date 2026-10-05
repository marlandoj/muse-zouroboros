---
name: zo-swarm-executors
description: Local executor system for zo-swarm-orchestrator — manages ACP and bridge transports, health checks, and registry metadata for Claude Code, Hermes, Gemini, Codex, OpenCode, Kimi, and Pi agents.
version: 2.0.0
author: marlandoj
tags:
  - swarm
  - orchestration
  - local-executors
  - bridge-scripts
  - claude-code
  - hermes
  - gemini
  - codex
  - opencode
  - kimi
  - pi
related_skills:
  - zo-swarm-orchestrator
  - zo-memory-system
---

# zo-swarm-executors

Local executor system for the [zo-swarm-orchestrator](../zo-swarm-orchestrator/). Manages bridge scripts, executor registry, and health checks for AI agents that run directly on the machine.

## Quick Start

```bash
cd /home/workspace/Skills/zo-swarm-executors

# Check executor health
bun scripts/doctor.ts

# Integration test (sends test prompt through each bridge)
bun scripts/test-harness.ts

# List registered executors
bun scripts/register.ts list

# Validate registry schema
bun scripts/register.ts validate
```

## Available Executors

| ID | Name | Swarm transport | Speed | Best For |
|----|------|--------|-------|----------|
| `claude-code` | Claude Code | `bridges/claude-code-bridge.sh` | ~25-120s | Code implementation, file editing, git operations |
| `hermes` | Hermes Agent | `hermes acp --accept-hooks` | ~15-60s | Web research, security audits, multi-tool investigation |
| `gemini` | Gemini CLI | `bridges/gemini-bridge.sh` | ~2-12s (daemon) | Large-context analysis (1M+ tokens), multimodal tasks |
| `codex` | Codex CLI | `bridges/codex-bridge.sh` | ~3s | Fast code generation, shell commands, rapid prototyping |
| `opencode` | OpenCode CLI | `opencode acp --pure` | provider-dependent | Model-neutral code execution across task-scoped providers |
| `kimi` | Kimi Code CLI | `kimi acp` | provider-dependent | Large-context coding, multimodal work, MCP-enabled sessions |
| `pi` | Pi Coding Agent | `bridges/pi-bridge.sh` | provider-dependent | Minimal-harness coding and model comparisons |

## Bridge Protocol

Bridges are shell scripts that wrap a local AI agent for orchestrator invocation:

```bash
bash <bridge> "<prompt>" [workdir]
# stdout = clean text response
# stderr = diagnostics
# exit 0 = success, non-zero = failure
```

See [docs/BRIDGE_PROTOCOL.md](docs/BRIDGE_PROTOCOL.md) for the full specification.

## Integration with zo-swarm-orchestrator

The orchestrator reads `registry/executor-registry.json` to discover local executors. Set the registry path via:

```bash
export SWARM_EXECUTOR_REGISTRY=/home/workspace/Skills/zo-swarm-executors/registry/executor-registry.json
```

Or let the orchestrator use its default path: `Skills/zo-swarm-executors/registry/executor-registry.json` relative to `SWARM_WORKSPACE`.

## Adding a Custom Executor

1. Copy `bridges/template-bridge.sh` and implement your executor
2. Create a JSON file with executor metadata (see `executor-registry.json` for schema)
3. Register: `bun scripts/register.ts add my-executor.json`
4. Verify: `bun scripts/doctor.ts --executor my-executor`

## Environment Variables

| Variable | Bridge | Default |
|----------|--------|---------|
| `CLAUDE_CODE_BIN` | claude-code | Auto-detected |
| `CLAUDE_CODE_MODEL` | claude-code | CLI default (Opus 4.6) |
| `CLAUDE_CODE_TIMEOUT` | claude-code | `600`s |
| `HERMES_PROJECT_DIR` | hermes | `/home/workspace/hermes-agent` |
| `HERMES_VENV` | hermes | `$HERMES_PROJECT_DIR/.venv/bin/activate` |
| `HERMES_TIMEOUT` | hermes | `300`s |
| `HERMES_ACP_ENABLED` | hermes | `1`; set `0` for bridge rollback |
| `GEMINI_MODEL` | gemini | `gemini-2.5-flash` |
| `GEMINI_TIMEOUT` | gemini | `300`s |
| `GEMINI_NO_DAEMON` | gemini | `0` (daemon enabled) |
| `CODEX_MODEL` | codex | `gpt-5.4` |
| `CODEX_TIMEOUT` | codex | `300`s |
| `SWARM_OPENCODE_ENABLED` | opencode | `0`; set `1` for automatic swarm routing |
| `SF_OPENCODE_ENABLED` | opencode | `0`; set `1` for the Software Factory chain |
| `OPENROUTER_API_KEY` | kimi/pi | Required for the verified default Kimi K3 route |
| `KIMI_MODEL_API_KEY` | kimi | Optional explicit provider key |
| `KIMI_MODEL_BASE_URL` | kimi | Optional OpenAI-compatible provider base URL |
| `KIMI_MODEL_NAME` | kimi | `moonshotai/kimi-k3` |
| `KIMI_TIMEOUT` | kimi | `600`s |
| `PI_MODEL` | pi | `openrouter/moonshotai/kimi-k3` |
| `PI_TIMEOUT` | pi | `600`s |
| `SWARM_WORKSPACE` | all | `/home/workspace` |
| `SWARM_EXECUTOR_REGISTRY` | all | `Skills/zo-swarm-executors/registry/executor-registry.json` |
