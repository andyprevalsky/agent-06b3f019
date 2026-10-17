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

One new catalog contains epoch, revision, published runs, persistent claims,
and a committed compact-index/revision pair pointer. After validating a batch,
the owner allocates publication UUIDs in private SQL-owner memory. Bodies,
visibility and compact-index snapshots are written to new immutable publication
keys. A single final catalog CAS publishes their exact keys and acknowledged
ETags together. There is no new visible PENDING write. Caller ACK and resolution
cache updates still follow successful SQL transaction completion. No SQL or CAS
mutation is automatically replayed after an ambiguous failure.

An update failure before catalog commit leaves the previous acknowledged body,
catalog row and agent mappings readable. A failed first new-domain publication
leaves existing legacy data readable; an unacknowledged new ID remains absent.
Private staging objects do not establish a logical run's origin. Historic
PENDING claims created by the prior unactivated candidate still fail closed;
they are not silently reclassified as committed. Old fixed-key published claims
remain a read-only compatibility input, while new writes always use pointers.

The compact index and its revision are selected from the same captured catalog
head for both logical reads under the SQL owner, preventing a concurrent catalog
commit from tearing the pair. Every pointer is validated against its publication
role, generation and exact object ETag. Hidden claims are collected in the owner
and committed with all row/index changes in one catalog CAS, including group
deletion; no per-child catalog rewrite occurs. Claims remain null-prototype
own-key dictionaries even after cloning, preserving all valid run IDs.

All CAS observations are keyed by physical prefix and key. Unique publication
envelopes apply only to the fresh domain; legacy bytes remain raw. Hidden claims
remain tombstones even when a late legacy catalog reinserts an old ID. Listing
merges two catalogs and suppresses every committed claimed legacy ID without
per-run visibility reads. Current legacy mappings control unclaimed IDs;
committed new-domain mappings control new claims. Cache identity includes epoch
and both domains' observed versions. Cold archive backfill persists only in the
new domain, is bound to legacy catalog/index/revision observations, and publishes
its new index-pair pointer with one catalog CAS; changed observations require a
new scan.

## Immutable-version storage liability

Each bounded upload cohort stages at most its accepted run bodies/markers plus
one compact-index/revision pair and one final catalog. Multiple updates for one
run retain their distinct staged bodies. Superseded committed versions and failed
or ambiguous staging objects are retained. No automatic garbage collection,
expiry, globally bounded total storage, or production retention policy is
implemented or qualified by this change. A lost catalog response may still have
committed references, and in-flight readers may hold prior pointers; never delete
those objects inline or reuse their UUIDs. Production storage cost, retention
and activation remain explicit operator decisions, not a claim of free cleanup.

## Rollback and late legacy evidence

After any new-domain ACK, an old1577 artifact must never resume as the active
Hub reader or writer. Rollback must retain publication-pointer-aware readers, the same epoch, claim,
body/visibility version and paired-index checks. The earlier b7aa candidate is
not a valid rollback artifact after a pointer-format ACK. It was not deployed. A safe maintenance rollback can
turn writes off while preserving v2 reads. Do not switch epochs or erase claims
to make an upload visible. A later epoch requires a separately reviewed archive
and read policy.

The old prefix is preserved as read-only archive and late-write evidence.
Unclaimed late legacy data remains readable; it cannot supersede a claimed new
ACK. Prefix isolation proves address separation, not legacy request completion,
production storage latency, or successful execution of the original600.
