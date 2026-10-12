---
id: 2026-10-06-hub-final-upload-starved-by-queued-live-snapshots
date: 2026-10-06
title: A final Hub upload waited behind every queued live snapshot at the serial index writer
surface: back-end
component: benchmark-hub-store
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/benchmarkHubStore.ts::withIndexLock admitted a one-shot final putRun in strict FIFO order behind superseded live snapshots; 2026-10-12: storeRun ran one whole-catalog read-modify-write per upload, capping the global writer near 20 uploads a minute"
symptoms:
  - "benchmark Hub upload attempt 1/4 failed transiently; retrying in 1s: The read operation timed out"
  - "durable hub mirror failed: benchmark Hub upload failed: The read operation timed out"
  - "HubVisibilityError: benchmark Hub upload failed: The read operation timed out"
  - "terminal Hub publication failed after resource release"
  - "initial Hub publication is pending; continuing with owned progress and terminal publication"
tags:
  - benchmark-hub
  - admission
  - starvation
  - advisory-lock
  - durable-mirror
  - group-commit
  - throughput-ceiling
sources:
  - PR #1416
  - benchmark run 1b963a23-fcaa-42c3-b0e2-cf258cedad51
  - fleet run 20261012-202209-3281026
  - fleet run 20261012-202210-3281129
  - fleet run 20261012-202209-3281450
  - fleet run 20261012-222628-2896286
repro: back-end/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
status: open
---

## Problem

The `/deploy` Step 6a AgentCard lifecycle gate for PR #1416 passed all four
tasks in run `1b963a23-fcaa-42c3-b0e2-cf258cedad51`
(`agent-payment-test-shop`, `-setup-resume`, `-idempotent-aba`,
`-abandonment`), then exited 1. Its required durable mirror POST to the
production Hub hit four client response-read timeouts (`30 s + payload/512 KB`
each) and raised `HubVisibilityError`, so no result-file marker was printed.
Earlier POSTs from the same run had returned 201 in 2.4–5.4 seconds.

Production stored that exact final bundle (`live:false`) at
`2026-10-06T08:36:40.873Z`, roughly 188 seconds after the first attempt and
after the client had abandoned it. The three retries were stored at
`08:37:36.588Z`, `08:37:38.803Z` and `08:37:41.364Z`. A later production GET of
the run returned 200. The safe receipts are kept in
`.context/hub-final-starvation-rca/` (`run-store-and-requests.safe.json` and
`store-census.safe.json`).

## Diagnosis

Critical path: the client POSTs `/api/benchmarks/runs`, `putRun` enters
`withIndexLock`, process admission runs, then the PostgreSQL advisory
transaction lock. The holder then does about seven R2 reads and writes (index,
compact agent index and revision, bundle, visibility) and returns 201.

The bounded Render census for `08:30–08:38Z` (two complete pages) shows 127
stores: 123 live snapshots from 50 distinct runs, at 16–24 stores per minute.
The only final stores in that window were this run's four. The single global
writer was saturated. After the 2026-10-05 repair, admission was strict FIFO, so
the final upload queued behind every snapshot already waiting. At about 2.5
seconds per store, its wait exceeded every response window the client allows.

The snapshots are superseded by each run's next snapshot. The final upload is
one-shot and absorbing, and the mirror requires it. Giving them equal priority
let the replaceable stream starve the irreplaceable write.

Archive search found
`2026-10-05-hub-index-lock-waiters-starved-sql-pool`. That case moved waiters
ahead of SQL connection borrowing and explicitly kept the serial writer's
throughput limit. This failure is the next layer of the same boundary, not a
recurrence of its pool exhaustion: no SQL cancellation or pool timeout appears
here, and every request was eventually stored. The 2026-09-10
ambiguous-commit case concerned replay before reconciliation; here the client
never saw a response. Main's same-day
`2026-10-06-starting-hub-timeout-aborted-fleet-before-execution` and
`2026-10-06-hash-only-hub-coalescing-lost-last-write` repairs share only
identical pending packets for one run. They explicitly keep admission order for
distinct runs, so a final upload still waited behind 50 runs' distinct
snapshots. No branch carried a priority repair.

## Solution

`withIndexLock` now keeps two waiter classes. Foreground work (final
`putRun`, `deleteRun`, index reads, backfill) is admitted before queued live
snapshots. Each admission still holds at most one SQL connection and the same
cross-process advisory lock. Rejected work still hands admission to the next
waiter. The transaction text and bounds, the R2 write order, final absorption
and the revision floor are unchanged, and the structural transaction-policy
fingerprint still matches. To stay under the `max-lines` cap, the read-only
run-detail projection moved unchanged to `benchmarkHubRunDetail.ts`.

Reproduction:
- The permanent blackbox drives the real `putRun` against in-memory R2 and the
  local PostgreSQL lock. A held snapshot blocks while two snapshots and then a
  final upload queue behind it.
- On the original store, it wrote `holder, snapshot-a, snapshot-b, final`
  (exit 1).
- On the repaired store, it writes `holder, final, snapshot-a, snapshot-b`, and
  the published index shows the final `live:false` (exit 0). The other five
  controls in that blackbox pass unchanged.
- The extracted-owner unit suite adds a priority control. After merging main's
  coalescing controls it passes 16/16.
- Main's "distinct packet content, run, source and live mode" control
  submitted a same-run final behind three queued snapshots. A prioritized final
  correctly absorbs those snapshots, which hid the coalescing check. The
  control now checks live mode against one pending identical snapshot; all of
  its other distinct-packet and order assertions are unchanged.
- The structural suite passes.

At 10,000 agents, each backend process still uses one SQL connection here,
plus one queued closure per waiting request, and processes coordinate through
the same PostgreSQL lock. A final upload now waits for at most the current
holder plus queued foreground work, not the whole snapshot backlog. Live
snapshot latency still grows with fleet width, because a single global R2
writer is a throughput ceiling. Sharding the index by run would remove that
ceiling; it is not part of this repair.

This case stays open until production runs the repaired store and a fresh
saturated-fleet final upload completes within its client window.

### 2026-10-07 recurrence: mandatory starting registration

PR #1440's original production `agent-payment-production-abandonment` gate
failed before creating a task. Its four unchanged required-upload attempts all
timed out, and the exact run's four visibility reads returned 404. Native Render
logs later show that same starting-only bundle committed 539.032 seconds after
its original timestamp. A canonical read then returned the original suite and
one `starting` row without an agent ID. The failed original remains failed.

The earlier priority repair covered finals, deletes and readers, but `storeRun`
still classified every `live:true` packet as a replaceable snapshot. Required
pre-agent registration is also a one-shot publication: the caller cannot create
an agent until it is visible. The existing blackbox now submits the actual
timestamp/suite/source/starting-task shape behind a held writer and queued live
snapshots. Against the original owner it writes holder, snapshots, registration
(one failure, eight passing controls). The unchanged command against the repair
writes holder, registration, snapshots (nine passing controls):

```sh
cd back-end
# DATABASE_URL and DIRECT_URL both target the existing owned localhost database.
node --import tsx src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
```

The repair derives admission from canonical bundle state: a nonempty all-starting
task list with no task-root or tree agent IDs uses the existing foreground queue.
Already-owned starting progress, mixed running progress and empty snapshots keep
snapshot admission. Final priority, same-priority FIFO, shared SQL/R2 locking,
identical-packet coalescing, final absorption and all HTTP bounds are unchanged.
There is no client priority flag or artificial phase marker. Deleting priority
would reintroduce the proven final starvation; this change unifies the existing
one-shot admission rule rather than adding another queue.

Searches for `benchmark Hub upload failed read operation timed out starting
registration` and `queued foreground live snapshot admission first registration`
found this case, the SQL-pool admission case, and the ambiguous-commit case.
This is a recurrence of incomplete one-shot classification, not a new pool or
transport failure. Golden references were read: Claude Code's
`src/utils/messageQueueManager.ts:158` preserves FIFO within priority while user
input precedes task notifications; OpenClaw's `src/process/command-queue.ts:179`
maps foreground and background to existing queue priorities. Codex's
`codex-rs/core/src/session/input_queue.rs` and Hermes' gateway were searched for
priority/coalescing; neither has this shared durable-Hub writer boundary.

Private original HTTP/Render/canonical receipts, the RED log and unchanged GREEN
log are hash-bound in `.context/hub-starting-registration-admission.private/` and
the deployment's private evidence directory. A first repair attempt incorrectly
used Set size for the existing array-returning ID helper and remained RED; its
log is preserved. The final candidate uses the actual helper contract.
These are owning-boundary proofs, not proof that the exact benchmark now passes.
The case remains open pending final source review, rollout and the unchanged
required production outcome; no original run or LIVE50 credit is changed.

### 2026-10-08 review recurrence: delayed initial registration replay

The final full review of PR #1442 found a distinct, existing store hazard: an
original registration with an unknown HTTP acknowledgement can reach the shared
writer after a peer retry has committed registration and subsequent progress.
That delayed all-starting packet replaced the newer bundle and agent mapping.
The same destructive path exists before this admission repair; local priority
alone cannot prevent it across backend processes.

The permanent normal `benchmark-hub-index-read.blackbox.ts` entrypoint now runs
three two-process controls through the actual store and local PostgreSQL lock.
The fixture replaces only R2 transport, holds the original request before store
entry, positively reads the peer's registration, commits status/root-ID/tree-ID
advancement, then releases the original. The frozen command above produced three
failures and nine unchanged passes before the repair, and twelve passes after
it. Every native child exits and is joined. Each case also proves that distinct
pre-agent starting content still updates and a final all-starting `live:false`
packet still commits. The existing sixteen admission/coalescing unit controls
retain their assertions; their ID-helper fixture now returns the actual array
type instead of a Set.

The locked store now absorbs an incoming live, no-agent, all-starting packet
only after the committed exact run has advanced task status, a root agent ID,
or an existing compact-index agent mapping. It uses the index already read for
the mutation, before any bundle/index/cache write. Group validation, ordinary
live progress, pre-agent updates, final absorption, HTTP bounds and retries are
unchanged. No new registry, queue, pool budget or client marker was added.
Foreground priority remains local to each process; PostgreSQL serializes
already-admitted cross-process writers without preempting them. Required first
visibility remains the caller's launch prerequisite.

The original pretask gate remains failed, with its same starting bundle's late
commit preserved. Its exact controller exited before task creation, so it had
no model/payment/provider allocation; this closure is not a passing gate.
Private frozen source/test hashes, actual RED/GREEN logs and peer review are
kept with the existing case's deployment evidence. This case stays open until
the composed repaired source is reviewed, deployed and its required outcome
is positively qualified. The full-review finding superseded an earlier
transient clean observation; the private ledger preserves and corrects that
invalid clean accounting to FINDINGS without backdating or changing any run.

Independent source and adversarial reviews verified the frozen five-file
candidate and original log/test hashes, then each reran the unchanged normal
twelve-control command successfully. Production qualification remains pending;
the immutable author receipt retains its original pending-review state.

### 2026-10-12 recurrence: an all-final burst exceeded the writer's throughput

LIVE50 trial 1 (`campaign-20261012-202154-3278589`) lost three jobs after their
resources were released: r001-j0025, r001-j0034 and r001-j0047 (runs
`20261012-202209-3281026`, `20261012-202210-3281129`,
`20261012-202209-3281450`). Each printed three `benchmark Hub upload attempt
N/4 failed transiently ... The read operation timed out` lines, then
`HubVisibilityError: benchmark Hub upload failed: The read operation timed out`
and `terminal Hub publication failed after resource release`. The campaign
recorded them failed with no infrastructure retry. About 45 controllers had
exited between 20:53 and 21:01Z after app-environment lock timeouts, so their
terminal uploads arrived together.

Render request logs for `POST /api/benchmarks/runs` (20:52-21:04Z) show one
completion every 3.0-3.3 seconds regardless of concurrency. Response times rise
with queue position, from 2.9 s to 29.6 s, and 50 requests ended `499` at 30 s
between 20:59:39 and 21:01:23Z. App logs from the single instance show the
advisory lock acquired in 6 ms, then about 2.85 s until `Stored benchmark run
bundle`. Stores peaked at 19-20 a minute (20:23, 20:59, 21:00 and 21:01Z). HEAD
on production R2 measured `index.json` at 7,715,116 bytes and
`agent-run-index.json` at 2,728,412 bytes, so every upload read and rewrote
about 20.9 MB inside the lock.

The three "failed" finals were in fact committed `live:false`, at
21:00:14.108, 21:00:49.337 and 21:00:52.196Z. That was 35, 3 and 1 s before
each client's fourth attempt began, and 65, 33 and 31 s before it declared
failure. Those fourth attempts started after the coalesced original had
settled, so each became a fresh write at the queue tail and committed again at
21:01:48-21:02:23Z. The same limit appeared at launch: after 50 simultaneous
starting registrations at 20:22Z, 10 controllers printed `initial Hub
publication is pending` after their single 120 s attempt.

Diagnosis. The critical path runs from the controller through
`hub_upload.py --upload-final`, which allows 30 s plus a size allowance per
attempt and four attempts with 1/2/4 s backoff (about 127 s in all). It
continues through `POST /api/benchmarks/runs`, `putRun`, coalescing,
`storeRun`, `withIndexLock` and the advisory lock. The locked work is: GET the
catalog, GET the agent index and its floor, PUT the bundle, PUT the catalog,
PUT the floor, PUT the agent index, PUT the visibility marker, then return 201.

- Why 1: the client gave up after four 30 s waits. The final path has no
  reconciliation (only live registration does). A retry that started after the
  original settled was a new write at the tail of the queue.
- Why 2: every response waited about 3.1 s per upload ahead of it.
- Why 3, the deepest owned cause: `storeRun` ran one whole-catalog
  read-modify-write per upload under the global lock. That fixed Hub write
  throughput at one upload per catalog round trip, and the rate keeps falling
  as the archive grows.

The 2026-10-06/07 priority repairs only reordered that queue. A burst made
entirely of finals, or entirely of starting registrations, has nothing to
reorder. That is why the earlier guardrail missed this. The same ceiling
produced the 10-06 starvation, the 10-07 registration that committed after
539 s, today's pending registrations and today's three finals.

Local reproduction (`.context/hub-burst-rca/` in the RCA worktree). The replica
runs the real `putRun`, the real local PostgreSQL advisory lock and a node:http
shim that, like Express, keeps processing after a client disconnects. R2 is
replaced by an in-memory bucket seeded with 7.7 MB and 2.7 MB catalogs, with
byte-proportional latency of 40 ms + bytes / 8 MiB/s. A single write takes
3.1 s server-side, against 3.0-3.3 s in production. Fifty concurrent real
`agents/benchmarks/hub_upload.py --upload-final` clients sent copies of the
failed run's terminal bundle.

- Original store: 10 of 50 failed with `HubVisibilityError: benchmark Hub
  upload failed: timed out` (the plaintext form of the TLS message). All 10
  finals were later committed `live:false`. The run needed 90 retries, 128.8 s
  and 53 catalog writes.
- Repaired store: 0 of 50 failed, with no retries, in 7.7 s and 3 catalog
  writes (one calibration upload plus two cycles).
- Forty clients on the original store all passed at 126.3 s, just inside the
  window. That matches production, where only the tail of the burst failed.

The permanent control `concurrentFinalBurst`
(`back-end/src/tests/blackbox/benchmark-hub-burst.cases.ts`, run by
`benchmark-hub-index-read.blackbox.ts`) holds one writer, then queues 40
fleet-shaped finals and one invalid upload. On the original store it failed
with `saw 41 catalog writes` (exit 1, 14 other controls passing). On the
repair it passes with all 15 controls (exit 0):

```sh
cd back-end
# DATABASE_URL and DIRECT_URL both target an owned localhost database.
node --import tsx src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
```

Solution. `storeRun` now enqueues; one pending cycle claims every queued upload
(at most 64) when it holds the lock. It reads the catalog and agent index once
and applies uploads in arrival order against the cycle's evolving state. It
then writes bundles (in parallel across runs, in order within a run), one
catalog, one agent index and the visibility markers. The ordering checks, group
validation, final absorption and the delayed-registration guard are unchanged
per upload. A validation error rejects only its own upload. A storage failure
rejects the whole unpublished cycle. Resolution caches update in commit order
after publication.

With a single pending cycle carrying every queued upload, an upload can no
longer wait behind a backlog of snapshots. The foreground/snapshot admission
classes were therefore deleted, and `withIndexLock` is plain FIFO (Step 6a).
The exact-run bundle readers moved unchanged to `benchmarkHubRunBundles.ts` to
stay under `max-lines`.

Test changes:

- The unit transaction counts that encoded one cycle per upload went from 6
  to 2 and from 3 to 2.
- The distinct-packet order is now stated per run.
- The priority unit control was replaced by FIFO-admission and failed-cycle
  controls.
- The four integration admission controls now assert that a queued final or
  registration commits in the very next publication.

The structural transaction fingerprint changed only through the comment inside
the `$transaction` call.

At 10,000 agents, a cycle costs one catalog GET and PUT and one agent-index GET
and PUT, plus up to 64 bundle PUTs and 64 visibility PUTs across 8 lanes. A
cycle now commits up to 64 uploads instead of 1. Catalog bytes per cycle are
still O(archive); sharding the catalog would remove that remaining cost and is
not part of this repair. Client timeouts, attempt counts, gzip, coalescing and
the transaction bounds are unchanged.

A second production failure followed in LIVE50 trial 2
(`campaign-20261012-222613-2892947`). Thirty-three controllers finished
between 22:34:52 and 22:36:57Z after a capacity-guard herd. Render again shows
one completion every ~3 s and response times rising to 30 s; 41 requests ended
`499`. Job r001-j0044 (run `20261012-222628-2896286`, the last to finish)
printed the same `HubVisibilityError` and `terminal Hub publication failed
after resource release`. Its final was stored `live:false` at 22:36:25.040Z,
32 s before the client declared failure. The fourth attempt was a fresh replay,
which committed again at 22:38:11Z. Every one of the four production failures
was therefore a committed final reported as missing.

That is the second, client-side gap. The 2026-09-10 ambiguous-commit repair
reconciled only live registrations, because a visible run does not prove that
its final was stored. `hub_upload._post_run_bundle` now reconciles every
retryable required failure before replaying it or declaring it failed:

1. It waits the existing backoff, so an abandoned request has time to commit.
2. It reads the run back from the same Hub base it posted to (a durable mirror
   never trusts its local primary).
3. It accepts the read back only when the identity matches: a live
   registration must be visible; a final must read back `live:false`, with
   per-task name, verdict, status, root agent, lifecycle stage, startup label
   and failure reason projected exactly as `taskSummary` stores them.

A different committed outcome, such as a later cancelled re-upload, still
replays and fails closed. Attempt counts, timeouts and payloads are unchanged.

The agents blackbox control
`hub_terminal_upload_reconciles_committed_final_before_replay` uses the run
view that the real backend returned for the trial's terminal bundle, captured
through the replica. Against the original client it failed with
`HubVisibilityError('benchmark Hub upload failed: timed out')` while the five
existing Hub controls passed. Against the repaired client, all six passed.

The campaign still blocks an infrastructure retry when terminal publication is
genuinely missing; that remains the documented user policy. Re-publishing
before retry would change that contract and was not done here.

Golden references:

- Claude Code `src/utils/sessionStorage.ts:606-680`: `enqueueWrite` queues each
  entry with its resolver. `drainWriteQueue` splices the whole per-file queue,
  appends one batched write and then resolves every caller, rescheduling if
  more entries arrived.
- Codex `codex-rs/thread-store/src/thread_metadata_sync.rs:672-703`: metadata
  touches coalesce into a pending update that flushes at the next barrier.
- OpenClaw and Hermes were searched for `writeQueue`, `flushPending` and batch
  persistence; neither has a shared single-writer catalog.

The repair follows the common pattern: accumulate writers while one write is
in flight, then flush once.

This case stays open until production runs the repaired store and a fresh
LIVE50 terminal burst publishes without response timeouts.

## Human feedback

The user asked for the full `/deploy` after the messaging-mock change. That
requires every Group 4 gate to pass on the merged tree, including the durable
evidence mirror. Benchmark tasks, client timeouts and retry counts were left
unchanged.

## Reusable lesson

Commit every write queued behind a serialized whole-catalog writer in one shared
read-modify-write cycle; per-write cycles cap throughput, and priority only
reorders a queue that a burst of equally important writes still outgrows.
