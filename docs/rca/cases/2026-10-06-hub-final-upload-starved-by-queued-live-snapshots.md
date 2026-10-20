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
  - hub run original600-1792319287448456235
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


### 2026-10-13 isolated continuation: source-bound batching and ACK controls

The continuation starts from PR #1480's exact checkpoint
`718ab9a1eed72ca17c8a768baa592330da38e3f1` in
`/home/boxes/rose-hub-original-reconciliation`, branch
`fix/benchmark-hub-original-reconciliation`. The original comparison file remains
byte-for-byte unchanged (SHA256
`a4a6089d5a26d8b2379ca96b4d51b387507ad333d233e27d429335313495efe5`).
The primary preservation branch and the other worker tree were not changed.

Original trial 2's summary and grouped record both remain failed: 48 passed jobs,
2 failed jobs, 50 original members, zero campaign credit. j0044's retained log
first rejects startup with `App capacity guard could not refresh machine state
after infra canary`, then reports four terminal Hub upload timeouts and
`terminal Hub publication failed after resource release`. It never supplies an
executed benchmark outcome. j0038's second attempt reports `primary runtime
evidence remains incomplete`; its exact external custody belongs to the parent,
not this continuation. No owner recovery, new trial or provider mutation was run.
The grouped original preserves both failed controller outcomes and all attempts.

Verified local copies of 284 original evidence members are retained privately
under `.context/original-evidence/`, with archive-member SHA256s in
`read-receipt.json`. This includes original burst server/client logs,
`blackbox-before-fix.log`, `blackbox-after-fix.log`, the actual captured bundle
and GET projection, and the six original backend domain receipts. Original test
passes are historical evidence, not qualification of the continuation. The
checkpoint handoff records interrupted development and pending review; this
continuation does not infer a clean source review from those old green tests.

The original causal owning regression was rerun with identical checked-in test
bytes against a private source fixture using `benchmarkHubStore.base.ts`, then
against the checkpoint store, on the new localhost database
`victoria_hub_original_reconciliation`. No source reset or extra worktree was
used. Commands (both `DATABASE_URL` and `DIRECT_URL` name that database):

```sh
node --import tsx .context/hub-validation/baseline-backend/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
node --import tsx back-end/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
```

The expanded permanent burst control runs 40 and 129 finals. RED observed 41
and 130 catalog writes. GREEN passes all 16 owning controls, publishes at most
64 uploads per cycle, uses at most eight bundle lanes, joins every lane before
ACK, and round-trips complete Unicode root and child transcripts. The 129-case
control exercises three queued cycles after the held writer. Existing delayed
registration, absorption, failed-publication, revision-floor repair and native
peer controls retain their assertions. The store's admission comment now states
the actual bounded-cycle behavior; it no longer claims an unlimited backlog
fits in one cycle or that every final waits only for the current holder.

A review of the original client repair found an incomplete ACK boundary.
`_upload_committed` accepted any visible row for a caller that requested
`verify_live_response`; `final_record_matches` compared outcome fields but
omitted immutable run/campaign identity. The new permanent agents blackbox
`hub_reconciliation_preserves_required_ack_identity` drives an actual loopback
HTTP POST failure and GET reconciliation. On the checkpoint it fails with
`foreign ACK accepted`, listing foreign timestamp, suite, source, campaign,
member and attempt, a boolean attempt, and stale/final live outcomes. After the
repair the same control passes. The existing ordinary registration retains its
visibility-only contract; verified-live callers use the same outcome predicate
as their successful POST response. Final reconciliation also compares the
published run/campaign identity with JSON type distinctions. POST bytes,
backoff, four-attempt policy, per-request limits and campaign clocks are unchanged.

The original terminal-reconciliation blackbox was also rerun against the
checkpoint's parent client (`a040520d51bdd3cf543ba8c1b7c157b7c64404c0`), loaded
explicitly from a private source fixture. RED reports `benchmark Hub upload
failed: timed out`; the same owning function is GREEN on this continuation.
The fixture logs the actual imported source path so a cached current module
cannot masquerade as a baseline. An initial fixture-loader attempt selected a
cached current module and was rejected as invalid baseline evidence; it supplies
no causal credit.

The normal structural gate initially reported 1511 passing checks and one
failure: the checkpoint preserved `benchmarkHubStore.base.ts` but did not
register its historical transaction fingerprint. The comparison file was left
untouched. Its exact `withIndexLock` fingerprint now has a separate exception,
and the existing layer-deps gate pins the complete original file SHA256. The
unchanged structural command then passes all 1512 checks. The active store's
exception remains distinct; editing the comparison cannot hide beneath it.
Original review-cycle receipts name `718ca050` and `89b132d1`, not the PR1480
candidate; they are not a source-review qualification of this composition.

The focused command is retained privately as
`.context/hub-validation/run-hub-blackbox.py`; it invokes the checked-in owning
functions using the existing BlackboxResult runner. New test registration is in
`benchmark.blackbox.py::run_tests`, so the full ordinary agents blackbox/coverage
path discovers it. Seven selected offline Hub blackboxes pass; the uploader's
35 pytest controls pass. This focused selection deliberately avoids the full
benchmark domain's paid LLM-judge replays and does not replace full deploy
coverage. Six affected backend domains pass via the normal
`back-end/scripts/run-blackbox-tests.sh` with the isolated DB, backend port
19531 and task queue `navi-agent-tasks-hub-original-reconciliation`.

The existing compact `benchmark-live-results.test.py` control passes 535 tests
with 4 declared platform/privilege skips and 851 deselected by its committed
selector; no selector or assertion was changed. The skips are one Darwin physical
allocation control and three Linux root-only runtime-cache permission controls
on this UID-1002 host. Campaign grouping passes all
24 tests, and the deploy registry control passes all 20 tests. These are normal
offline controls, not a full deploy or LIVE execution. Typecheck, changed-file
ESLint/Prettier, blackbox-registration structural checks, RCA validation and
Python dependency/compile checks pass. All original archive bytes and the
comparison provenance remain retained.

Searches for `HubVisibilityError read operation timed out` and
`whole catalog queued terminal publication` identify this recurrence and the
ambiguous-commit case. The original golden-reference batching comparison was
read again at `claude-code-src/src/utils/sessionStorage.ts:606-680`: it groups
pending entries and resolves callers after each bounded append. The existing
Hub ACK predicate is the closer owned reference for reconciliation; reuse it
instead of treating presence as a stronger publication proof.

The client repair is constant work per identity field plus the bounded task
projection; it introduces no new queue, registry, SQL call or polling loop.
Batch catalog work remains O(archive) per bounded cycle, and pending requests
remain subject to the original server/transport limits. These causal tests do
not attribute every original startup problem to Hub batching, prove an exact
benchmark outcome, certify production/R2 timings, or establish 10,000-agent
capacity. The RCA stays open: independent source review, normal full deploy
qualification, rollout and the unchanged exact benchmark/LIVE50 outcome gates
remain pending under the user's no-paid-test/no-deploy instruction.


#### Parent source review follow-up

The existing parent thread independently reviewed the composed candidate
`42436f4f59e324583f63e4b536ef555d62889116`. It accepted the original batching,
lock and partial-failure design with the existing catalog/read-detail fences,
but found that verified-live reconciliation still called a predicate that
omitted the immutable identity added to the final matcher. That predicate also
used Python tuple equality, which equates numeric `passed=1` with boolean `True`.
This is a recurrence of incomplete ACK equivalence, not a new storage design.

The **same** permanent ACK blackbox was extended before the follow-up fix. On
`42436f4f5`, RED lists seven verified-live foreign identity variants and numeric
`passed=1` accepted by both ambiguous GET reconciliation and a successful POST
response. The follow-up shares `_run_record_identity_matches` across final and
verified-live matchers and compares live task identities as serialized JSON.
Normal visibility-only registration, supported Hub response fields and every
transport/campaign budget stay unchanged. No backend projection architecture,
new outcome field or provider action was introduced. The unchanged extended
control passes, with one POST per case and the same body in every case; all
seven selected offline owning Hub blackboxes remain green.

The existing native HTTP outcome/guest-ACK fixture initially failed its positive
publication assertion because it returned only `run_id`, `live` and `tasks`,
while the real Hub summary also carries timestamp, suite, source and campaign
membership. Its loopback response now preserves that already-received identity.
The fleet early-publication fixture also returned that incomplete summary;
its unchanged no-spam assertion reproduced two POSTs instead of one. The same
response-shape correction makes the unchanged focused test pass, retaining
early outcomes and teardown assertions. Both corrected responses echo the
received immutable metadata; neither weakens the client's required ACK.
Every existing ownership, integer-version, terminal fence, guest ACK and cleanup
assertion remains unchanged. The focused two-family pytest command records the
original failure (36 passed/1 failed), then passes all 37 tests after the fixture
shape correction. Parent review and check logs are retained privately with the
source receipt; production and benchmark outcome qualification remain pending.

### 2026-10-14 release-evidence delay

WhatsApp media release verification passed all eight local smoke tasks, but
both terminal mirrors timed out. The seven-task final bundle entered the
production store at 23:13:42.332Z and committed at 23:31:23.624878Z, a measured
1,061.293 seconds later. Strict R2 reads at 23:26:49 confirmed the bundle and
visibility marker were still absent. The eventually stored body exactly
matched the unchanged canonical publisher body; the recovered index was
`live:false`, with all seven tasks passed. FE, recordings and the rendered last
LLM dump then verified through the canonical publisher.

During the delay, other runs continued committing. Of 145 logged live stores,
139 current durable index entries remained all-starting with no root IDs.
Those entries use the same foreground FIFO as finals after the earlier
registration repair. This is evidence of the remaining shared-writer admission
ceiling; the snapshot census is not an immutable capture of each original
request. The separate 23:16–23:17 gateway 502 burst is also retained. No new
local red/green admission reproduction or repair was completed in this media
investigation, so this case remains open. Private strict reads, exact body
comparison, store timestamps and the census are retained under
`.context/whatsapp-media-rca/hub-publication-rca/`.

## Human feedback

The user asked for the full `/deploy` after the messaging-mock change. That
requires every Group 4 gate to pass on the merged tree, including the durable
evidence mirror. Benchmark tasks, client timeouts and retry counts were left
unchanged.

## Reusable lesson

Commit every write queued behind a serialized whole-catalog writer in one shared
read-modify-write cycle; per-write cycles cap throughput, and priority only
reorders a queue that a burst of equally important writes still outgrows.

### 2026-10-15 V41 related progress-upload timeouts: cause remains open

The retained original V41 `r001-j0077` log (SHA256
`f3beb20dcf8230639638cbd31f580afda10ed0d357d864f4628ce58fdee2679b`)
contains sixteen nonfatal `The read operation timed out` upload warnings.
These are separate from its first authentic serialized-inventory-refresh error
and the later organization Machine-limit refusal. The strict campaign's original
1/1 infrastructure stop remains disqualified; its final cancellation denominator
does not requalify it.

The read-only discriminator used guest uploader source `82b849ee` and the exact
source of the already owned private Hub service, `78491fd2`; these are different
source identities. The five reviewed server/store/router/tracing/ancestor files
and the database instrumentation match their live-service Git blobs. No HTTP,
provider or guest request, load replay, service mutation or runtime fix was run.

The existing server log records 35 stores of the exact run
`20261015-200010-17187`, including a final store at
`2026-10-15T20:29:33.121Z`. In the V41 time window, 5,061 completed POST response
logs have HTTP 201; 113 exceed the client's **base** 30-second window. Their
median is 14.439 seconds, p95 29.063 seconds and maximum 61.821 seconds. These
are shared Hub traffic and completed-response observations, not a census of
failed/aborted requests or matches to the sixteen warning lines. The effective
client window also includes its payload-derived allowance; the exact failed
request bodies and their effective windows were not retained here.

The frozen uploader serializes JSON and gzip before opening the request. The
non-required live-progress path uses one attempt and returns false with a
nonfatal warning; verified progress updates its coalescing state only after a
matching response. Required uploads retain their exact-read reconciliation.
The exception can arise while opening/reading headers or while verifying the
response body; its string alone does not distinguish these stages. Initial
serialization is outside the socket read, although this does not exclude
indirect resource contention.

The live service groups up to 64 uploads per catalog transaction with eight
write lanes, admits catalog cycles through the existing serial writer, and
returns HTTP 201 after `putRun` completes. The legacy HTTP duration runs from
its middleware entry through `res.finish`. Five response rows over 60 seconds
pair with their immediately preceding HTTP trace-end rows. Two have successful
same-request `$executeRaw` durations of only 1 and 3 ms. That bounds those raw
query spans, not transaction checkout, admission wait or R2 work; grouped work
can also execute under a different cohort creator's request context. There are
no retained request-specific admission/R2/catalog phase intervals.

Archive searches were `The read operation timed out hub upload` and
`Hub final publication serial writer timeout`. This incident is a **relative**
of this case and the September 10 ambiguous-commit case, not an established
recurrence of their particular first-bad boundaries. The current server already
has group commit; the observed delay must not be assigned to the old one-upload
writer or a generic scheduler/network explanation without an owning RED.

The finite read-only result is a positive server-latency discriminator plus an
open phase/correlation gap. Missing originals are the exact failed client's
transport timing/response stage (the existing publisher emits a source-owned
`hub-live-publication.events.jsonl`) and a request-to-run/admission/storage phase
binding. No new guest read was authorized for this lane. No owning local RED or
unchanged benchmark outcome proof exists, so no runtime repair or longer timeout
is proposed. Private bounded original tails, source hashes and safe projections
are retained in `.context/stress600-root/i41-hub-upload/`.


#### V41 client timing operand recovered without a second query

The operator's existing coalesced original-attempt reader subsequently captured
the exact source-owned `hub-live-publication.events.jsonl`: 3,781 complete raw
bytes, SHA256 `619efa217e4b41fe5fd5ee20f710af2c0c115ec128225911d89c876ce01cb178`.
Its ACK-validated outer receipt binds host `2862e42f0973e8`, boot `71360121`,
source `82b849ee` and the unchanged original epoch; API calls and native mutations
were zero. The safe event projection matches that outer receipt exactly and
contains no malformed or partial rows.

There are 36 progress-upload events: 20 verified successes lasting
7.938–28.030 seconds and 16 unverified results lasting 32.077–34.262 seconds,
matching the original sixteen nonfatal warnings. All report one queued task.
The guest event window is `20:07:30.441–20:27:33.550 UTC`. This closes the missing
client wall-clock/whole-upload-duration operand from the preceding note. Its
monotonic elapsed timer includes JSON/gzip preparation, HTTP and response-body
verification, so it is not a pure HTTP measurement.

The existing schema contains no payload byte count, effective timeout, request
ID, HTTP status or headers-versus-body failure stage. Exact warning-to-server
request correlation therefore remains unknown. Same-run store records that
fall inside a client interval are only temporal candidates: coalescing and late
commits prevent one-to-one counting, and no guest/backend clock-offset estimate
was retained. Nothing here labels the old mutation uncommitted or changes the
original attempt classification. The RCA remains open without an owning local
RED; no timing extension or runtime patch is justified by this recovered operand.
The private hash-bound fold is `i41-hub-upload/client-server-interval-fold.safe.json`.

#### V41 bounded request-join design (2026-10-15; unapplied)

The live `78491fd2` tracing middleware already honors and echoes a caller's
12-hex `X-Request-Id` and carries it in HTTP request start/end traces. Original
`82b849ee` uploader requests send no ID; its successful-response verification
also ignores that echoed field, and its four-field client event cannot join a
request after a timeout. Three native-free controls executed the exact original
Python function bodies with tiny preparation/socket fixtures: success, timeout
in opener, and timeout reading response. All lack a client/server join; the
two timeout stages have the same recorded shape. Three controls executed the
full unchanged server tracing module, transpiled using the existing toolchain,
with fake request/response objects: absent-header generation and two distinct
caller IDs retain consistent echo/start/end IDs. No HTTP/server/provider/load
was run. These prove an observability gap, not the historical timeout cause.

A design-only candidate reuses that existing header with a fresh safe ID per
POST attempt and records bounded source-bound attempt timing in the existing
client event path. It does not change verification, retries or timeouts. The
existing same-run in-flight coalescer can return one promise to multiple request
contexts; cohort work also inherits its initiating context. Consequently storage
or queue timing cannot be attributed to all requests from the leader's trace:
an explicit follower/leader/cohort join is required for any later deeper stage
capture. Logical `putObject` duration is not pure R2 request duration. No candidate
was applied, and no latency RED/GREEN or unchanged benchmark outcome is claimed.

Local design and six discriminator controls are retained under
`.context/stress600-root/i41-hub-upload/request-join-design/`; `review.safe.json`
SHA256 is `8f2c91d3fe0dfe48b2c42e705da80a6f727b82e3dc73b02f9be6e7407031444d`.
The original Hub timeout cause remains **OPEN** and this unrelated logging work
does not gate the next unchanged qualification experiment.

#### V41 client join candidate — causal evidence for missing metadata only

The first-join design was accepted for a client-only implementation. In the
existing author checkout at `1be6abe603720faddeaf3ebb101ebb5e535d48f3`, the owning
registered `agents/benchmarks/hub_upload_test.py` controls failed before editing
the uploader: five cases had no actual outbound request ID (success, open/read
timeout, wrong bundle ACK, malformed echo) and the retry case lacked its optional
collector. The identical six cases pass on the candidate in 0.04s. Twelve
mocked-transport controls pass in 0.13s, including four-attempt reconciliation,
exhaustion, unchanged compressed payload across retry, original programming-error
semantics, private diagnostic-write refusal, unchanged timeout derivation and
auth-absent behavior. No HTTP, server, provider or load test ran.

The candidate sends a fresh random 12-hex ID per POST using the existing header
and appends only typed bounded attempt metadata to the existing private live
publication event. Existing event fields and upload boolean/bundle ACK semantics
remain intact, including when an echoed ID is malformed. Required retries and
terminal reconciliation code are unchanged. There is no backend edit or restart,
no deadline increase, and no storage-timing claim. The two source paths remain
uncommitted and frozen for the parent's review. Packet
`.context/stress600-root/i41-hub-upload/client-join-component/component-review.safe.json`
SHA256: `a59d6c6a9bd3a516ddf4312f684cbd1fd6555d63e41750f16e1e637fed8f4240`.
This repairs a reproduced missing-observation boundary if accepted; it does not
establish or cure the original upload timeout cause, which remains **OPEN**.

The scoped observation repair was accepted after the parent's independent six
controls also passed (0.04s), then committed normally as
`a828d9d6eb42341959603677fc6978854ed16031`, changing only the uploader and its
registered test family. Actual native-recipe production on that committed ref
returned fingerprint `ac0900ebfd53787c910f42db3665f866ea946ebc4874f6db91594e57154d2dad`
unchanged; the uploader SHA256
`90a19012a3e47b2810711b520e6c741a264c108d9186ca18d19e4bc9d7e577fc`
requires an explicit extra source binding outside those25 files. This source
checkpoint is not a live rollout or outcome proof. Historical latency cause
remains OPEN, and no server change, HTTP request or paid trial was made here.

### 2026-10-18 recurrence at width 600: offered live load collapsed the Hub

Run600c (`original600-1792319287448456235`, 20 disposable controllers × 30
copies, release 10:50:29Z) exited 1 on every sampled copy, including passed
tasks (shard-09 `r001-j0010`), with `❌ terminal Hub publication failed after
resource release` after four `The read operation timed out` attempts.

Runtime evidence, correlated through the per-attempt request IDs:

- Client: live payloads were about 1 KB (about 0.5 KB gzip), so payload size was
  not the cause. From 10:43Z every shard-09 attempt timed out in phase `open` at
  about 30 s, roughly 60 attempts/min per shard. Request `acb1a3273983` has a
  server `span.start` at 10:50:34.9Z and no `span.end`.
- Server (one Render instance, 4 CPU / 16 GB): POST starts ran at 747/min
  (10:40), 1,037/min (10:43) and 1,116/min (10:52). Group-commit cycles of at
  most 64 ran every 10-15 s, so the Hub admitted about 4-6 uploads/s while being
  offered about 18/s. The 10:52 window shows zero POST responses, yet each cycle
  still stored 56-64 uploads, all from clients that had already timed out.
  Goodput was zero and the FIFO backlog had no bound.
- Per-cycle cost grows with the archive: `index.json` was 21.4 MB decoded across
  19,155 runs (7.7 MB on 10-12). Every cycle reads and writes it, and every put
  copies the whole agent-run Map. Every `GET /runs/:id` also parses the whole
  index.
- The live publisher, not execution, offered the load. Each copy re-posted on
  every startup-label change and every 15 s while unchanged, and after a
  failure it retried on every 1 s tick.
- Terminal phase: final bundles are p50 4.2 MB, max 31.5 MB. From 10:56Z cycles
  stretched to 30-120 s. Postgres killed the advisory-lock transaction six times
  (`terminating connection due to idle-in-transaction timeout` at 10:57-11:08Z,
  followed by `Server has closed the connection.` for each 64-upload cycle).
  Instance RSS grew from 0.85 GB (10:54) to 6.56 GB (11:20) at about 2 CPU.
  Completed responses on all routes fell to 16, 4, 0, 1 and 2 per minute over
  11:16-11:20. Render recorded `server_failed` (unhealthy, `dial tcp
  …:10000: i/o timeout`, not evicted) at 11:21:23.98Z after `Server started` at
  11:21:12.7Z. User routes (agent polling, agent-queue pointer, AgentCard MCP,
  Slack webhook) were affected for about 5 minutes. No EMAXCONN/P2024 pool
  exhaustion was logged.

The 64-upload group commit from 10-12 raised throughput but kept the per-cycle
whole-archive cost. Priority/batching inside the server cannot help when clients
offer more than the cycle rate and the server processes abandoned requests.

Client/CLI repair on `fix/hub-publication-at-width`. No backend change and no
deploy:

1. A host-shared, file-locked token bucket per Hub URL
   (`BENCHMARK_HUB_LIVE_UPLOADS_PER_SECOND`, default 1/s per host). The sharded
   operator divides a 2/s global live budget by K shards. Status, agent and
   outcome changes keep a reserved token. Label/lifecycle churn and 60 s
   unchanged refreshes use only the surplus.
2. Failed live writes back off exponentially from 15 s to a 300 s cap, with
   jitter.
3. Terminal bundles take a host slot (`BENCHMARK_HUB_TERMINAL_CONCURRENCY`; the
   operator caps the global count at 20 in flight) that preempts low-priority live
   writes. They use a patient window (`BENCHMARK_HUB_TERMINAL_PUBLICATION_SECONDS`,
   1,200 s for shards) with jittered exponential backoff to 60 s, and an exact
   read-back before every identical replay. The Hub coalesces a replay with its
   still-queued copy. The window fails closed; payloads are never truncated.
4. Startup registration never waits. Without a token it stays pending, and the
   first budgeted live write upserts the same run.

RED/GREEN on the unchanged base `9d0025e93` vs the candidate, using the same
fixtures: one shard of 30 copies for 1,000 s offered 30,000 vs 100 live POSTs,
and a saturated (503) Hub got 600 vs 6 retries in 600 s. A terminal upload whose
Hub is busy for six POSTs failed after 4 attempts vs published after 7, with a
read-back between every POST.

Backend capacity remains O(archive) per write cycle. Holding at 10k agents
requires a backend change: shard or remove the global catalog read-modify-write,
and move R2 I/O out of the Postgres transaction. That needs `/deploy` and was not
done here. Status remains `open` for the backend cause.

### 2026-10-16/17 original-600 attempt58: required publication failure

Original task source `570830dbf17635e13d16a6f03b4d705f6b6443b1`, 200 unchanged tasks ×3, concurrency600 and original timeout/retry/acceptance settings were retained. Harness `b0fbd7742dde51446288c22601825a85981c1d0b` started at epoch1792192040.9586267. All601 cleanup-workspace reservations committed and were released; no reservation failure was observed. Both canonical shared-preflight tasks passed and their Machines were retired, but their required terminal Hub publication exhausted the original retries. The shared preflight recorded failure at23:31:44Z, preventing main-task execution.

The operator preserved34 distinct canonical INFRA_ERROR records and sent one exact-PID/birth-verified TERM to the original supervisor at the existing30/600 threshold. The terminal campaign summary retained600 cancelled jobs and ended23:36:24.640275Z. These cancellation outcomes do not erase the threshold evidence or turn this into an accepted benchmark. No main-task execution was observed. Controller, relay and children joined; the export was verified and controller destroyed. Its workspace and the two preflight volumes were observed pending_destroy, not permanently absent or non-billable. Four protected Machines remained stopped.

The verified archive SHA256 is `89b19b987e753c7fdc775000350f2cd9e4ce5b4aa1546769b67e057443cfaeb0`; manifest SHA256 is `e57898ec189d8b2b9063b6aa8a8eee133535d3a6237aa900e22a25391d1d7d46`. Archive-only audit `publication-archive-audit.safe.json` SHA256 `9c106d7a820e5775583edf2b3c2526658a6f71bcd94524eb42b8403dd683a4c4` identified600 distinct starting invocations (37 reported publication,563 pending) and600 distinct post-preflight cleanup publication invocations evidenced by retry warnings.689 warning lines are not689 unique runs. Run identity timestamps ranged23:12:10–23:13:41Z; these are not exact POST timestamps. Terminal CLI requests did not preserve request IDs or per-attempt timing, leaving an exact client/server join gap.

Read-only diagnostics from the same controller returned GET /health200 in0.406s and the exact preflight run GET404 in0.872s. This excludes neither queue delay nor other per-request storage causes. The production owner's bounded logs later contained live=false StoredBundle entries for all600 known IDs (894 matching log rows across a partial23:36:03–00:39:44Z window). Store log completion is not full payload verification, native task success or retroactive acceptance.

Exact reported production revision1577af0fdec6db02bb26aa05ba99596e66e99eff uses a shared foreground FIFO/PG advisory lock with one catalog cycle per distinct upload; starting registrations and finals share that queue. The separate offline owner reproduced41 catalog writes/transactions for41 tiny inputs on that source and2 on the existing batching candidate, with all41 persisted. This proves source-level amplification; exact production timeout causality remains OPEN without request-specific queue/storage timing. New-prefix compatibility/fencing tests and actual PostgreSQL qualification are separate source proofs. They must not be represented as an unchanged600-task success or a deployed production fix.

### Isolated source continuation: bounded cohorts and fresh-domain claims

The repair groups at most64 uploads per catalog cohort with eight body lanes,
acknowledges only after the SQL transaction joins, and aborts/drains owned local
SDK work at its original SQL budget. Local drain is not remote rollback: an
accepted legacy unconditional PUT may still commit. The candidate therefore
writes only a fresh epoch prefix. Persistent catalog claims prevent pending or
hidden new state from falling back into an old archive success. New body ETags
are bound to the published claim, and all first observations are physical-domain
keys. Reader-floor and rollback requirements are recorded in
`docs/benchmark-hub-storage-cutover.md`. No production activation was performed.

Permanent owning coverage runs through the normal backend blackbox runner:
`benchmark-hub-reader-compatibility` covers actual Store/SQL/SDK-wire behavior;
`benchmark-hub-index-read` covers actual PostgreSQL and two-process retries,
repair,100 concurrent reader coalescing, and40/129/600-upload bursts. Original
frozen-B namespace and legacy-membership/floor/claim-suppression failures were
observed before their unchanged assertions passed. Unit admission, ownership,
ABA/CAS, and commit-rejection controls supplement these owners. A retained
34,227,674-byte payload round-tripped through the actual S3 SDK and a local
HTTP fixture with byte and nested-task equality; peak observed RSS was548512KiB.
That measurement is local, not a production memory-cap guarantee.

The case remains OPEN: these are causal mechanism and source-regression proofs,
not an unchanged600-task success, a real R2 experiment, or a deployed fix.
