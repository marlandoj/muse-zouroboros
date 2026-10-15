# plan-gate (vendored)

Vendored from the Zouroboros monorepo `packages/workflow/src/plan-gate/`
(commit `25c750bf`) because the npm-published `zouroboros-workflow@2.1.1`
predates the `plan-gate` subpath export and this package must be
self-contained for a fresh public-package clone.

Consumers in this package import via `./plan-gate/index.js` instead of
`zouroboros-workflow/plan-gate`. Keep this directory in sync with the
monorepo source when plan-gate changes (per the standing rule that
vendored code is ported in both directions).
