# Bridge Protocol Specification

**Version:** 1.0.0

A bridge script is the interface between the zo-swarm-orchestrator and a local executor (an AI agent running directly on the machine rather than via a remote API).

## Contract

### Invocation

```bash
bash <bridge-script> "<prompt>" [workdir]
```

| Argument | Required | Description |
|----------|----------|-------------|
| `$1` | Yes | The full prompt text |
| `$2` | No | Working directory (default: `/home/workspace`) |

### Output

| Channel | Content |
|---------|---------|
| `stdout` | Clean text response — no banners, chrome, progress indicators, or formatting wrappers |
| `stderr` | Diagnostics, error messages, and debug output |

### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success — stdout contains the response |
| Non-zero | Failure — stderr contains error details |

### Environment

- The bridge inherits the **full parent environment** from the orchestrator process.
- Bridges should respect executor-specific env vars (documented in `executor-registry.json`).
- Bridges may unset or override env vars needed for their runtime (e.g., `unset CLAUDECODE`).

### Timeout

- The orchestrator enforces an external timeout on bridge invocations.
- Bridges should also implement an internal safety timeout as a fallback.
- Default timeout is specified per-executor in `executor-registry.json` (`config.defaultTimeout`).

## Shell Requirements

Every bridge script MUST:

1. Start with `#!/usr/bin/env bash`
2. Include `set -euo pipefail`
3. Be executable (`chmod +x`)
4. Validate that `$1` is provided
5. Return only clean text on stdout
6. Return diagnostics on stderr
7. Exit 0 on success, non-zero on failure

## Minimal Template

```bash
#!/usr/bin/env bash
set -euo pipefail

PROMPT="${1:?Usage: my-bridge.sh \"prompt\" [workdir]}"
WORKDIR="${2:-/home/workspace}"

cd "$WORKDIR"

# Invoke your executor here, capturing only the response on stdout
my-executor --prompt "$PROMPT" --format text

exit $?
```

## Integration with the Orchestrator

The orchestrator calls bridges via `Bun.spawn()`:

```typescript
const proc = Bun.spawn(["bash", executor.bridge, prompt], {
  stdout: "pipe",
  stderr: "pipe",
  cwd: WORKSPACE,
  env: process.env,
});

const response = await new Response(proc.stdout).text();
const exitCode = await proc.exited;
```

Bridge paths in the registry are relative to `WORKSPACE` and resolved at runtime:

```
bridge: "Skills/zo-swarm-executors/bridges/claude-code-bridge.sh"
→ /home/workspace/Skills/zo-swarm-executors/bridges/claude-code-bridge.sh
```

## Best Practices

1. **Strip output chrome** — LLM CLIs often emit banners, spinners, or progress bars. Use `sed`, `grep`, or output format flags to return only the response text.

2. **Isolate environment** — Unset env vars that could interfere with nested invocations (e.g., `unset CLAUDECODE` to allow Claude Code to spawn from within a Claude Code session).

3. **Log to stderr** — Any diagnostic output (timing, debug info, error context) goes to stderr so stdout stays clean.

4. **Fail loudly** — If prerequisites are missing, emit a clear error to stderr and exit non-zero immediately.

5. **Support configuration** — Use environment variables for paths, timeouts, and model selection rather than hardcoding values.
