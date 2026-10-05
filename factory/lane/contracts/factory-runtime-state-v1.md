# Factory Runtime State Contract v1

## Authority

`FACTORY_STATE_DIR` is the single production namespace for mutable Zouroboros Software Factory
state. Source checkouts and immutable runtime trees contain code and configuration only; they do
not own production state or dependencies from another runtime.

## Root Identity

A production root must be an absolute canonical directory outside every checkout and conveyor
runtime. It must not be a symlink and must contain `.factory-state-root.json` with:

- `namespace: "zouroboros-software-factory"`
- `schema_version: 1`
- a UUID `root_id`
- its exact `canonical_path`
- a nonnegative integer `generation`
- the root directory device number
- an ISO-8601 `created_at` timestamp

Missing, malformed, mismatched, runtime-contained, or symlinked roots fail before file access. Path
segments may not be absolute or contain traversal. Production feature overrides must remain below
the canonical root.

## Compatibility And Tests

Runtime-relative fallback exists only when `FACTORY_STATE_MODE=compatibility`. Test fixtures use
`FACTORY_STATE_MODE=test`; outside-root fixture injection additionally requires
`FACTORY_STATE_ALLOW_OUTSIDE_ROOT=1`. The activation manifest must set production mode and forbid
both exceptions.

## Ownership

`config/factory-state-owners-v1.json` is the checked-in owner registry. Every production or reporting
module that reads or writes factory state must be registered with its access class, subpaths, and
locking discipline and must resolve paths through `scripts/factory-state-root.ts`.

## Migration

Live migration requires a separately approved manifest. The allowed operation is a quiesced,
same-filesystem atomic rename of the incumbent physical root, followed by identity-marker binding,
digest verification, and a temporary compatibility link. Online copy, dual writes, destination
overwrite, cross-device cutover, and rollback to stale state are forbidden. Rollback changes the
runtime or path binding while preserving the forward-moving state root.

## Dependencies

Detached runtimes use `pnpm@8.15.0` with the repository workspace lock. Materialization is offline,
frozen, and scriptless. Workspace links must remain inside the candidate runtime; dependency links
may not target another runtime. Two materializations must have equal normalized dependency graphs
and leave tracked files unchanged before a runtime may be qualified.
