# Zouroboros Software Factory — Operator's Manual

*How to run the Zouroboros Software Factory with Linear, productively and safely.*
*Version 1.1 · 2026-08-05 · Owner: Marlandoj (operator / sole enablement authority)*

> **De-Zo note (2026-10-05):** this manual predates the de-Zo port. Any
> mention of `/zo/ask` as an "opt-in fallback" is historical — Zo Computer
> no longer exists, so the fallback transport is dead. Dispatch is
> local-harness only (Claude Code / Codex / OpenCode); leave
> `SF_EXEC_ZO_ASK_FALLBACK` unset. See `docs/de-zo-notes.md` in the repo
> root for the full porting record.

---

## 0. Mental model (read this first)

The factory turns **Linear issues into merged, verified pull requests** through a
governed, mostly-autonomous pipeline. Two things never change:

1. **Zouroboros is the sole execution, verification, rollback, and promotion
   authority.** Linear is a *signal surface* — issues, labels, comments, state
   changes. Linear never executes code. A loop or ticket that names any executor
   other than `zouroboros-factory` is rejected mechanically.
2. **Fail closed.** Missing evidence, unknown cost, ambiguous authority, unknown
   states/fields, or unavailable enforcement all resolve to *rejection or a
   non-success terminal state* — never a permissive default.

There are **two ways work enters the factory**:

| Path | Trigger | Status | Use it for |
|---|---|---|---|
| **A. Conveyor** (label-driven pull) | You label a ticket `factory-ready` in the Intake project | **LIVE** | Everyday build work |
| **B. Native Loops** (Linear event-driven) | A Linear webhook/poll event drives an autonomous loop | **PLANNING-STATE / OFF** | Future event automation (just built, not enabled) |

Path A is how you run the factory today. Path B is the integration this project
just delivered — it is built, merged, tested, and deliberately **disabled** until
its enablement preconditions are met (§6).

**New to the factory?** Start with the Minimum Viable Factory Path
(`MVP_PATH.md`, FR-10): one queue, one worker, one worktree, one gate, proven
end-to-end by `bun scripts/factory-mvp.ts smoke` — deterministic, zero model
calls, zero production state. Advanced pool/fleet/auto-merge stay opt-in.

---

## 1. Path A — The Conveyor (how you run the factory today)

### 1.1 The cycle, end to end

```
Linear Intake project
   │  (you label a ticket `factory-ready`)
   ▼
linear-puller.ts ──► pulls factory-ready tickets, REAPs stale labels
   ▼
ticket-contract.ts ──► validates the 5 required contract fields (fail-closed → needs-triage)
   ▼
conveyor-smoke-test.ts ──► health gate (reaps ghost exec records; exit≠0 aborts the cycle)
   ▼
dispatcher.ts ──► decision-gate routes each ticket:
        DIRECT      → execute directly
        SWARM       → full pipeline (interview→seed→eval→execute→post-flight→gap-audit)
        FORCE_SWARM → full pipeline (mandatory)
   ▼
swarm-exec.ts ──► executes in the target repo (executor-first: claude-code→codex→gemini ACP)
   ▼
post-flight eval + 5-question gap audit ──► verify against acceptance criteria
   ▼
PR opened / merged under branch protection ──► Linear writeback (issue → Done)
```

### 1.2 Staging a ticket for the conveyor — the exact steps

A `factory-ready` **label alone is not enough**. Every conveyor ticket needs
three things, or it gets bounced to `needs-triage`:

**Step 1 — Put the issue in the Intake project.**
Intake project id: `b621d7a1-bb3d-4df9-ae11-3034789e204c`. The puller only queries
this project.

**Step 2 — Add the 5-field contract block to the description.**
`ticket-contract.ts` requires exactly these five fields
(`REQUIRED_FIELDS = title, acceptance_criteria, target_repo, archetype, repro`):

```markdown
## Acceptance Criteria
- Criterion 1 (testable)
- Criterion 2 (testable)

## Target Repo
zouroboros            <!-- the repo the factory builds in -->

## Archetype
feature | fix | refactor | infra | docs

## Repro
Steps to reproduce, OR the affected area / context.
```

`title` comes from the issue title itself. The parser accepts YAML frontmatter,
`## Markdown headers`, or `**bold:** inline` fields.

> **GOTCHA (bites silently):** use the header `## Repro` **or** `## Area` — never
> `## Repro / Area`. The spaced-slash variant fails the alias map in
> `ticket-contract.ts` and the ticket is silently rejected to `needs-triage`.
> Accepted aliases: `repro`, `area`, `reproduction`, `repro/area` (no spaces);
> `target_repo`/`target_repository`/`repo`; `acceptance_criteria`/`ac`.

**Step 3 — Apply the `factory-ready` label.**

**Step 4 — Verify before you walk away** (don't trust the label):

```bash
cd /home/workspace/Projects/zouroboros-software-factory/scripts
bun linear-puller.ts | bun ticket-contract.ts --dry-run
```

If the ticket appears under `valid` (not `rejected`), it will be picked up on the
next cycle. If it's under `rejected`, read the missing-field list and fix the
header.

### 1.3 What the factory does with it

- **Routing** is by `dispatcher.ts` decision gate — simple tickets go DIRECT
  (no swarm overhead); complex, independent-workstream tickets go SWARM (full
  spec-interview → seed → seed-eval → execute → post-flight → gap-audit pipeline).
- **Execution** is executor-first via `swarm-exec.ts`: `claude-code → codex →
  gemini` over native ACP, with `/zo/ask` as an opt-in fallback only.
- **Target repo isolation:** the factory persists the canonical `repo_path` in the
  execution record and uses that *same* repo for provenance, execution, review,
  commit selection, worktree, push, and GitHub ops. `/home/workspace` is only the
  authorization boundary; a repo mismatch fails closed.

### 1.4 Ephemeral external compute

Repositories with compute-heavy verification can opt in by checking in
`.factory/external-compute.json`. When `config/external-compute.json` is enabled,
`swarm-exec.ts` runs that manifest on a fresh Hetzner worker before the factory review gate.
The remote result is joined to `git diff --check`; command failure, missing
evidence, or incomplete server/SSH-key teardown blocks verification.

Set `SF_EXTERNAL_COMPUTE=0` on a factory run for the emergency kill switch.
`SF_EXTERNAL_COMPUTE=1` can explicitly enable a run when the durable config is
absent.

The default worker is a `CCX33` with a 60-minute TTL and `$0.50` ceiling. Zo
remains the only conveyor, Linear puller, reviewer, and shipping authority.
The remote host receives only a repository snapshot and returns declared
artifacts plus `evidence.json`.

```bash
cd /home/workspace/packages/hetzner-exec
bun scripts/ephemeral-worker.ts reap --dry-run
```

Do not enable this globally for routine tickets. Use it for repositories whose
checked-in manifest justifies CPU-heavy builds, browser automation, or asset
processing. It is not a GPU certification lane.

#### Binding Hetzner executor requests

The end-to-end executor lane is distinct from verification-only external compute.
An operator can bind an entire Linear ticket to Hetzner with explicit language such as:

```text
execution_target: hetzner-ephemeral
Use Hetzner for this execution.
Hetzner is to be used for the complete build.
```

The title and description are parsed deterministically before SF-003 fan-out. A
binding request never enters the `/zo/ask` pool and never silently falls back to
Zo. Negations such as `Do not use Hetzner` take precedence; incidental mentions
such as comparison or documentation text do not route.

Sizing is controlled by `config/hetzner-executor.json`, not by arbitrary model
output. The current allowlist is:

| Profile | Hetzner type | Capacity | Selection |
|---|---|---|---|
| `small` | `cpx32` | 4 shared vCPU / 8 GiB | Explicit small/docs-only/lint-only work |
| `medium` | `ccx23` | 4 dedicated vCPU / 16 GiB | Default |
| `large` | `ccx33` | 8 dedicated vCPU / 32 GiB | WebGPU, browser, Playwright, graphics, monorepo, or E2E work |

An operator may add `hetzner_profile: small|medium|large` or an allowlisted
`hetzner_size: <server-type>`. Unknown sizes, sizes above the configured maximum,
and GPU/CUDA/NVIDIA requirements fail closed for review. The lane enforces one
active ephemeral worker globally, live price/TTL ceilings, clean isolated
worktrees, patch validation, and positive server plus SSH-key teardown evidence.

`SF_HETZNER_EXECUTOR=0` is the kill switch. Production explicitly sets
`SF_HETZNER_EXECUTOR=1` and `SF_EXEC_ISOLATED_WORKTREE=1`.

### 1.5 Conditional coding cascade

`FACTORY_CODING_CASCADE` controls the SF-003 `/zo/ask` coding pool and the
binding Hetzner implementation lane. It does not change the ordinary
direct/swarm executor chain, review policy, merge authority, or global model
configuration.

| Mode | Behavior |
|---|---|
| `off` | Default. Preserve the incumbent Fable → Kimi → Haiku pool chain and legacy state transitions. |
| `shadow` | Preserve incumbent dispatch and task transitions, but stamp whether the proposed cascade would retry. |
| `enforce` | Use Claude Code - Opus first, Codex GPT-5.6 Sol second, and Kimi K2.7-Code as the final fallback. |

The enforced cascade retries only an assignment timeout, provider transport
failure, or authoritative mechanical validation failure. Persona-review dissent,
operator/authorization denial, policy/configuration failure, unsafe scope,
unclassified worker failure, and exhausted fallback are terminal.

Every enforced attempt requires an explicit target repository and recorded
40-character base commit. The worker creates a separate detached worktree from
that commit for each assignment and proves it is clean before dispatch. A dirty,
missing, escaped, or mismatched worktree parks the task; no later model receives
an earlier attempt's rejected diff. Assignment evidence records requested/resolved model,
repository, base commit, worktree, failure classification, and retry decision.
Cascade worktrees use the factory's append-only worktree ledger. Reclaim them
after ship or review with `bun scripts/swarm-exec.ts --cleanup-worktrees`.

Per-ticket `FACTORY_MODEL_CHAIN` policy blocks still override the default model
chain. Factory review uses deterministic checks plus the independently governed
persona-based Diversity of Thought path; legacy model Consensus remains
operator-only while `FACTORY_MODEL_REVIEW=off`. The cascade never converts
persona dissent or another governance rejection into a solver retry.

Cascade rollback is immediate and migration-free: set
`FACTORY_CODING_CASCADE=off` and restart the owning conveyor process. Persona
review enforcement remains prohibited until its held-out cohort, shadow
production telemetry, constitutional promotion gate, and operator approval pass.

### 1.6 The auto-merge posture (important)

Promotion certification and merge authority are independent. `SF010_CERTIFY=1`
permits one exact Gate 9 → issuer → Gate 10 certification attempt only after an
enforced GitHub selection barrier is proved. It does not enable merging.
`SF010_AUTOMERGE=1` is the separate merge switch; both flags default to `0`.
Keep both off during source qualification. Enabling certification requires a
separate operator decision, a complete `promotion_context`, owner-controlled
authority and attempt ledgers, and protected `main` with strict
`governance-docs` and `build-and-test` checks, stale-review dismissal, the
configured number of GitHub approvals, administrator enforcement, and no
force pushes or branch deletion. The protected single-owner policy currently
configures `required_approving_review_count=0`; that setting is accepted only
with exact request-scoped operator approval, independent provider certification,
and every later promotion gate intact. Missing or drifted protection returns
HOLD before reviewer dispatch.

Certification readiness does not imply merge readiness. With
`SF010_CERTIFY=1` and `SF010_AUTOMERGE=0`, the lane may cross GitHub's review-only
`BLOCKED` state solely when the exact PR is open, non-draft, CI-green with every
check terminal, `mergeable=MERGEABLE`, `reviewDecision=REVIEW_REQUIRED`, and the
live branch policy requires one or more approvals. Certification neither
supplies those approvals nor weakens that policy. Under the protected
single-owner zero-approval policy, an exact open, non-draft, CI-green target with
`mergeStateStatus=CLEAN`, `mergeable=MERGEABLE`, and an empty or `UNKNOWN`
`reviewDecision` may proceed to provider certification in either certification-
only or merge-enabled mode. It still requires exact operator approval, both
provider-native reviews, Gate 10 attestation verification, constitutional
authorization, durable merge intent, confirmed merge, and completion evidence.
If the live branch policy requires one or more approvals, merge authority instead
requires `reviewDecision=APPROVED`; a merge-enabled `BLOCKED` target returns HOLD.

The zero-approval predicate is only a pull-request readiness transition. It never
authorizes promotion, substitutes for a human decision, supplies either provider
approval, or weakens Gate 10 or the constitutional authorization gate. Using this
policy to certify the change that introduces or modifies the policy is an explicit
constitutional transition: the operator must approve the exact ticket, repository,
pull request, head SHA, and evidence digest; the protected selection-barrier object
must be sealed before reviewer dispatch; both independent provider-native reviewers
must approve that same artifact; and constitutional authorization must be consumed
before any durable merge intent. Any absent, stale, mismatched, or rejecting element
returns HOLD with no retry.

For schema version 3, the lane calls the fixed provider-native issuer after Gate 9 and before Gate 10.
The issuer accepts artifact paths and the exact target only; executables, models, prompts, provider
contract, keys, clocks, transport, and retry policy are not request-selectable. It resolves and hashes
the pinned Claude Code launcher and both the Codex JavaScript launcher and native payload, proves the
first-party authentication modes, claims the durable attempt once, then performs exactly one serial
review per harness. Any drift, rejection, timeout, malformed response, Codex tool event, partial pair,
duplicate claim, or verification failure terminalizes the attempt and returns HOLD with no retry.
An explicit reviewer rejection is preserved first as a signed, owner-only `0600`
`zouroboros.provider-native-rejection/v1` receipt next to the requested attestation output. The receipt
binds the attempt, exact target, promotion-evidence digest, rejecting persona identity and prompt/contract
digests, sanitized rationale, cited evidence, findings, and creation time. It never stores raw provider
session or response identifiers, prompts, credentials, envelopes, or tool output. The terminal attempt
ledger entry binds the receipt SHA-256; no attestation is emitted and a later attempt requires a new,
case-specific operator approval and fresh evidence tuple.
Rollback before merge remains operational: restore `SF010_CERTIFY=0` and restart only under separate
runtime authorization. Removing the source candidate alone does not erase a claimed attempt.

The owning conveyor receives promotion context across its process boundary via
`SF010_PROMOTION_CONTEXT_PATH`. Set it only during the separately authorized
certification canary to an absolute, owner-owned `0600` regular file with no
symlink components. The file must contain this execution-bound envelope:

```json
{
  "schema": "zouroboros.promotion-execution-context/v1",
  "executionId": "<exact factory execution id>",
  "ticket": "ZOU-0000",
  "context": {
    "repository": "owner/repository",
    "repoDir": "/absolute/clean/checkout",
    "pullRequest": 123,
    "baseRef": "main",
    "headRef": "work/example",
    "headSha": "<40-character commit>",
    "diff": "<non-empty exact candidate diff>",
    "operatorApprovalPath": "/absolute/operator-approval.json",
    "operatorApprovalKeyPath": "/absolute/operator-approval.key",
    "rollbackEvidencePath": "/absolute/rollback-evidence.json",
    "certificationValidationEvidencePath": "/absolute/certification-validation-evidence.json",
    "personaAttestationPath": "/absolute/persona-attestation.json",
    "personaKeyPath": "/absolute/persona-attestation.key"
  }
}
```

The hook rejects a mismatched execution, ticket, PR, checkout, branch, commit,
missing input, unsafe file, or empty diff before reviewer dispatch. It persists
the validated context into the execution record before Gate 9 issuance; the
durable attempt ledger still makes any restart or replay fail closed.

When the scheduled conveyor must bind the execution ID that `swarm-exec.ts`
mints at runtime, the separately authorized operator may provision a ticket-bound
template instead. The template parent must be an owner-controlled canonical
`0700` directory, the template must be an owner-controlled canonical `0600`
regular file, and `SF010_CERTIFY` must be exactly `1`. The template uses the same
`context` object but contains no execution ID and accepts no lock path, claim
path, retry policy, authority path, provider contract, executable, model, prompt,
transport, or merge authority:

```json
{
  "schema": "zouroboros.promotion-execution-context-template/v1",
  "ticket": "ZOU-0000",
  "context": {
    "repository": "owner/repository",
    "repoDir": "/absolute/clean/checkout",
    "pullRequest": 123,
    "baseRef": "main",
    "headRef": "work/example",
    "headSha": "<40-character commit>",
    "diff": "<non-empty exact candidate diff>",
    "operatorApprovalPath": "/absolute/operator-approval.json",
    "operatorApprovalKeyPath": "/absolute/operator-approval.key",
    "rollbackEvidencePath": "/absolute/rollback-evidence.json",
    "certificationValidationEvidencePath": "/absolute/certification-validation-evidence.json",
    "personaAttestationPath": "/absolute/persona-attestation.json",
    "personaKeyPath": "/absolute/persona-attestation.key"
  }
}
```

Before Gate 9, the Factory validates the immutable fields and referenced inputs,
creates an exclusive `0600` sibling lock, atomically renames the template to an
execution-specific sibling claim, re-hashes the claimed bytes, binds the runtime
execution ID, and persists the context, claim path, and template SHA-256 in the
execution record. A restart reuses only that persisted binding; it never rereads
or reclaims the source template.

The lock and claimed file are durable no-retry evidence. A stale lock, existing
claim, missing source, byte drift, interrupted rename, or concurrent claimant
returns HOLD before reviewer dispatch. The Factory never removes either artifact
and never retries automatically. Recovery is operator-only: inspect the execution
record, lock, claim, attempt ledger, and canary authorization as one evidence set.
Removing or replacing a lock or claim requires a separate case-specific decision;
do not reuse that template or execution ID.

`certificationValidationEvidencePath` is mandatory whenever certification or merge is enabled. It must
name an absolute canonical owner-controlled `0600` file outside the repository, use schema
`zouroboros.certification-validation-evidence/v1`, bind the exact repository, PR, base/head refs and
40-character head SHA, and expire no more than two hours after generation. Its command receipts must
contain each of these classes exactly once, in this order, with exit code `0`, bounded timestamps, exact
command/arguments, and SHA-256 digests of stdout and stderr (never raw logs):

1. `constitutional_verification`
2. `strict_typescript`
3. `focused_governance_tests`
4. `focused_factory_tests`
5. `repository_ci`
6. `monorepo_build`
7. `diff_hygiene`
8. `secret_scan`
9. `rollback_proof`

The context loader revalidates this receipt before claiming a template. Gate 9 revalidates it against
the live target and embeds its path, digest, and bounded command summary in promotion evidence. The
provider-native issuer independently revalidates both the source receipt and embedded digest before a
durable attempt claim. Missing, stale, failed, incomplete, duplicated, unknown, mismatched, in-repository,
or permission-unsafe evidence returns HOLD before reviewer dispatch.

A `global-automerge` workflow **enables auto-merge on every non-draft PR**. That
is the intended "hands-off" conveyor behavior. When you want an **operator review
gate** on a governance-relevant PR, you must **disable auto-merge explicitly**
after the PR opens:

```bash
gh pr merge <N> --disable-auto            # hold for review
# ...review...
gh pr merge <N> --squash                   # merge on your word
```

Every native-loops PR in this project was held this way. If you *want* the
conveyor to merge on green, leave auto-merge on. An SF-010 live canary also
requires disabling the global auto-merge on the canary PR, so that the
evidence-gated lane — not the workflow — performs the merge. Re-apply the hold
with `gh pr merge <N> --disable-auto` after **any** new push to the PR branch:
the `enable-auto-merge` workflow re-arms on every push (it fires on
`synchronize`), so one earlier disable does not survive the next commit you add.

---

## 2. Governance gates (what protects `main`)

Three gates guard every change. All fail closed.

| Gate | What it checks | How to run |
|---|---|---|
| **Constitution** | Docs (`ZOUROBOROS.md`, `CONSTITUTION.md`) present + consistent before any self-modification | `bun Skills/zouroboros-governance/scripts/constitution-gate.ts verify-docs` |
| **governance-docs** (CI) | Required governance articles present in the diff; a **required status check** on `main` | runs in CI; local: `bun <repo>/…/verify-governance-docs.ts` |
| **Consensus gate** | Multi-model review of net-new logic (MoA lineup); mandated for `Review level=CONSENSUS` tickets | `Skills/consensus-gate` — slow (multi-model), run in background with a long budget |

**Branch protection on `main`** requires three status checks in strict mode:
`build-and-test`, `governance-docs`, `trace-rebuild-proof`. Do not weaken these.

**Consensus is not decorative.** In this very project the ZOU-884 consensus
post-flight caught a **fail-open bug** (`scanActiveConfig` treated any git error as
"clean") that all the green deterministic checks masked. That finding became
ZOU-900, which shipped the fix. When a Model Policy says `Review level=CONSENSUS`,
run it and read the verdict.

---

## 3. The seed + gap-audit discipline (for SWARM tickets)

When the dispatcher routes a ticket to SWARM, or when you build a governance-
relevant change by hand, follow the same rhythm this project used on every ticket:

1. **Read-only validation first** — verify remote state (`gh pr list`,
   `git branch -a`), read the live ticket, ground the code surface against a
   **fresh `origin/main`** (never the drifted primary checkout — see §7).
2. **Evaluated seed** — write a seed YAML (tasks, acceptance criteria, DAG,
   exit conditions), score it, amend, and get **operator approval** before code.
3. **Clean-room build** — isolated `git worktree` off `origin/main`, tight scope.
4. **Verify** — selftests, strict `tsc` (0 errors), governance gates, exact diff
   scope, no client-name leaks.
5. **Hold at the PR** for governance-relevant changes (disable auto-merge).
6. **Post-flight eval + 5-question gap audit** after merge:
   - **Reachability** — does something actually call the new capability?
   - **Data prerequisites** — are schemas/pools/ledgers populated?
   - **Cross-boundary state** — do flags/sentinels survive process boundaries?
   - **Eval-production parity** — does the test use the *same* code path as prod?
   - **Dangling identifiers** — after any delete/rename, does live config still
     point at the removed resource?

---

## 4. Model Policy (per-project tiers)

Factory tickets can carry a project-scoped **Model Policy** block choosing a
consensus lineup by phase:

- **Routine tier** — scaffold/CRUD/UI/infra phases; cheap, vendor-diverse proposers.
- **Reasoning tier** — math/search/NL/AI/constraint phases; stronger vendor-diverse set.

Each tier needs cross-provider fallbacks (primary → different-provider → last
resort). Apply lineups at promotion time only, via per-run env
(`LINEUP_PIN_PROPOSERS` / `LINEUP_PIN_AGGREGATOR`) — **never** write a pinned
lineup to the global `~/.zouroboros/lineup.json` cache.

> **Enforcement gap (known):** the conveyor dispatcher does **not** yet parse the
> `## Model Policy` block — it is advisory until the ZOU-528 parser hook ships.
> Today you apply the tier by hand at promotion.

---

## 5. Command cheat-sheet

```bash
# --- Staging / validation ---
cd /home/workspace/Projects/zouroboros-software-factory/scripts
bun linear-puller.ts                              # what's factory-ready right now
bun linear-puller.ts | bun ticket-contract.ts --dry-run   # will it pass the gate?
bun conveyor-smoke-test.ts                        # cycle health gate (exit 0 = healthy)

# --- Dispatch (routing only, no execution) ---
bun dispatcher.ts --dry-run --tickets <json>

# --- Observatory (FR-09: line, gates, outcomes, alerts; read-only) ---
bun factory-observatory.ts report            # exit 1 = critical alert present
bun factory-observatory.ts report --json     # full export incl. actions_by_mode

# --- Minimum viable path (FR-10: one queue/worker/worktree/gate; see MVP_PATH.md) ---
bun factory-mvp.ts smoke                     # hermetic end-to-end proof, exit 0/1
bun factory-mvp.ts status                    # read-only MVP state snapshot

# --- Governance ---
bun /home/workspace/Skills/zouroboros-governance/scripts/constitution-gate.ts verify-docs

# --- Native loops (planning-state; verify only) ---
cd /home/workspace/Projects/zouroboros-software-factory/native-linear-loops/scripts
bun release-gap-audit.ts        # 5-check gate (exit 0 = clean, fails closed)
bun release-smoke.ts            # same-code-path smoke over the frozen runCohort
bun <module>-selftest.ts        # per-module behavioral suite

# --- Linear (GraphQL, key from env; never echo it) ---
curl -s -X POST https://api.linear.app/graphql \
  -H "Authorization: $LINEAR_API_KEY" -H "Content-Type: application/json" \
  -d '{"query":"..."}'

# --- SF-010 evidence-gated auto-merge lane (FR-07 Phase B live canary) ---
cd /home/workspace/Projects/zouroboros-software-factory/scripts
bun auto-merge-lane.ts evaluate --pr <ref> --archetype doc_fix --ticket <ZOU-N> --attestation <path> --validation-evidence <path> [--repo-dir <dir>] [--merge-repo <owner/repo>] [--no-watcher] --json
# --ticket must equal the ticket the consensus attestation certifies — Gate 8 binds by ticket id, not PR ref; it defaults to the PR ref, which fails closed
# SF010_CERTIFY=1 performs at most one durable, exact certification attempt after Gate 9;
# schema 3 invokes the fixed provider-native Claude Code then Codex CLI issuer with zero retry;
# it requires GitHub branch protection, provisioned owner-only authority, and never implies SF010_AUTOMERGE.
# the real merger and detached canary watcher activate only under SF010_AUTOMERGE=1.
# Safe rollback before merge: set SF010_CERTIFY=0 and restart the owning conveyor.
# A claimed certification attempt is never retried; issue a fresh exact approval/evidence tuple.
bun auto-merge-lane.ts evidence --pr <ref> --archetype doc_fix --ticket <ZOU-N> --approval <evidence-generation-approval.json> --rollback-evidence <path> [--repo-dir <dir>] [--merge-repo <owner/repo>] --json
# evidence-only mode: produces one fresh schema-version-3 draft evidence artifact for an EXACT clean
# draft PR (open, draft, mergeable-clean, all checks terminal-successful) and returns before Gate 10.
# It is blocking (not advisory): any failed gate exits 1 with decision=operator and no artifact.
# --approval must be a signed factory-evidence-only approval (operator-promotion-approval.ts
# record-evidence, max validity 2 hours); a promotion approval is rejected and vice versa.
# The repository remote is resolved uniquely by URL from the checkout — origin is never assumed and
# no remote alias is accepted from the request. Draft-to-ready transition, persona attestation,
# Constitution promotion, authorization consumption, merge intent, merger, completion audit, and the
# canary watcher are structurally unreachable in this mode; the evaluate command retains promotion
# semantics and swarm-exec is unchanged.
bun auto-rollback.ts watch --pr <ref> --sha <merge-sha> [--window <ms>] [--json]
# canary outcomes persist to state/canary/

# --- SF-012 survivability + decision signals (flag-gated; SF012_SURVIVAL=1 or they no-op) ---
SF012_SURVIVAL=1 bun survivability-probe.ts harvest [--json]
# probes post-merge fate repo-qualified, unioning canonical state/ with every rotated conveyor root;
# a candidate whose repository is unresolved is SKIPPED, never guessed against a default repo context
SF012_SURVIVAL=1 bun survivability-core.ts show [--json]
# survival rates are honesty-gated: any bucket under min_sample renders insufficient_data, never a rate
SF012_SURVIVAL=1 bun decision-signals.ts harvest [--json]
# derives advisory signals from three sources (classifier + approval disagreement, gate failures);
# idempotent by (source, source_key) — re-runs append zero duplicates
```

---

## 6. Path B — Native Loops (the integration just delivered)

### 6.1 What it is

Native Loops lets a **Linear event** (webhook or poll) drive a bounded,
fail-closed automation loop *through the factory's existing gates* — intake →
dedup → engine → authority/model-policy/dedup/swarm gates → (shadow) writeback.
It is the event-driven counterpart to the label-driven conveyor.

**It is deliberately OFF.** Every module is pure and composed only by its selftest
and the operator-invoked release smoke. Nothing in production imports the loop
runtime; no schedule or webhook is registered; no runtime flag is enabled. The
loops only *request* actions — the factory decides, executes, verifies, and rolls
back.

### 6.2 Module map (all at `native-linear-loops/scripts/`)

| Module | Role | Ticket |
|---|---|---|
| `loop-contract.ts` | Data shapes, state machine, authority boundaries, fail-closed doctrine | ZOU-876/888 |
| `loop-engine.ts` | Versioned definitions + bounded observe→choose→act→verify→record engine | ZOU-877 |
| `intake.ts` | Event normalize + dedup + revision-ordering + self-writeback guard | ZOU-878 |
| `loop-factory-adapter.ts` | The one consequential port (`requestAction`) → factory gates; **holds the `NATIVE_LOOP_EXECUTE` seam** | ZOU-879 |
| `writeback.ts` | Idempotent Linear writeback + linked run history | ZOU-880 |
| `shadow-policy.ts` | Read-mostly safety spine (permits only reads + one idempotent comment) | ZOU-883 B1 |
| `shadow-pilot.ts` | Cohort runner; operator promote/reject surface (never self-promotes) | ZOU-883 B2 |
| `observability.ts` | Honest metrics (null-when-empty; never fabricated) | ZOU-884 B1 |
| `release-smoke.ts` | Same-code-path smoke over the frozen `runCohort` | ZOU-884 B1 |
| `release-gap-audit.ts` | Mechanized 5-check release gate, fail-closed | ZOU-884 B2 |
| `CONTRACT.md` / `RELEASE.md` | Authority contract + operator runbook | — |

### 6.3 The one enablement seam

There is exactly **one** switch: **`NATIVE_LOOP_EXECUTE`**, read once in
`loop-factory-adapter.ts` (`process.env.NATIVE_LOOP_EXECUTE === "1"`). Anything
other than the exact string `"1"` keeps the adapter in plan/park mode and calls
the injected executor **zero times**. Even when true, dispatch fails closed unless
a real executor is injected. `release-gap-audit.ts` asserts this default-off
property mechanically.

- **To confirm disabled:** `NATIVE_LOOP_EXECUTE` unset or ≠ `"1"`.
- **To disable immediately:** unset it (or set `0`) and restart the owning process.
  There is no partial/in-flight enabled state to drain.

### 6.4 Enablement preconditions — ALL required before `NATIVE_LOOP_EXECUTE=1`

Per `RELEASE.md §5`, do not flip the switch until **every** box is true:

- [ ] **Durable ledger backing.** The three run-history ledgers are in-memory
      today (`InMemoryIntakeJournal`, `InMemoryDurableStore`,
      `InMemoryWritebackLedger`). Cross-process idempotency/dedup/restart-resume
      needs a durable-backed store behind those ports.
- [x] **Measured cost source (ZOU-889)** — DONE (PR #373). The autoloop now reads
      each bridge's measured cost into the cost breaker. *Honest coverage:* only
      `claude-code` emits cost; `codex`/`gemini` → null → fail-closed.
- [x] **Conveyor worktree isolation (ZOU-890)** — DONE (PR #374), behind
      `SF_EXEC_ISOLATED_WORKTREE=1` (default off).
- [ ] **Operator approval + consensus.** Explicit operator verdict plus the
      consensus review the ZOU-884 Model Policy mandates.

Two of four are now satisfied. The remaining blockers are the **durable ledger
backing** and the **operator-approval-plus-consensus** sign-off. Until both land,
the switch stays off and the loops remain a planning-state, read-mostly harness.

### 6.5 Incident response (if a loop is ever enabled and misbehaves)

1. **Contain** — unset `NATIVE_LOOP_EXECUTE` (or `0`), restart the process.
2. **Assess** — read `observability.ts` metrics: run-state distribution, failure
   count, duplicate-suppression, **prohibited-action count (must be 0 in shadow)**,
   latency, cost.
3. **Escalate** — a prohibited-action count > 0, an `ambiguous-authority` verdict,
   or any unexpected writeback is a fail-closed escalation: keep the flag off and
   raise for review before any re-enablement.
4. **Stay safe** — on missing evidence / unknown cost / ambiguous authority the
   loops already escalate; incident response is to *stay* in that state.

---

## 7. Operating hazards (learned the hard way)

- **The primary `/home/workspace/zouroboros` checkout is badly drifted** (100+
  commits behind `main`). **Never** ground architecture decisions or `grep` for
  callers there — always read against a **fresh `origin/main` worktree**. Multiple
  false retractions in this project traced to reading the stale checkout.
- **Factory scripts are git-tracked inside the `zouroboros` repo** at
  `Projects/zouroboros-software-factory/scripts/` — the workspace copy is an
  untracked mirror. Edit and diff against the repo-tracked canonical.
- **Branch slug controls Linear auto-close.** A branch/PR whose name **or
  title/body references `ZOU-###`** auto-closes that issue on merge via the Linear
  GitHub integration. For a multi-PR ticket (B1 of 2), use a **slug-free branch
  AND avoid the ticket ref in the PR title** so the intermediate merge does not
  prematurely close the ticket; carry the slug only on the final PR.
- **`bun add` pollutes the diff.** Installing types/deps in a worktree rewrites
  root `package.json`/`bun.lock`. Restore them before committing so the diff stays
  exactly the intended files.
- **Never `bash -x` / print env** — `BASH_ENV` sources ~95 prod secrets into every
  non-interactive shell. Read `$LINEAR_API_KEY` inside commands; never echo it.

---

## 8. Reference

| Thing | Value |
|---|---|
| Intake Linear project id | `b621d7a1-bb3d-4df9-ae11-3034789e204c` |
| Required contract fields | `title, acceptance_criteria, target_repo, archetype, repro` |
| Conveyor label | `factory-ready` |
| Factory identity (sole authority) | `zouroboros-factory` |
| `main` required checks | `build-and-test`, `governance-docs`, `trace-rebuild-proof` (strict) |
| Native-loops switch | `NATIVE_LOOP_EXECUTE` (default OFF) |
| Promotion-certification switch | `SF010_CERTIFY` (default OFF; never implies merge) |
| Promotion context file | `SF010_PROMOTION_CONTEXT_PATH` (absolute owner-owned `0600`; set only for an authorized canary) |
| Auto-merge switch | `SF010_AUTOMERGE` (default OFF) |
| Worktree-isolation switch | `SF_EXEC_ISOLATED_WORKTREE` (default OFF) |
| Coding-cascade switch | `FACTORY_CODING_CASCADE` (`off` default; `shadow`; `enforce`) |
| Cost-enforce switch | `AUTOLOOP_COST_ENFORCE` (default OFF) |
| Governance authority docs | `zouroboros/ZOUROBOROS.md`, `zouroboros/CONSTITUTION.md` |
| Factory scripts (canonical) | `zouroboros/Projects/zouroboros-software-factory/scripts/` |
| Native-loops modules | `…/native-linear-loops/scripts/` + `CONTRACT.md`, `RELEASE.md` |
| Project progress record | `…/native-linear-loops/PROGRESS.md` |
| Post-flight evaluations | `…/zouroboros-software-factory/evaluations/` |

---

*This manual describes the factory as of 2026-07-24. The native-loops integration
(ZOU-876–884, 888, +889/890/900) is complete and merged in planning-state; the
conveyor (Path A) is the live production path.*
