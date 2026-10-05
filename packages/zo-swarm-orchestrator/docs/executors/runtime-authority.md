# Executor registry and campaign runtime authority (RB-2 / RB-37)

## Decision

`packages/swarm/` owns executable policy. The authoritative executor registry is
`src/executor/registry/executor-registry.json`; the authoritative CC campaign
runtime is `scripts/orchestrate-v5.ts`. This keeps the deployed CC path, RB-23
model routing, hierarchical execution, and shared plan gate together.

The native `src/orchestrator.ts` class and published CLI remain the package API.
They use the same registry loader but are not copies of the CC v5 script.

## Registry resolution

`src/registry/loader.ts::resolveExecutorRegistryPath` is shared by the factory
loader, CC v5, both package doctors, registry management, bridge harness, and
the legacy benchmark and hybrid launcher.

| Precedence | Selection |
| --- | --- |
| 1 | Explicit registry argument, then `SWARM_EXECUTOR_REGISTRY` |
| 2 | Canonical registry beneath an explicit workspace argument, `SWARM_WORKSPACE`, or `ZOUROBOROS_WORKSPACE_ROOT` |
| 3 | Registry shipped alongside the installed package loader (source or `dist`) |

Relative registry overrides resolve beneath the selected workspace. A missing
explicit registry never falls back to a different executor tree. The loader
returns an empty registry; doctors report the missing file. There is no implicit
fallback to `Skills/zo-swarm-executors/registry/` or `.zouroboros/executors.json`.
Existing custom registries can still be selected explicitly.

The Skills registry is a byte-identical generated compatibility copy. Edit the
package registry and regenerate it; do not maintain a second set of policies.
The merge retains packaged SDK/capability metadata, Pi MCP support, and Kimi's
relative adapter path, plus the live Claude/Gemini routing maps and OpenCode MCP
and Software Factory rollout metadata. Bridge paths point directly to RB-36's
canonical package implementations.

Seven CLI executors remain active. Cursor is deprecated and removed. The complete Mimir
entry is preserved under `services`: its `mimir` transport has no CLI transport
factory, so it must not be advertised as an executable CLI. OpenCode's existing
ACP transport and rollout gates are preserved; consolidation does not add a
bridge fallback to its registry entry.

## Compatibility entry points

`scripts/sync-runtime-copies.ts` generates forwarding entry points for:

- Both `orchestrate-v5.ts` and historical `orchestrate-v5-backup.ts` under
  `src/standalone/` and `Skills/zouroboros/skills/swarm/scripts/`.
- Standalone MCP stdio/HTTP servers and the hybrid launcher.
- The archived orchestrator submodule’s v5, backup, MCP, and hybrid entry points.
- The executor submodule’s doctor, register, and bridge harness tools.

These forwarders load code from the nearest containing workspace, preserving
arguments, environment, working directory, and process exit behavior. An export
outside the workspace needs `ZOUROBOROS_WORKSPACE_ROOT` to locate the full source
workspace. `scripts/export-skills.sh` copies the forwarders, not another runtime.
CC v5 is a workspace tool; the published package CLI remains usable from `dist`.

The historical standalone dependency-failure implementation is retired along
with its runtime: per-task `onDependencyFailure`, `taskType`, and
`maxRetriesOnDegraded` are not CC v5 configuration. Use the canonical campaign
options documented by `orchestrate-v5.ts`. Standalone-only health filtering and
routing stubs also retire; execution follows the CC path's preflight and retry
rules. Trace ID forwarding and trace-outcome capture are retained.

MCP launchers now use the package script directory, positional campaign path,
`--swarm-id`, and `--concurrency`. They read results from the runtime's
`$HOME/.swarm/results` directory.

## Success gate

RB-37 is resolved by forwarding all v5 entry points to one implementation.
`src/executor/bridge-output.ts` rejects whitespace-only output, HTTP 4xx/5xx
responses, and `BRIDGE_ERROR` on stderr before success is recorded. The same
gate covers JSON result files and plain stdout, including the former plain-text
HTTP-error gap. Valid structured results still preserve delegation and artifact
metadata. Regression campaigns verify result status and the success counters in
executor history through every v5 entry point without invoking any real model.

## Regeneration and deployment

```sh
bun packages/swarm/scripts/sync-runtime-copies.ts --write
bun packages/swarm/scripts/sync-runtime-copies.ts --require-submodules
```

The default check skips uninitialized private submodules in CI; the strict check
is required on the deployed workspace. Runtime-forwarder drift is always checked
by the package tests. Publish canonical workspace changes before merging the
generated executor-registry and orchestrator compatibility copies, then update the workspace
gitlink and run both this strict check and RB-36's strict bridge-shim check.
