# Run Receipt Shadow Contract v1

Contract ID: `zouroboros-run-receipt-shadow/v1`

## Purpose

This contract wires the canonical run receipt, operation journal, and edge-proof record into
representative factory paths without changing incumbent decisions. It is observational. It has
only `off` and `shadow` modes and cannot enforce, authorize, dispatch, compensate, notify, or
promote.

## Ownership

`run-receipt-shadow.ts` is the sole production facade allowed to write receipt-shadow journal
state. Producers call `beginShadowRun` and `completeShadowRun`; they never access receipt tables.
`run-receipt-shadow-report.ts` is read-only. `run-receipt-shadow-accept.ts` is the factory
acceptance seam, and `run-receipt-shadow-harvest.ts` invokes the registered production read
adapters outside producer latency. `harvestEdgeProofs` may append normalized proof observations
only through those registered adapters.

| Field | Producer | Consumer |
| --- | --- | --- |
| contract/schema versions | shadow facade | receipt validator, report |
| operation/idempotency identity | registered producer plus stable run identity | journal uniqueness, replay audit |
| trigger kind/identity/intent hash | producer registration plus accepted run | receipt reconstruction, incident drill |
| trace/span lineage | facade deterministic hash of idempotency identity | receipt validator, cross-process join |
| policy/config/source versions | accepted run metadata | authority drift report, activation audit |
| authority envelope | exact activation manifest inputs | journal reservation, incident drill |
| attempts/outcome | producer acceptance/completion seams | receipt reconstruction, report |
| artifacts/ledger entries | normalized producer completion metadata | operator diagnosis |
| edge plan | preregistered producer target and expected-state hash | bounded harvester |
| edge observation/record | registered read-only adapter | edge-binding metric, incident drill |
| producer overhead | facade monotonic measurement | p50/p95/max report |
| compressed bundle bytes | read-only report | 64 KiB gate |
| orphan/replay state | journal joins and uniqueness constraints | restart and conflict report |

## Registered Classes

### Scheduled agent

- Producer: `lane-utilization.ts` after durable open/outcome rows.
- Key: `automation:<automation_id>:<cycle_id>`.
- Trigger: `automation`.
- Edge: workspace read-back of the declared lane outcome artifact.
- Existing guarantee preserved: begin/record always exit zero.

### Factory execution

- Acceptance: `run-receipt-shadow-accept.ts` after exactly one ticket passes `ticket-contract.ts`
  and the current lane has exactly one unresolved durable open row.
- Completion: `cycle-contract.ts` after verdict evaluation and before existing JSON/exit handling.
- Key: `factory:<cycle_id>:<linear_id>`.
- Trigger: `factory`.
- The acceptance invocation before `swarm-exec.ts` and valued completion arguments belong only
  to the separately approved activation-manifest automation diff.
- Edge: workspace read-back of the terminal execution artifact.

### External side effect

- Producer: `ship-ready-runner.ts` after a durable queued/running request and each durable
  terminal shipping receipt.
- Key: `github:<repo_hash>:<execution_id>`.
- Trigger: `factory`.
- One operation spans all `attempt_count` values. An attempt is never a new operation.
- Required GitHub proof is frozen before the incumbent shipper runs; read-back is deferred.
- `no_patch_novel` terminalizes as held and is excluded from cohort volume; `already_merged`
  remains eligible because the incumbent run binds an existing user-visible GitHub outcome.

## Non-Interference

Missing or `off` mode returns before resolving a database path, loading the registry, opening
SQLite, constructing an adapter, or writing a file/network/notification. Producer calls ignore
shadow return values. Shadow errors are returned as data and never change incumbent return values,
stdout, stderr, exit codes, lifecycle, authorization, dispatch, delivery, or shipping behavior.

The facade never calls an external mutation adapter. The harvester constructs only the registered
workspace and GitHub adapters, advances at most 12 plans per invocation, and constrains GitHub to
`gh api --method GET repos/<owner>/<repo>/pulls/<number>`. No mutation endpoint is reachable.

Shadow authority requires an external `zouroboros-run-receipt-shadow-config/v1` document with the
exact activation-manifest SHA-256 and self-reference-free effective-config SHA-256. It also requires
matching policy and registry file hashes plus the receipt-specific autonomy-policy grant for only
runtime `zo-native`, the declared automation UUID, and scopes `operation.reserve`,
`observe:workspace`, and `observe:github`. This grant does not add `zo-native` to the global
classifier runtime allowlist. Missing, malformed, drifted, zero-hash, or overbroad inputs return no
authority before SQLite is opened.

## Persistence and Replay

The journal path is absolute and outside immutable code artifacts. Reservation identity is
`scope + idempotency_key + canonical intent`. Conflicting intent, source identity, writer, target,
or replay fails closed inside shadow state while incumbent behavior continues. Completion without
an accepted operation is a visible dangling completion and cannot invent a receipt.

Separate processes reopen the same WAL database. A process killed after reservation can resume
the missing attempt start. A terminal receipt is immutable and idempotently returned on replay.

## Redaction and Retention

Only opaque IDs, hashes, enum values, timestamps, normalized reason codes, and relative artifact
references are persisted. Raw provider payloads, message/comment/file bodies, recipients,
credentials, signed URLs, holdout plaintext, and raw logs are forbidden. The append-only journal
is capped at 64 MiB. Shadow writers hold before opening the database at a 56 MiB high-water mark,
reserving 8 MiB for WAL/checkpoint headroom and bounded diagnostic recovery. Backup/restore always
targets a new path; audit history is never overwritten.

Edge plans persist a validated opaque `target_ref` of at most 256 characters plus its hash. The
workspace adapter resolves lane, execution, and shipping records from durable factory files. The
GitHub adapter resolves repository and PR identity transiently from those records and persists only
normalized hashes and opaque source bindings, never the URL, repository path, command output, or
provider response.

## Metrics and Qualification

- At least 30 unique genuine operations in each class and exactly 90 in the frozen cohort.
- Required-field completeness and required/unavailable edge binding at least 99%; at 90 total,
  one failure yields 98.89%, so the practical gate is 90/90.
- Producer-only overhead p95 at most 250 ms.
- Gzip receipt plus latest proof bundle at most 65,536 bytes/run.
- A frozen 12-run sample, four per class, must score at least 8/10 for diagnosis without raw logs.

Historical backfills, replays, empty scans, fixtures, and synthetic side effects never qualify.
The current genuine shipping rate cannot satisfy 30 runs in 15 days, so live qualification remains
HOLD until an exact activation manifest approves either a higher-volume genuine producer after an
authority/traffic audit or the approved 225-day window.

## Rollback

Flag-off is the first rollback action and must preserve incumbent behavior. Live activation must
retain the prior immutable runtime and automation payload, disable new writers, checkpoint and
retain the append-only database, restore only from a verified backup to a new path, and prove no
active config references the retired runtime or writer.
