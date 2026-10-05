# Zouroboros Factory

The governed Zouroboros software-factory conveyor, packaged for installation
into another Zouroboros checkout.

## Install

From a checkout where the Zouroboros packages are already installed:

```bash
pnpm --filter zouroboros-factory exec zouroboros-factory install --root /path/to/zouroboros
source /path/to/zouroboros/Projects/zouroboros-software-factory/factory.env
zouroboros-factory doctor --root /path/to/zouroboros
zouroboros-factory smoke --root /path/to/zouroboros
```

The installer materializes the factory under
`Projects/zouroboros-software-factory`, initializes an independent state root,
and writes a fail-closed runtime configuration. Every execution, filing,
promotion, model-review, and auto-merge lane is off by default.

The package includes runtime scripts, contracts, fixtures, scenarios, and the
operator documentation. It deliberately excludes live state, evaluations,
incident reports, serial-promotion records, machine-specific executor config,
and experiment artifacts.

## Commands

- `zouroboros-factory install --root <checkout>` installs or updates the factory.
- `zouroboros-factory doctor --root <checkout>` validates required files, state,
  configuration, and optional Zouroboros integrations.
- `zouroboros-factory smoke --root <checkout>` installs into a temporary clean
  checkout and runs the deterministic one-queue, one-worker MVP lifecycle.
- `zouroboros-factory package-check` validates the publishable package boundary.

`install --force` updates packaged code but preserves an existing
`config/runtime-flags.json`. Replacing operator configuration requires the
separate `--reset-config` flag.

## Activation boundary

Installation does not create a scheduler, automation, service, or Linear/GitHub
credential. After the smoke test passes, follow `OPERATORS_MANUAL.md` to wire a
concrete conveyor trigger and enable capabilities one at a time. Human approval,
held-out verification, and fail-closed governance remain mandatory.
