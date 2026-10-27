---
id: 2026-10-27-kill-path-awaited-unbounded-root-archive-finalization
date: 2026-10-27
title: SMS kill_agent reply never sent because agent delete awaited the root's minutes-long R2 archive finalization
surface: back-end
component: agent-kill / trace-archive-finalization
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "back-end/src/providers/agentKill.ts deleteAgentRecursiveInternal — after releaseTraceArchiveDeletion it awaited retryRootArchiveFinalization → runTraceArchiveFinalizationRetries → finalizeAgent → finalizeAgentOnce (indexArchivedTrace reads every llm/ artifact, 4 at a time) before returning to commitKillAgent inside the per-user SMS commit lock"
symptoms:
  - "[SmsSupervisorTools] Killing agent"
  - "[AgentKill] Failed to heartbeat trace archive deletion lease"
  - "Trace archive deletion lease lost for"
  - "Rose never replied to an SMS asking it to kill agents"
  - "DELETE /api/agents/:id slow for a large root archive"
tags:
  - trace-archive
  - agent-kill
  - sms-supervisor
  - user-reply
  - commit-lock
  - latency
sources:
  - agent 43082b47-f284-410a-a258-6fcd47651cce (SMS kill at 2026-10-27T21:07:22Z, user inbound seq 73, Render instance srv-d3jga77diees73cgrvk0-w4h75)
  - commit f9ee633d3 (inline root finalization on delete; hardened by 47d1da61a, 5c7b1752d, ab682b647)
repro: back-end/src/tests/blackbox/archive-kill-finalize.helper.ts (archive.blackbox.ts "SMS kill_agent does not await root archive finalization")
status: fixed
---

## Problem

Andy texted "I placed the orders myself, just killl these agents" at
2026-10-27T21:07:07Z. The SMS supervisor queued `kill_agent` for root
`43082b47` (round 0) and `send_user_message` (round 1). At 21:07:22.543
`flushPendingWrites` → `commitKillAgent` logged "Killing agent" and entered
`deleteAgentRecursive`. No reply was ever sent: the SmsSession transcript ends
with inbound seq 73 and the next entry is an unrelated lifecycle message at
22:25. Neither "Agent killed", "Pending op committed/commit failed",
"Deleted agent" nor any later SmsSupervisor line was logged for the run. The
webhook had already returned 200; the in-process run died with instance
`w4h75` when Render replaced it (deploy started 21:16:19, old instance's last
logs ~21:25).

## Diagnosis

Critical path: Surge inbound → `handleSmsSupervisorMessage` → round-1
`flushPendingWrites` (inside `withCommitLock` for the user) →
`commitPendingWrites` → `commitKillAgent` → `deleteAgentRecursive` → (only
after it returns) `deliverUserMessage`.

Prisma `db.query` log sequence for `TraceArchiveFinalization` on `w4h75`
(every query is logged, no sampling): 21:07:22.594 upsert (enqueue in the
soft-delete tx) → 21:07:24.614 updateMany (`releaseTraceArchiveDeletion`) →
21:07:24.627 findMany + 21:07:24.641 updateMany (`claim` by the kill path's own
inline `runTraceArchiveFinalizationRetries`). The kill path was therefore inside
`finalizeAgent(force)` from 21:07:24.641. `finalizeAgentOnce` reached the
planner-memory index at 21:07:41 ("planner memory embedded") and then
`indexArchivedTrace`, which reads every `llm/` artifact of the 8,777-artifact
bundle four at a time; "Trace archive finalized" logged only at 21:19:06.725,
followed by the `complete()` deleteMany at 21:19:06.774. The heartbeat at
21:07:52 failed with "deletion lease lost" because the kill path had already
released the lease and re-claimed the row under a new token — the heartbeat
timer kept running against a lease the same call had given up.

Other UI deletions in the same window (small roots, artifact_count 2) ran the
same inline finalize in ~3s and logged "Deleted agent", which is why this was
latent: the cost scales with the root's archive size.

Step 5a ladder:

1. The reply was not sent because `deliverUserMessage` runs only after
   `flushPendingWrites` returns, and that awaited `deleteAgentRecursive`.
2. `deleteAgentRecursive` did not return because it awaited the root's R2
   archive finalization inline, whose duration is unbounded (proportional to
   artifact count; ~12 min here).
3. The inline await was unnecessary: since 2026-09-04 the obligation is a
   durable, released `TraceArchiveFinalization` row that any finalizer can
   claim; the inline call only ran it eagerly on the caller's path. Stop:
   the next rung (archive design) is deliberate.

Sibling failures the same cause produces: UI Archive `DELETE /api/agents/:id`
and SMS `/clear` block their HTTP/SMS responses on large roots, and an SMS
`kill_agent` on a second large root would serialize the whole reply behind
both finalizations while holding the per-user commit lock.

Observability gap (recorded, not blocking the proof): the log stream does not
prove what the run did between 21:19:06.774 and the instance's end. The
heartbeat interval logged only once (21:07:52) although it should have fired
every 30s until `deleteAgentRecursive` returned, and no "Deleted agent" or
reply followed the 21:19:06 completion. The proven facts are that the kill
path entered the inline finalization at 21:07:24.641, that the finalization
ran until 21:19:06, and that no reply was persisted before the instance was
replaced. The fix removes the whole inline wait, so it holds whichever await
held the run after 21:19.

Adversarial review (Step 7) findings, recorded rather than resolved here:

- Sibling lease defect, open follow-up: the finalization claim lease
  (`LEASE_MS`, 10 min in `traceArchiveFinalizationRetry.ts`) is never
  heartbeated while `finalizeAgent` runs, and this root took longer than that.
  The production cron on the same instance ran its candidate `findMany` and a
  claim `updateMany` at 21:18:00.280/.297, about 36s after the kill path's claim
  expired at 21:17:24.6. A root whose finalization exceeds 10 minutes can be
  re-claimed and finalized a second time, and the first owner's `complete()`
  then loses its lease. The kill-path fix neither causes nor fixes this. The
  fix is to heartbeat the claim, or to size the lease above the worst-case
  finalization, in `runTraceArchiveFinalizationRetries`.
- The once-only heartbeat warning, and the absence of any SmsSupervisorTools
  line after "Killing agent", cannot both be explained by "still awaiting at
  21:19". The log stream does not prove whether the run was still inside the
  finalization or ended earlier without logging. In either case the user
  reply was ordered behind `deleteAgentRecursive`, and that call was inside a
  finalization lasting at least 11.7 minutes. Removing the inline wait removes
  that ordering. Nothing is known after 21:19:06.774, so the case keeps this
  observability gap.
- The regression's pre-fix duration of 5508 ms is the 5 s bound plus the
  test's `finally` releasing the held manifest lock. The pre-fix call does not
  return until that lock is released, so it blocks indefinitely and the
  failure is deterministic rather than threshold-sensitive.

Archive searches: "SMS kill_agent reply never sent deleteAgentRecursive trace
archive finalization blocked" and "Failed to heartbeat trace archive deletion
lease lease lost". Relative, not recurrence:
`2026-10-24-agent-delete-left-graced-temporal-cleanup-fencing-archive-finalize`
(same component; it fixed why the post-delete finalize failed, this case moves
that finalize off the caller's path). Novel mechanism.

Local reproduction (owning boundary, real SMS commit layer, local DB + local
archive backend): hold the root's real manifest lock to stand in for a long
finalization, then commit `kill_agent` through `commitPendingWrites` with a 5s
bound.

`cd back-end && CONDUCTOR_WORKSPACE_NAME=rcakill CONDUCTOR_PORT=4710 bash scripts/run-blackbox-tests.sh archive`

Pre-fix (main's `agentKill.ts`): `FAIL SMS kill_agent does not await root
archive finalization -- SMS kill_agent commit did not return within 5000ms
while the root archive finalization was still running; the user reply is
blocked behind it (5508ms)`; `Results: 13 passed, 1 failed`.
Post-fix, identical test bytes: `kill_agent commit returned in 27ms`,
`PASS ... (85ms)`, `Results: 14 passed, 0 failed`; then 4 more consecutive
passes.

## Solution

Delete the inline wait. `deleteAgentRecursiveInternal` still enqueues the
obligation in the soft-delete transaction and releases the deletion lease
after recursive cleanup, but now hands the root finalization to
`scheduleRootArchiveFinalization`, a per-process serial queue, and returns
immediately (the heartbeat timer also stops at that point instead of firing
against a released lease for the whole finalization). The idempotent
already-deleted path schedules the same way. The finalization keeps its
claim/lease, retain/backoff and error logging; a crash leaves the released row
for the production every-minute cron. Local and benchmark stacks, where that
cron is disabled, still finalize through the queue.
`waitForScheduledRootArchiveFinalizations()` lets tests (and any future
graceful-shutdown hook) await queued work; the existing
`archive-clears-attention` unit assertions now await it and are otherwise
unchanged.

Fixes the SMS `kill_agent` reply, UI Archive and `/clear` latency for large
roots. No approval-gated surface (no prompt/LLM-visible text, Zod schema,
recovery/terminal semantics or trajectory injection). Golden reference: not
applicable (no approval-gated hunk).

10k-agent behavior: a kill now does O(1) DB work on the caller's path
regardless of archive size, and the per-user SMS commit lock is held for
milliseconds instead of minutes. Finalization work per process is serialized
(one root at a time, same `maxConcurrency: 1` per call as before), so a mass
kill cannot fan out unbounded concurrent R2 reads in one instance; additional
backlog is shared with the production cron's bounded batches (100 rows,
concurrency 4) through the same lease-protected rows, which also keeps a
backlog from depending on one instance staying alive.

Status: verified locally on branch `fix/sms-kill-reply-archive-finalize-inline`;
not yet deployed — update `sources` with the merge PR when it lands.

## Human feedback

None recorded.

## Reusable lesson

Never await work whose cost scales with an agent's history (archive finalization, indexing, export) on a user-facing kill/delete/reply path — persist the obligation and discharge it off the caller's path.
