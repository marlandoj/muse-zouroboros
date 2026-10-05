# Walkthrough 02 — Core install

## Run the bootstrap

```bash
cd ~/workspace/zouroboros-for-muse
bash scripts/bootstrap.sh
```

What it does, in order:

1. Checks for `bun`, `node` (22+), `python3` (3.11+), `git`, `jq` — stops
   with a clear message if anything is missing.
2. Creates `~/.zo/memory`, `~/.config/zouroboros`, `~/.wayfinder` with
   owner-only permissions.
3. Expands `$HOME` in
   `packages/zo-swarm-orchestrator/src/executor/registry/executor-registry.json`
   to your home directory (the vendored copy ships with `$HOME`
   placeholders; the installer writes a working copy — your edits to the
   working copy are yours, the vendored one stays pristine).
4. Writes `~/.config/zouroboros/workshop.env` with the paths the components
   expect (`ZO_MEMORY_DB`, `SWARM_EXECUTOR_REGISTRY`, `SWARM_WORKSPACE`) and
   sources it from your shell profile.
5. Installs package dependencies where needed (`bun install` in the memory
   system and orchestrator; `pip install` of wayfinder's requirements into
   the user site).
6. Prints a summary of what it did and what's still manual (MCP wiring,
   hook installs — those are steps 03 and 05, because they deserve your
   attention, not a script's).

The script is idempotent — run it again any time; it won't clobber your
registry edits or your database.

## What lands where

| Path | What |
|---|---|
| `~/.zo/memory/` | The memory database and persona files (created; populated in step 03) |
| `~/.config/zouroboros/` | `apis.env` (your keys), `model.env` (per-workload model overrides), `workshop.env` (paths) |
| `~/.wayfinder/` | Wayfinder state (populated in step 05) |
| `packages/zo-swarm-orchestrator/src/executor/registry/executor-registry.json` | Working copy with your `$HOME` expanded |

## Prove it

- [ ] `bash scripts/bootstrap.sh` exits 0
- [ ] `ls -la ~/.zo/memory ~/.config/zouroboros` shows owner-only dirs
- [ ] `echo $ZO_MEMORY_DB` prints your memory DB path in a new shell
- [ ] `grep -c '/home/hatch' packages/zo-swarm-orchestrator/src/executor/registry/executor-registry.json` prints `0`

Next: [03 — Memory](03-memory.md).
