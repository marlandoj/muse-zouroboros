# Canonical Run Receipt v1

**Schema ID:** `https://zouroboros.ai/schemas/run-receipt-v1.schema.json`
**Contract ID:** `zouroboros-run-receipt/v1`
**Owner:** Zouroboros Software Factory
**Status:** Contract only; no production writer is enabled by ZOU-1051

## Purpose

A run receipt is the immutable, replayable proof for one durable operation. It joins
trigger identity, authority, causal events, attempts, side effects, terminal state,
verification, and user-visible delivery without making a chat connection the source of
truth. Acceptance, execution completion, and user-visible delivery are independent facts.

The v1 contract is additive. It does not replace execution records, the flight journal,
shipping receipts, approval ledgers, or the canonical lifecycle projection. A later
ZOU-1053 implementation may materialize canonical receipts from those sources; ZOU-1051
only defines and validates the contract.

## Governing Invariants

1. `operation_id` identifies one durable operation across retries and delivery edges.
2. `idempotency_key` maps one caller intent to at most one operation and input hash.
3. Events are immutable, uniquely identified, causally linked, and strictly ordered per
   operation by a contiguous sequence beginning at one.
4. Lifecycle state is derived from `execution-lifecycle.ts` and
   `lifecycle-projection.ts`. A receipt must not define a competing factory state reducer.
5. Side effects require non-`none` authority and a rollback reference when reversible.
6. A committed side effect is never repeated during reconstruction or cursor resume.
7. Acceptance, completion, and user-visible delivery acknowledgements are separate.
8. A missing or dropped chat/SSE edge leaves execution truth unchanged and keeps
   `acknowledgements.user_visible` null.
9. Redaction occurs before receipt hashing. `receipt_hash` is excluded from its own hash.
10. Missing, contradictory, or unverifiable evidence returns an explicit validation error;
    it is never rounded up to success.

## Ownership and Reader Map

Every durable source fact has exactly one owning writer. The canonical receipt writer is
reserved for ZOU-1053 and does not exist in ZOU-1051.

| Receipt fact | Owning writer | Current readers / projection | v1 rule |
| --- | --- | --- | --- |
| Factory lifecycle event | `scripts/flight-recorder.ts::recordFlight` | `readFlightEvents`, `lifecycle-projection.ts`, `flight-status.ts` | Preserve source event identity and causal order; do not rewrite the journal. |
| Raw execution output | `scripts/flight-recorder.ts::appendExecLog` | `flight-status.ts` | Reference by hash/path only; never embed raw logs or secrets. |
| Execution mutable record | `scripts/swarm-exec.ts` | `lifecycle-projection.ts`, `flight-status.ts`, shipping/reconciliation paths | Treat as source evidence, not canonical truth when projection reports divergence. |
| Lifecycle state | `scripts/lifecycle-projection.ts::projectLifecycle` | `flight-status.ts`, `factory-metrics.ts`, `delivery-evidence.ts`, Results Explorer | Receipt maps the projected state; no second state vocabulary or reducer. |
| Git base provenance | `scripts/execution-provenance.ts::captureExecutionBaseCommit` | execution records, ticket-owned-commit verification | Preserve the full source commit in `versions.tool_versions.git_base`. |
| Approval verdict | `scripts/approval-ledger.ts::appendVerdict` and its append-only harvest row | risk calibration, factory review and qualification readers | Map latest resolved evidence into `authority`; never rewrite ledger rows. |
| Shipping terminal evidence | `scripts/receipt-advance.ts::advanceReceipts` | post-merge reconciliation, operators | Map legacy shipping outcome as source evidence; do not mutate historical receipts. |
| Delivery proof | `scripts/delivery-evidence.ts::collectDeliveryEvidence` | serial promoter and receipt advancement | Populate completion/delivery evidence only when the canonical projection proves it. |
| Canonical run receipt | Future `scripts/run-operation-journal.ts` under ZOU-1053 | `run-receipt-contract.ts`, future ZOU-1054/ZOU-1055 consumers | One atomic, write-once receipt per `operation_id`; absent in ZOU-1051. |

The ZOU-1051 module `run-receipt-contract.ts` is a pure parser, validator,
canonicalizer, reducer, cursor reader, and reconstruction library. It owns no durable
production fact and performs no filesystem, network, service, ledger, or Qdrant write.

## Identity and Idempotency

- `receipt_id` is `rr-` followed by a 26-character Crockford ULID.
- `operation_id` is `op-` followed by a 26-character Crockford ULID.
- `idempotency_key` is a non-empty caller-supplied key, scoped by the future writer.
- Two receipts with the same `idempotency_key` must have the same `operation_id` and
  `trigger.input_hash`. Any mismatch is `idempotency_conflict`.
- Re-emitting an identical event is harmless. Reusing an `event_id` or
  `source_event_id` with different canonical content is `conflicting_event`.

## Causal Event Model

Each event contains:

- `event_id`: receipt-local immutable identity.
- `source_event_id`: immutable identity from the owning source writer.
- `causal_parent_id`: the preceding causal event, or null for sequence one.
- `sequence`: contiguous integer beginning at one.
- `cursor`: `rrc:<operation_id>:<sequence>`.
- `kind`: one of the v1 event kinds.
- `ts`: RFC 3339 timestamp.
- `attempt_n`: attempt association when applicable.
- `tool_call_id` / `tool_result_for`: tool-call linkage.
- `payload_hash`: SHA-256 of the source payload after source-specific redaction.

The first event must be `operation.accepted`. An attempt must start before tool or attempt
completion events. `tool.completed` must reference a preceding `tool.called`. A terminal
operation event is invalid while a tool call is unresolved. Completion events may not
precede attempt completion. A user-visible event must causally follow an operation terminal
event. These checks detect missing transitions and dangling tool calls deterministically.

## Event and Outcome Vocabulary

Event kinds:

- `operation.accepted`
- `attempt.started`
- `tool.called`
- `tool.completed`
- `attempt.completed`
- `operation.completed`
- `operation.failed`
- `operation.held`
- `delivery.visible`

Attempt status remains `success | failure | timeout | cancelled`.

Receipt terminal outcome remains
`success | failure | partial | timeout | cancelled | held`. These are receipt outcomes,
not additions to the factory `ExecutionState` enum. The contract maps existing lifecycle
evidence into this vocabulary and records the original state as evidence.

## Acknowledgements

`acknowledgements` contains three independent slots:

| Slot | Required | Meaning |
| --- | --- | --- |
| `accepted` | yes | Durable custody of the operation was established. |
| `completed` | nullable | Execution reached a terminal outcome. |
| `user_visible` | nullable | A user-facing channel durably observed the terminal result. |

Each acknowledgement references the causal event that proves it. Completion never implies
user visibility. A delivery disconnect therefore cannot mark execution failed and cannot
manufacture successful delivery evidence.

## Attempts and Side Effects

Attempts are ordered by `attempt_n` from one with no gaps. Each side effect carries a
stable `effect_id`, `kind`, `target`, `committed`, `reversible`, and `rollback_ref`.
Committed `effect_id` values are unique across the receipt. Reconstruction reads them but
never executes them. A duplicate committed effect is `duplicate_committed_effect`.

## Canonicalization and Hashing

The canonical form is deterministic JSON:

1. Deep-clone the receipt.
2. Apply declared redactions to the clone and replace each selected value with
   `[REDACTED]`.
3. Sort object keys lexicographically at every depth; retain array order.
4. Encode JSON without insignificant whitespace using UTF-8.
5. Remove only the top-level `receipt_hash` field from the hash input.
6. Compute lowercase SHA-256 over those UTF-8 bytes.

`redaction.redaction_hash` may record the hash of the pre-redaction canonical form for an
authorized verifier, but the pre-redaction value is never written to the receipt, fixtures,
logs, or error output. Validation rejects obvious secret-bearing field names unless their
value is exactly `[REDACTED]`.

## Deterministic Reconstruction

Reconstruction accepts an immutable receipt template and source events. It performs no side
effect. The reducer:

1. Deduplicates byte-identical events by `event_id` and `source_event_id`.
2. Rejects conflicting identities.
3. Sorts by sequence and validates contiguous order, cursors, and causal parents.
4. Validates attempts, tool-call closure, and terminal ordering.
5. Derives acknowledgements from `operation.accepted`, terminal operation, and
   `delivery.visible` events.
6. Recomputes the canonical receipt hash.

The same template and event multiset must produce byte-identical canonical JSON and the
same cursor after a new process starts. Reconstruction never calls a tool, writes a file,
or repeats a committed effect.

## Cursor Resume

A cursor is opaque to callers but v1 encodes it as
`rrc:<operation_id>:<sequence>`. Resume returns only events whose sequence is greater than
the cursor sequence. An operation mismatch, malformed cursor, or cursor beyond the receipt
head is an explicit error. Re-reading from the same cursor is byte-identical.

## Schema and Semantic Validation

The JSON Schema is Draft 2020-12 and rejects unknown properties at contract-owned object
boundaries. The TypeScript validator enforces cross-field rules JSON Schema cannot express:

- idempotency conflicts across receipts;
- duplicate or conflicting source identities;
- causal and sequence gaps;
- missing attempt transitions;
- dangling or multiply completed tool calls;
- duplicate committed side effects;
- acknowledgement/event mismatches;
- terminal outcome/event mismatches;
- redaction-before-hash and canonical hash parity.

Schema and semantic validation must agree on every canonical fixture. Negative fixtures
identify the expected semantic error code.

## Legacy Mapping

Legacy sources remain immutable and readable:

| Legacy source | v1 destination |
| --- | --- |
| `exec-*.json.execution_id` | `operation_id` mapping evidence and `trigger.identity` |
| Flight `execution_id`, `kind`, `ts`, `data` | `lineage.trace_id` and `events[]` |
| `base_commit` | `versions.tool_versions.git_base` |
| Approval `verdict_id` | `authority.authorization_evidence_ref` |
| Shipping outcome | `terminal.outcome` mapping evidence |
| Lifecycle projection state | terminal/verification evidence, never a new reducer |
| Delivery evidence | `acknowledgements.completed` or `user_visible` only when directly proven |

Legacy readers are unchanged by v1. A future migration appends canonical receipts alongside
legacy state, records `versions.schema_migrations`, and never rewrites historical files.

## Rollback

ZOU-1051 rollback is a code revert: remove the additive contract, schema, fixtures,
validator, tests, and their CI/smoke registrations. There is no state migration, runtime
flag, writer, service, or production data to restore.

For future consumers, rollback means disable the consumer/producer flag, stop new receipt
writes, preserve existing receipts as immutable evidence, and prove incumbent lifecycle,
shipping, approval, and delivery paths still behave identically. Enforcement is outside v1
contract authority.

## Reachability

During ZOU-1051, reachability is deliberately limited to:

- `run-receipt-contract.test.ts` consuming the exported parser and reducer;
- protected GitHub CI invoking the focused contract suite;
- `conveyor-smoke-test.ts` invoking the same focused suite before a factory cycle.

There is no production receipt writer yet. ZOU-1053 owns that future implementation;
ZOU-1054 and ZOU-1055 own status/delivery and shadow-wiring consumers respectively.
