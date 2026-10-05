# Bridge authority (RB-36)

Edit executable bridge implementations only in
`packages/swarm/src/executor/bridges/`. The package build copies the shell
scripts and Pi MCP bootstrap into `dist/executor/bridges/`. Legacy entry points
forward arguments, environment, working directory, output, and exit status to
the canonical source; they contain no model or CLI policy.

| Entry point | Role after consolidation |
|---|---|
| `packages/swarm/src/executor/bridges/*-bridge.sh` | Canonical implementations; Cursor remains available for explicit custom registries |
| `Skills/zo-swarm-executors/bridges/{claude-code,codex,gemini,hermes,kimi,opencode,pi}-bridge.sh` | Generated forwarders to the corresponding canonical implementation |
| `packages/swarm/scripts/claude-code-bridge.sh` | Generated Claude forwarder |
| `Skills/zo-swarm-orchestrator/scripts/claude-code-bridge.sh` | Generated Claude forwarder; obsolete `--yolo` invocation removed |
| `Projects/zourobench-2026/hal-adapter/src/runners/claude-cli-direct.ts` | Resolves the canonical Claude bridge relative to its module, independent of the checkout path |

The four Claude paths now have one implementation. Template scripts are examples
for authoring bridges, not active executors. Registry authority is tracked
separately under RB-2.

## Preserved behavior and model contract

- Claude imports the live executor version's JSON result extraction, token/cost
  metrics, built-in web tool permissions, and explicit `claude-opus-5` default.
- Gemini imports the live headless workspace-trust setting; executable mode is
  restored on the packaged script (RB-42 overlap).
- Codex, Kimi, and Hermes start from the identical packaged/live implementations.
  OpenCode's formerly Skills-only bridge is imported into the canonical tree.
- Pi retains the packaged MCP bootstrap, adapter configuration, session briefing,
  and OpenRouter default. The stale `--approve` flag is removed: the installed Pi
  help does not declare it and `pi-mcp-adapter@2.15.0` registers `mcp-config`, not
  `approve`. The old Skills copy lacked the MCP path and used a different default.
- The shared model router owns tier-to-model resolution (RB-23). Claude, Codex,
  and Gemini accept concrete models. Tier labels reaching these bridges produce
  `BRIDGE_WARN` and the executor default rather than another tier map. Claude's
  fallback `tier-resolve.ts` invocation is removed. Per-tier timeouts are unchanged.
- Hermes remains the provider-relative exception. Its Anthropic subscription
  pinning and provider fallback behavior are unchanged; it may translate its
  native tier vocabulary within that provider contract.

Import provenance: live executors commit
`b2eb3159acee0b2ee428ac3aa065d74c08bcaca1`, workspace base
`b2a8678a41fb7eaa0331c8d4f3dc99a55be103d9`. The obsolete orchestrator repo is
already marked deprecated in favor of the monorepo.

## Credential provisioning

Provider credentials are supplied by the caller. On the VPS, CC receives them
from its service environment and its children inherit them. Bridges do not
source `cc.env`. Existing shared MCP-secret loading from `zouroboros.env` is
preserved; it is not the Kimi/OpenRouter credential source.

Kimi's credential-mapping block deliberately consumes the inherited environment
before loading shared MCP secrets. A direct caller must supply its own provider
environment. RB-36 clarifies this in a comment without expanding file access or
moving the mapping block.

## Updating compatibility paths

Run `bun packages/swarm/scripts/sync-bridge-shims.ts --write` after initializing
the executor and orchestrator submodules. Commit generated changes in their own
repositories, review each full diff, then update the parent gitlinks through a
workspace PR. The checker never silently changes files.

CI tests the local forwarder and materializes every forwarder in a temporary
workspace to verify argument quoting, working directory, stdout/stderr, and exit
status. It also checks initialized submodules for drift. CI checkouts without
those private submodules skip their on-disk checks; the deployed workspace must
run the strict check:

```bash
bun packages/swarm/scripts/sync-bridge-shims.ts --require-submodules
```

Merge/deploy order: canonical workspace implementation first, compatibility PRs
in the two submodules second, parent gitlink update third. A standalone checkout
of a compatibility repo needs the complete workspace or an explicit
`ZOUROBOROS_WORKSPACE_ROOT`; missing implementations fail with an actionable
error. Rollback uses the recorded parent commit and its submodule SHAs together.
