---
id: 2026-10-06-hub-final-upload-starved-by-queued-live-snapshots
date: 2026-10-06
title: A final Hub upload waited behind every queued live snapshot at the serial index writer
surface: back-end
component: benchmark-hub-store
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/benchmarkHubStore.ts::withIndexLock admitted a one-shot final putRun in strict FIFO order behind superseded live snapshots"
symptoms:
  - "benchmark Hub upload attempt 1/4 failed transiently; retrying in 1s: The read operation timed out"
  - "durable hub mirror failed: benchmark Hub upload failed: The read operation timed out"
  - "Benchmark command did not print a result file marker (exit 1)"
tags:
  - benchmark-hub
  - admission
  - starvation
  - advisory-lock
  - durable-mirror
sources:
  - PR #1416
  - benchmark run 1b963a23-fcaa-42c3-b0e2-cf258cedad51
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

When one serialized writer serves both a superseded stream and one-shot
terminal writes, admit the terminal writes first; FIFO lets the replaceable
stream starve the write that cannot be replaced.


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
