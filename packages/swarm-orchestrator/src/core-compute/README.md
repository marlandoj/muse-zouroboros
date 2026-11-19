# core-compute (vendored)

Vendored from the Zouroboros monorepo `packages/core/src/compute.ts`
(commit `25c750bf`) because the npm-published `zouroboros-core@2.2.0`
predates the `compute` module (execution envelope, routing policy,
`CallbackReplayGuard`) and this package must be self-contained for a
fresh public-package clone.

`src/compute/dispatcher.ts` imports the compute surface from
`./core-compute/compute.js` instead of `zouroboros-core`. Keep this file
in sync with the monorepo source when compute changes (per the standing
rule that vendored code is ported in both directions).
