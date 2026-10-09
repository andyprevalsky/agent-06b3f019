---
id: 2026-10-09-hub-index-repair-scanned-archive-inside-writer-lock
date: 2026-10-09
title: Hub index repair scanned the whole archive inside the writer lock and wedged every write
surface: back-end
component: benchmark-hub-store
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/benchmarkHubStore.ts readAgentRunIndexForMutation answered a trailing compact index with rebuildHubAgentRunIndex, a strict read of every archived run bundle inside withIndexLock
symptoms:
  - Rebuilding malformed Benchmark Hub agent-run index during locked mutation
  - Benchmark Hub agent-run index trails its durable revision floor
  - "Invalid Benchmark Hub run bundle on POST /api/benchmarks/runs"
  - "HubVisibilityError: benchmark Hub upload failed: The read operation timed out"
  - POST /api/benchmarks/runs hangs for minutes while GET /api/benchmarks/runs is fast
tags:
  - benchmark-hub
  - index-repair
  - writer-lock
  - partial-publication
  - writer-reader-contract
sources:
  - PR #1454
  - fleet run 531e354f-d3de-4e03-8d3d-4d19f3a87abc
repro: back-end/src/tests/blackbox/benchmark-hub-index-read.blackbox.ts
status: fixed
---

## Problem

From 2026-10-08T22:49:36Z, every production Benchmark Hub write
(`POST`/`DELETE /api/benchmarks/runs` on the Render backend) stalled or failed,
while reads stayed fast. A minimal valid run upload got no response within 120 s.
`/deploy` Step 13c (`agent-payment-production-abandonment`) failed at its
required pre-run Hub registration (`HubVisibilityError: benchmark Hub upload
failed: The read operation timed out`). Local benchmark runs could not mirror
their final bundles, so their durable `roselabs.ai/?agent-id=` links returned
"Run not found".

## Diagnosis

Runtime evidence, read-only:

- Render logs: at 22:49:30.778 a burst of Postgres `Software caused connection
  abort` (P1017). At 22:49:33.734 one `POST /api/benchmarks/runs` returned 500
  `read ECONNABORTED` after 2,789 ms. At 22:49:36.079 the next write logged
  `Rebuilding malformed Benchmark Hub agent-run index during locked mutation`
  (`trails its durable revision floor`). Every later write repeated it, failing
  with `Server has closed the connection` (22:51–23:01) and then `Invalid
  Benchmark Hub run bundle` (23:19, 23:37, 23:53, 00:10, 00:28, 01:56, …).
- R2 `benchmark-hub/`: `index.json` (5,374 runs) and
  `agent-run-index-revision.json` (revision 14184) were both last written at
  22:49:33. `agent-run-index.json` was still revision 14183 (22:49:26,
  `complete: false`, 19,878 agents).
- HEAD of every catalog bundle: 39.2 GB in total, mean 7.3 MB, largest 103 MB.
  A strict parse of every bundle under 4 KB found 11 July 2026 hub-poller
  dispatch-error bundles (`{error, run_id, source, code, ...}`) with no `tasks`
  array, at catalog positions 5198–5293 (the oldest end).
- Production Postgres role defaults: `idle_in_transaction_session_timeout=1min`,
  `statement_timeout=2min`. No advisory lock was held when checked.

Causal chain:

1. Trigger: the transient network abort hit the agent-index PUT of a live
   snapshot of run `20261008-204907-14684` (uploaded 22:49:30.945). By then
   `writeAgentRunIndex` had advanced the floor and `storeRun` had written the
   catalog. The compact index was left one revision behind its floor. That
   run's root was already mapped by an earlier snapshot, so the write itself
   lost almost nothing. The design anticipates this partial publication; the
   existing control "failed publication remains retryable" exercises it, but
   with an empty catalog.
2. First-bad boundary: `readAgentRunIndexForMutation` repaired any
   inconsistency with `rebuildHubAgentRunIndex`, a sequential
   `getRunBundleStrict` over all 5,374 bundles inside `withIndexLock`. Prisma's
   interactive `$transaction` awaits its callback even past its 5-minute
   timeout. The in-process admission queue therefore stayed held, and
   same-process writes waited behind each roughly 17-minute scan; the
   `Invalid Benchmark Hub run bundle` failures recur about every 17 minutes.
   `parseHubRunBundle` rejects a bundle without a `tasks` array, so every
   scan that reached the oldest catalog entries threw. The 11 legacy bundles
   are what made the outage permanent. Without them, each scan would have
   published after about 17 minutes, which is still an outage but would have
   self-healed.
   Not proven: the role's 1-minute `idle_in_transaction_session_timeout` can
   release the advisory lock to another replica while a scan keeps running,
   but no log shows that kill. No request ID ties the P1017 `Server has closed
   the connection` errors at 22:51–23:01 to a specific write.
3. Deepest owned cause: one invariant had two repair mechanisms, and the writer
   and readers disagreed on the bundle contract.
   - The exact in-lock rebuild duplicated the existing `complete: false` path:
     lookups seed from partial mappings and a cooperative out-of-lock backfill
     later publishes `complete: true`.
   - `storeRun` accepted any non-array `tasks` and cataloged the run as zero
     tasks, while every strict reader rejected it. The same mismatch kept the
     production index `complete: false`, because the background backfill
     aborts on those bundles too: 5,792 of 12,203 catalog root agents were
     unmapped.

Local reproduction at the owned boundary: the real `putRun` runs against real
Postgres with an in-memory object store. The fixture is a compact index one
revision behind its floor (or unparseable), a catalog containing the run whose
mappings were lost, a stale pointer to a deleted run, and one legacy task-less
bundle at the oldest position. Command:
`cd back-end && DATABASE_URL=<local> DIRECT_URL=<local> node --import tsx
src/tests/blackbox/benchmark-hub-index-read.blackbox.ts`.

- Before the fix: both new controls failed with `Error: Invalid Benchmark Hub
  run bundle`, exit 1.
- After the fix: all eight controls passed, exit 0.

A scratch replay of the actual production catalog, compact index and floor
documents through the fixed `putRun` repaired the index in 318 ms with zero
bundle reads. It published revision 14185, `complete: false`, 19,879 agents.
The unfixed code on the same replay logged `Rebuilding malformed …` and began
the archive scan.

Archive searches used the literal floor/rebuild strings and then the
upload-timeout symptom. This incident is a relative of
`2026-09-12-unlocked-hub-index-read-observed-partial-publication` (reader
consistency) and `2026-09-06-background-hub-child-index-sync-io-starved-backend`
(the origin of the strict rebuild). Neither covered the cost or the
termination of the locked repair, so this is not a recurrence.

## Solution

The locked repair is now bundle-free (`salvagedHubAgentRunIndex`):

- Root agents are re-derived from catalog summaries, with the newest upload
  winning, as for locked puts.
- Child mappings that still point at catalog runs are kept.
- The index is published at the durable floor with `complete: false`, and
  the salvage revision is recorded (`repaired_revision`).

The whole-archive rebuild is deleted. The single out-of-lock backfill is the
only way lost child mappings are restored. It may publish `complete: true`
only if its scan started after the latest salvage revision; an older scan
merges what it found and leaves the index incomplete for another pass. Its
merge applies the locked-put rule, newest catalog upload wins, to every agent
id: the scan records each agent's newest scanned run, and the merge compares
it with the current mapping by `uploaded_at`. A concurrent upload therefore
beats the scan, and the scan beats a stale salvaged mapping for a reused child
id (evidence-only projections repeat child ids under a new run).

Two adversarial reviews found the races this closes:

- Without the revision guard, a scan whose catalog read preceded a salvage
  could mark a lost run's children complete and leave them permanently
  missing.
- Without newest-upload merging, a reused child id stayed on the older run
  after a salvage and a completed backfill.

Both have checked-in assertions.

Bundle contract:

- The writer rejects a non-array `tasks` and always stores a task array.
- Readers stay strict.
- The archive backfill reads a stored non-array task list as an empty run
  only when the run's catalog summary also lists zero tasks. That is exactly
  what the earlier writer recorded, so a transport, truncation or
  catalog-disagreeing fault still aborts completion.

Siblings prevented:

- An unparseable index, an index missing above its floor, or a malformed floor
  no longer wedges writes.
- The background backfill can finish over the 11 legacy bundles instead of
  rescanning 39 GB with backoff indefinitely.
- Root lookups for every cataloged run work immediately after a salvage.
- A future writer-accepted non-array `tasks` can no longer break readers.

Golden reference: `codex/codex-rs/rollout/src/metadata.rs:199-260` and
`:300-375`. Codex repairs its session index with a leased background backfill
that has explicit completion status and watermarks, and counts and skips an
item that fails to parse instead of aborting. Foreground listing can return
indexed metadata without repairing it
(`codex/codex-rs/tui/src/resume_picker/page_loading.rs:38`). This fix moves
toward that shape: repair moves off the foreground lock, and completion is
explicit and fenced by revision. It does not adopt Codex's lease, checkpoint,
or skip-and-count: Hub strictness intentionally keeps a missing bundle from
completing the index.

10k-agent behavior: locked repair costs O(catalog tasks + compact entries) of
in-memory work with no bundle I/O, instead of O(archive bytes). Normal writes
keep their existing constant number of object operations. They still rewrite
the full catalog and compact index under the global lock, which this change
does not alter. The backfill stays one coalesced, backed-off, yielding scan per
process while the index is incomplete, and it can now terminate.

Remaining risks, unchanged here:

- The S3 client has no request or socket timeout, so a half-open R2 socket
  inside the lock could still stall the in-process queue.
- The 1-minute idle-transaction kill can release the advisory lock during a
  slow locked operation.
- `deleteRun` reads a group's member bundles inside the lock.
- A single missing bundle or transient R2 error restarts the full backfill on
  every replica, without a checkpoint.
- Cold processes return retryable 503s for unindexed lookups until a backfill
  completes.

Production verification: after deploy, the next write repairs the index, and
`/deploy` Step 13c's required Hub registration must succeed.

## Human feedback

The user asked to "fix it" after the initial report of the stalled production
Hub. No fix shape was corrected or rejected.

## Reusable lesson

Never make a writer lock wait on an O(archive) repair: salvage the bounded
state, mark it incomplete, and let the one out-of-lock backfill finish the
repair.
