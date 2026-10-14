# Decision Factory — the authority contract (Track 2)

Every consequential action in the swarm is **proposed, tiered, approved or
denied, and recorded**. The decision record is the atomic unit of
accountability, and enforcement is structural: the transport cannot be
bypassed, and no path reaches a tool without a record and a tier verdict.

The contract lives here, in the package that enforces it.

Modules:

| Module | Role |
| --- | --- |
| `src/decision-record.ts` | Record schema, event taxonomy, stores (in-memory + append-only JSONL) |
| `src/approval-tiers.ts` | Tier policy engine: blast-radius classification, budgets, allowlists, the `DecisionGate` |
| `src/transport/acp-transport.ts` | The two enforcement points (dispatch gate, ACP permission seam) |
| `src/authority-eval.ts` | Adversarial authority probe suite (red/green) |

## The record schema

One `DecisionRecord` per decided proposal (`schema_version: 1`):

- `decision_id` — UUID, the accountability key.
- `actor` — persona/seat on whose behalf the action was proposed. Anonymous
  actors are refused at gate construction.
- `origin` — `swarm` or `factory` (lane discrimination, see below).
- `granularity` — `fine` or `coarse` (verbosity per locked Q4, see below).
- `tier` — `auto | delegate | human`, the tier the proposal was finally
  evaluated at, after any escalation.
- `blast_radius` — `read_only | local_write | network | delegated | destructive`.
- `proposed_action` — `{ kind: 'tool_call' | 'executor_dispatch', tool, target?, summary, rawInput? }`.
- `outcome` — `approved | denied`. There is no third state.
- `reason`, `decided_by` (`policy:<version>`, `delegated:<decision_id>`,
  `human:<name>`, or `fail-closed`), `decided_at`, `created_at`.
- `parent_decision_id` — the dispatch record a tool decision executed under
  (delegated linkage).
- `policy_version`, `trace_id?`, `task_id?`, `session_id?`, `budget?`,
  `evidence_refs?`, `replay_pointer?`.

Lifecycle events (`DecisionEvent`): `proposed`, `tier_assigned`, `escalated`,
`approved`, `denied`, `retry_after_denial`, `delegated_child`. The `proposed`
event is always written before any verdict exists.

This schema is deliberately distinct from the seat-keyed outcome rows in
`ledger/decision-ledger.ts` (task outcomes). This record answers a different
question: *was the agent allowed to decide this, on what evidence, under whose
authority.*

## Tier policy

Blast-radius classification (default policy `decision-factory/1`, ACP tool-call
kinds): `read/search/think → read_only`, `edit/move → local_write`,
`fetch → network`, `execute → delegated`, `delete → destructive`. An executor
dispatch is always `delegated`. **Anything unmatched — unknown tool, unknown
kind, missing kind — is `destructive`.** Tool-title overrides outrank kinds.

Tier mapping: `read_only/local_write → auto`, `network/delegated → delegate`,
`destructive → human`.

Grant rules (deny by default):

- **auto** — approved by policy, recorded (`decided_by: policy:<version>`).
- **delegate** — requires delegated authority: an approved dispatch record is
  the delegation grant for the session's tool gate. Without it, denied.
- **human** — requires a live human approver. None exists on the machine path,
  so human-tier proposals are denied unless a `humanApprover` is explicitly
  wired via `ACPTransportConfig.decisions`.

Invariants:

- **Escalation is one-way.** `escalateTier` throws on any downgrade. Budget
  exhaustion escalates up (auto→delegate→human), never down.
- **Denial is terminal.** A denied proposal (keyed by actor + action + target)
  is never re-evaluated; a retry denies again and records `retry_after_denial`.
- **Budgets.** Per-gate caps (`maxAutoApprovals`, `maxDelegateApprovals`);
  exceeding a cap escalates to a tier the gate usually cannot grant.
- **Allowlists.** The executor registry's `allowedTools` is enforced at the
  permission seam: a tool outside it is denied regardless of tier.

## Enforcement points (structural, not advisory)

Both lanes traverse one seam — `ACPTransport` — per the locked Q4 decision:

1. **Dispatch gate** (`ACPTransport._runSession`): one coarse `delegated`
   record is created and approved **before any adapter process spawns**. A
   denied or failed dispatch decision returns a failed `TaskResult` with no
   spawn. This covers every caller — `ExecutorClient.run` (which the factory's
   `harness-router.ts` lazy-imports), the orchestrator, and direct transport
   use.
2. **ACP permission seam** (`SwarmClient.requestPermission` →
   `gatedAcpPermission`): every `session/request_permission` from the adapter
   is proposed, tiered, and recorded before any allow option can be selected.
   A missing gate, a throwing gate, a throwing store, or a denial all return
   `cancelled` — the adapter never gets the tool.

Lane discrimination (`resolveDecisionOrigin`): a dispatch is factory-lane when
the factory's executor guard markers are present in the dispatch env
(`SWARM_EXEC_CONTAINMENT_REQUIRED=1` or `SWARM_EXEC_RESOURCE_GUARD_REQUIRED=1`,
set by `factory/lane/scripts/host-resource-guard.ts`), when the process runs under the managed
factory boundary, or when `SWARM_DECISION_ORIGIN=factory` is explicit.
Everything else is the swarm lane. The factory lane's own code is untouched —
it inherits enforcement through the shared transport.

Granularity (locked Q4): **fine-grained records for swarm tool calls; coarse
`delegated` records for factory executor dispatches.** Concretely: every
dispatch (either lane) gets one coarse record; swarm-origin sessions write one
full record per tool decision; factory-origin sessions log approved tool
permissions as cheap `delegated_child` events on the parent dispatch record.
**Denials always produce a durable full record, in both lanes.**

## Record store

`resolveDecisionRecordStore`: when `ZOUROBOROS_DECISION_RECORDS` names a path,
records and events append to that JSONL file (one fsynced `O_APPEND` write per
line); otherwise they go to the process-shared in-memory store. There is no
"off" switch — `ACPTransportConfig.decisions` can swap the store, the policy,
or wire a human approver, but cannot disable enforcement. A store that throws
denies the action: a decision that cannot be recorded does not happen.

## Fail-closed guarantees

Verified by `src/authority-eval.ts` (12 adversarial probes, red/green; run
standalone with `bun src/authority-eval.ts`) and gated in CI by
`src/__tests__/decision-factory.test.ts`:

- Above-authority actions (destructive, unknown tools) deny at the human tier.
- The permission seam without a gate returns `cancelled` (bypass attempt).
- A throwing store denies (no record ⇒ no verdict ⇒ no tool).
- Escalation downgrades throw; retries after denial stay denied.
- Delegate-tier actions without a delegation grant deny; budget exhaustion
  escalates up and denies when nothing can grant the higher tier.
- Anonymous actors cannot construct a gate.
- Approvals are recorded too, with the proposal event preceding the verdict.

## Empirical requestPermission traversal (locked Q4 prerequisite)

The wire tests in `decision-factory.test.ts` use a mock ACP adapter
(`__tests__/fixtures/mock-acp-permission-adapter.ts`) that issues real
`session/request_permission` JSON-RPC requests over stdio and reports the
response it receives. The "LOCKED Q4 VERIFICATION" test dispatches through
`ExecutorClient.run → ACPTransport` — the exact seam the factory's
`harness-router.ts` imports — with factory-lane origin, and asserts both the
wire-observed verdict and the stored records. The traversal is observed on the
wire, not inferred from the call graph.
