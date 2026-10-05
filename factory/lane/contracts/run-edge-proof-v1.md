# Run Edge Proof Record v1

**Schema ID:** `https://zouroboros.ai/schemas/run-edge-proof-v1.schema.json`

**Contract ID:** `zouroboros-edge-proof-record/v1`

**Owner:** Zouroboros Software Factory

**Status:** Contract and hermetic adapters only; ZOU-1055 owns production wiring

## Purpose

An edge proof record binds an immutable run receipt to independently observed external state.
Acceptance, terminal execution, transport acceptance, durable target state, and user-facing edge
visibility remain separate facts. Tool success, API success, lifecycle merge evidence, and a chat
stream acknowledgement do not prove a user-facing edge observed the terminal result.

## Classification

Every proof target is classified before execution:

- `required`: the operation declares an external or user-facing effect and remains in the binding denominator.
- `notApplicable`: legal only for a preregistered no-side-effect operation; excluded from the denominator.
- `unavailable`: required proof could not be obtained because authority, adapter, deadline, or readback failed; remains in the denominator.

`notApplicable` cannot be selected after a failed readback. `unavailable` never rounds up to confirmed.

## Acknowledgement Tiers

1. `transport_accepted`: a provider accepted a request.
2. `durable_confirmed`: authoritative readback observed the target state.
3. `user_visible_confirmed`: the user-facing system boundary durably exposed the terminal result.

User-visible means observation at the user-facing system boundary, not proof a human read it.
Only a `within_deadline` `user_visible_confirmed` required record counts in the Phase B numerator.

## Binding and Immutability

Each record binds the operation, trace, actor hash, adapter and version, target hash, expected and
observed state hashes, receipt identity and hash, terminal event/source reference, classification,
tier, observation time, provider revision/event identity, payload hash, redaction manifest, and
predecessor record hash. The record hash covers the canonical record except its own hash.

The plan is frozen before execution. Observations and records are append-only hash chains. A
confirmed observation already obtained through a read-only adapter may be supplied to the journal
terminalization transaction; terminal event, `delivery.visible`, receipt, and proof record then
commit together. A timeout or unavailable observation publishes a receipt with user visibility
null. A later confirmation appends a linked `late` record and never edits or rehashes the receipt.

The existing receipt field `verification.edge_proof` remains ledger-chain/anchor integrity. This
contract does not overload it with external readback semantics.

## Adapters and Authority

An `EdgeProofAdapter` exposes only `probe`. It has no dispatch, compensation, mutation, credential
loader, or live-client constructor. GitHub, Linear, and workspace pilots accept injected normalized
read clients. Missing, expired, or scope-mismatched `observe:<adapter>` authority produces an
unavailable observation and zero adapter calls.

Polling is a persisted one-step state machine. Each invocation performs at most one bounded probe,
records its attempt and `next_poll_at`, and returns. It never sleeps across attempts. A plan permits
at most 12 polling attempts within 300,000 ms. Up to 16 normalized observations per target are
retained so separately authorized late supplements remain possible after the polling budget closes.

## Storage, Redaction, and Retention

Journal schema v2 adds insert-only proof plan, observation, and record tables. Migration from v1 is
forward-only, checksum-verified, transactional, and requires a coherent verified SQLite backup.
Rollback restores that backup only to a new path while the writer is disabled; history is never
downgraded or deleted.

Only normalized hashes, opaque source identifiers/revisions, timestamps, classifications, and
reason codes are persisted. Raw provider responses, credentials, recipients, message/comment/file
bodies, and signed URLs are prohibited. A canonical proof record is capped at 8 KiB and each target
at 16 observations. Plans, normalized observations, proof records, classifications, and hash-chain
metadata are retained with the receipt in v1; automatic deletion requires a separate migration.

## Reachability and Exclusions

ZOU-1054 reachability is limited to exported pure APIs, deterministic fake-client tests, protected
CI, and conveyor smoke. It introduces no network access, credentials, provider SDK, production
journal path, runtime flag, service, schedule, deployment, restart, or receipt producer.

ZOU-1055 exclusively owns live client factories, secrets, production journal wiring, shadow mode,
and the at-least-90-receipt three-class cohort. Zo chat/SSE transport recovery remains outside this
contract unless the platform exposes an authoritative durable message-readback or cursor API.

## Halt Conditions

Halt on unknown classification, post-hoc `notApplicable`, missing read authority, unregistered or
mutating adapter, operation/actor/target/result mismatch, stale or replayed source binding,
unredacted sensitive data, chain/hash failure, migration/integrity failure, resource ceiling breach,
receipt or source-ledger mutation, production wiring, or any claim that unavailable or transport
acceptance equals user-visible confirmation.
