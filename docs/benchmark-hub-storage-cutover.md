# Benchmark Hub fresh-domain cutover

This is an operator-reviewed activation protocol, not permission to deploy or
change production environment variables. The original600 outcome remains OPEN.

## Configuration and reader floor

`BENCHMARK_HUB_STORAGE_EPOCH` selects the immutable read target. It must match
`[A-Za-z0-9][A-Za-z0-9_-]{0,63}`. New objects live only under
`benchmark-hub-v2/<epoch>/`; old `benchmark-hub/` objects are never rewritten or
deleted by the new writer. Local worktree storage retains its existing format.

`BENCHMARK_HUB_V2_WRITES=true` separately enables new-domain mutations. Any
other value leaves the service in read-only preview: Hub mutation entrypoints
reject with retryable503 and Retry-After5 while validated GETs continue to read both
archive and selected epoch. Missing or incomplete index state can still return
truthful503 while cold repair is disabled. Cold archive-index repair is disabled in this mode.
This is a planned Hub write-admission maintenance window, not zero downtime.

Before write-on, the operator must establish that every reader accepting Hub
traffic and the retained rollback artifact implements this document and targets
the same epoch. During the reader-floor rollout old processes may still write
legacy addresses; these writes cannot overwrite new-domain objects. Routing and
maintenance approval remain operator responsibilities. No accepted legacy PUT
has been certified drained by this source work.

## Publication and archive semantics

One new catalog contains epoch, revision, published runs, and persistent claims
in pending, published, or hidden state. Validated batches persist PENDING before
writing bodies. The final catalog CAS publishes rows and exact acknowledged
body ETags after bundle, compact-index and visibility writes. Caller ACK and
cache updates follow successful SQL transaction completion. No SQL or CAS
mutation is automatically replayed after an ambiguous failure.

All CAS observations are keyed by physical prefix and key. Unique publication
envelopes apply only to the fresh domain; legacy bytes remain raw. A rejected
or incomplete publication remains pending and unavailable. It cannot borrow an
old bundle or old visibility success. A published body must match its committed
ETag and have new-domain visibilitytrue. Hidden claims remain tombstones even
when a late legacy catalog reinserts an old ID. Listing merges two catalogs and
suppresses every claimed legacy ID without per-run visibility reads.

Unclaimed runs can use legacy bundles only after confirmed absence of both new
body and new visibility objects. Orphan new objects fail closed. Agent mappings
from the new domain control claimed IDs; current legacy mappings control
unclaimed IDs. Index/revision pairs are validated independently. Cache identity
includes epoch and both domains' observed versions. Cold archive backfill may
persist only in the new domain and is bound to the legacy catalog/index/revision
observations; changed legacy observations require a new scan.

## Rollback and late legacy evidence

After any new-domain ACK, an old1577 artifact must never resume as the active
Hub reader or writer. Rollback must retain v2 readers, the same epoch, claim and
body-version checks, and the rollback floor. A safe maintenance rollback can
turn writes off while preserving v2 reads. Do not switch epochs or erase claims
to make an upload visible. A later epoch requires a separately reviewed archive
and read policy.

The old prefix is preserved as read-only archive and late-write evidence.
Unclaimed late legacy data remains readable; it cannot supersede a claimed new
ACK. Prefix isolation proves address separation, not legacy request completion,
production storage latency, or successful execution of the original600.
