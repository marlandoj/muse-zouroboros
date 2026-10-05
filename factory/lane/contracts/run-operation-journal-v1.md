# Factory Operation Journal v1

**Contract ID:** `zouroboros-operation-journal/v1`
**Owner:** Zouroboros Software Factory
**Linear:** ZOU-1053
**Status:** Non-production implementation contract

## Purpose

The operation journal is the local transactional authority for operation identity, ordered
intent and effect evidence, bounded recovery, and atomic materialization of the canonical
ZOU-1051 run receipt. It is not a distributed transaction coordinator and never claims
exactly-once delivery across an external system.

The journal persists intent before dispatch, records the observed effect state after dispatch,
and probes an adapter before any retry whose prior outcome is ambiguous. Unknown external state
is `held`; it is never renamed as failure and never replayed automatically.

## Ownership

| Fact | Owning writer | Journal relationship |
| --- | --- | --- |
| Factory lifecycle | `flight-recorder.ts` and `lifecycle-projection.ts` | Read-only source evidence. The projection remains the sole factory lifecycle reducer. |
| Approval verdict | `approval-ledger.ts` | Read-only source evidence. Existing JSONL rows remain byte-identical. |
| Run receipt vocabulary and hash | `run-receipt-contract.ts` | Imported and consumed without schema changes. |
| Operation identity and idempotency | `run-operation-journal.ts` | Canonical local transactional owner. |
| Journal event and effect evidence | `run-operation-journal.ts` | Append-only SQLite owner. |
| Production producer and live adapter | Future ZOU-1055 | Explicitly absent from ZOU-1053. |

The journal stores only `source_writer`, `source_event_id`, and `payload_hash` bindings for
legacy JSONL evidence. It never imports a JSONL lifecycle row as an independently mutable state
machine and never rewrites, truncates, deletes, or compacts a source ledger.

## Storage Boundary

The constructor and CLI accept only an explicit absolute database path. A caller may resolve the
path from `FACTORY_OPERATION_JOURNAL_PATH` or from an explicit `FACTORY_STATE_DIR`, but the module
does not derive a source-tree or current-working-directory default. Tests use disposable paths.

Opening a database fails closed unless all of the following hold:

- SQLite `journal_mode` is WAL.
- `synchronous` is FULL.
- `foreign_keys` is ON.
- `busy_timeout` is bounded by the configured ceiling.
- `quick_check` returns `ok`.
- `user_version` is known and supported.
- The stored migration checksum matches the compiled migration.

ZOU-1053 must qualify WAL on a disposable sibling path on the same v9fs mount as the future
factory state database. `/dev/shm` may accelerate unit tests but cannot prove durability.

## Identity and Idempotency

- `scope` is a caller-defined namespace.
- `(scope, idempotency_key)` is unique.
- `input_hash` is lowercase SHA-256 over canonical, redacted intent.
- `operation_id` is a durable `op-` Crockford ULID identity.
- The same scope, key, and input hash always return the existing operation identity.
- Reusing the same scope and key with a different input hash returns
  `idempotency_conflict` and creates no second operation, event, or effect.
- Reservation uses `BEGIN IMMEDIATE`; cross-process races therefore converge on one identity.

## Authority

Authority is checked before reservation and again before every effect intent is committed.
The caller supplies a receipt-compatible authority envelope and the adapter scope requested by
the effect. Authority is valid only when it is non-`none`, not expired, and includes that scope.

Missing, expired, `none`, or scope-mismatched authority produces an append-only held/no-op
record and zero dispatched effects. Compensation requires a separate authority scope; original
effect authority never implies compensation authority.

## Event Model

Journal events are insert-only and contain:

- stable event identity;
- operation identity;
- contiguous per-operation `event_sequence` beginning at one;
- database-assigned global `commit_sequence`;
- prior event hash and current event hash;
- source writer, source event identity, and source payload hash when applicable;
- canonical redacted payload;
- creation timestamp.

The event hash covers the operation identity, event sequence, prior hash, kind, canonical
payload, and source binding. Replaying the same rows in a fresh process must yield byte-identical
canonical events and the same chain head.

Updates and deletes against operations, events, effects, terminal records, receipts, and
migrations are rejected by schema triggers after insertion. Mutable dispatch evidence advances
only through a new immutable effect-state row.

## Effect Protocol

Each effect has a stable `effect_id`, adapter kind, target, input hash, reversibility flag, and
optional rollback reference. Its ordered states are:

`intended -> dispatch_started -> committed | not_committed | ambiguous -> compensated`

The generic adapter contract is:

1. Validate authority.
2. Persist effect intent and commit it.
3. Persist dispatch start and commit it.
4. Call the injected adapter with the stable effect identity.
5. Persist the observed result.
6. Verify committed effects before terminalization.

An adapter exposes `dispatch`, `probe`, and optional `compensate`. After a crash or timeout past
dispatch start, recovery calls `probe` before considering another dispatch. `committed` is never
redispatched. `not_committed` may be dispatched only within the declared retry budget.
`ambiguous` remains held until an explicit reconciliation establishes a known state.

## Compensation

Compensation is append-only, separately authorized, and idempotent by original `effect_id` plus
`rollback_ref`. It operates in reverse commit order and only on known committed, reversible
effects. It records a new compensation effect and evidence; it does not edit or delete the
original effect. A failed or ambiguous compensation leaves the operation held.

## Terminal Semantics

Exactly one terminal event and one receipt may be inserted for an operation.

| Outcome | Receipt event | Meaning |
| --- | --- | --- |
| `success` | `operation.completed` | Declared target reached; all required effects verified. |
| `failure` | `operation.failed` | Unrecoverable error or retry exhaustion with no residual committed or unknown effect. |
| `partial` | `operation.completed` | A known subset remains committed after bounded compensation. |
| `timeout` | `operation.failed` | Deadline exhausted with no residual committed or unknown effect. |
| `cancelled` | `operation.failed` | Explicit cancellation with no residual committed or unknown effect. |
| `held` | `operation.held` | Authority, storage, safety, adapter, or unresolved external-state ambiguity prevents truthful completion. |

`max_attempts` and `retry_budget_exhausted` are reason codes, never additional outcomes. Any
known residual commit maps to `partial`; any unresolved external ambiguity maps to `held`.

## Receipt Materialization

Terminalization and receipt insertion occur in one SQLite transaction. The journal constructs a
ZOU-1051 `RunReceipt`, validates it with `validateRunReceipt`, finalizes its canonical hash with
`finalizeReceipt`, and inserts exactly one immutable receipt row. The journal does not add a
terminal outcome, event kind, or receipt field.

The receipt binds journal evidence to existing sources through source identity and payload hash.
It does not claim user-visible delivery unless direct delivery evidence exists. ZOU-1053's fake
adapter tests may materialize a completed acknowledgement, but production status and delivery
adapters remain ZOU-1054/ZOU-1055 work.

## Recovery and Crash Boundaries

Fresh-process tests inject termination after each of these durable boundaries:

- operation reservation;
- effect intent;
- dispatch start;
- adapter result;
- terminal event;
- receipt publish;
- WAL checkpoint.

Reopen must preserve all committed rows, reject torn or mismatched state, produce deterministic
replay and hashes, and never duplicate an adapter effect. Recovery is bounded by one busy retry,
the configured write deadline, and the operation deadline.

## Migration, Backup, and Rollback

Migrations are forward-only, ordered, checksummed, and transactional. Before a migration, the
writer checkpoints the WAL and creates a coherent SQLite backup through the database API. It
then verifies the backup and applies the migration. An unknown or newer `user_version`, checksum
mismatch, failed backup, or failed integrity check halts opening.

Rollback disables the writer and preserves or quarantines the database as evidence. It never
downgrades the schema, deletes journal history, or raw-copies an active WAL database. A verified
backup may be restored only to a new path while the writer is disabled.

## Resource Ceilings

- Event payload: at most 65,536 UTF-8 bytes.
- Disposable database: at most 64 MiB.
- Tracked additions: at most 8 MiB.
- RSS growth: at most 128 MiB in deterministic stress.
- Busy timeout: at most 3,000 ms.
- Write deadline: at most 5,000 ms.
- Busy retries: at most one.
- Deterministic stress: 60 seconds.
- External spend: zero.

Exceeding a ceiling fails closed and produces no external side effect.

## Reachability

ZOU-1053 reachability is limited to the exported API, an explicit-path hermetic selftest, the
protected CI job, and the conveyor smoke probe. All databases are disposable and all adapters
are injected fakes. No runtime flag, service, schedule, production database, production producer,
or live Git, Linear, Qdrant, or service adapter is introduced.

## Halt Conditions

Execution halts on seed or base drift, constitutional failure, schema or integrity failure,
unqualified v9fs WAL, locking or recovery failure, duplicate identity/effect evidence, authority
ambiguity, unresolved adapter state, resource-ceiling breach, source-ledger mutation, competing
lifecycle reduction, production wiring, or a rollback that would require deleting history.
