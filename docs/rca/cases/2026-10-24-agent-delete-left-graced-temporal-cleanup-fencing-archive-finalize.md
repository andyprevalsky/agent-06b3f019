---
id: 2026-10-24-agent-delete-left-graced-temporal-cleanup-fencing-archive-finalize
date: 2026-10-24
title: Agent delete left the graced Temporal cleanup row that fences the post-delete archive finalize
surface: back-end
component: agent-kill / trace-archive-finalization
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "back-end/src/providers/agentKill.ts deleteAgentRecursiveInternal — terminates the workflow but never discharges the TemporalWorkflowCleanup row that traceArchiveFinalizationRetry.ts assertDeletedTreeIsTerminal requires to be gone"
symptoms:
  - "[AgentKill] Trace archive finalization retained for retry after agent deletion"
  - "1 trace archive finalization obligation(s) failed"
  - "Trace archive agent <id> still has Temporal cleanup pending"
  - "AggregateError hides the inner error at agentKill.ts:72"
tags:
  - trace-archive
  - agent-kill
  - temporal-cleanup
  - teardown
  - observability
sources:
  - agent 5cce9d33-72bb-4d85-9dee-70c6b1482507 (descend-full69-20261023 proof 2 r004-j0055, 23:17:06.482Z; 70/70 copies)
  - fleet run 20261023-230227-25502
repro: back-end/src/tests/unit/archive-clears-attention.test.ts "deleting a completed root discharges its Temporal cleanup and finalizes the archive"
status: fixed
---

## Problem

Every benchmark teardown DELETE (70/70 copies) logged `WARN [AgentKill] Trace
archive finalization retained for retry after agent deletion error=1 trace
archive finalization obligation(s) failed`. This came 100 ms after a successful
worker `POST /api/archive/agent-finalize` (`Trace archive finalized ...
artifact_count=32`). The AggregateError text did not include the inner cause.

## Diagnosis

Critical path: agent COMPLETED → schema trigger `enqueue_temporal_workflow_cleanup`
inserts a `TemporalWorkflowCleanup` row (5-minute grace) and sets
`temporalCleanupPending=true` → benchmark teardown `DELETE /api/agents/:id` →
`deleteAgentRecursive` soft-deletes, enqueues the root finalization obligation,
terminates the workflow ("workflow execution already completed", handled) →
`runTraceArchiveFinalizationRetries({ignoreGrace:true})` →
`assertDeletedTreeIsTerminal` throws `Trace archive agent <id> still has
Temporal cleanup pending` → `retain()` sets 60 s backoff → AggregateError → WARN.

The first bad point is the kill path. It confirms that the workflow is no longer
running, but it leaves the graced cleanup obligation that fences R2
finalization. Only the cleanup cron discharges that row. That cron is disabled
outside production (`[Cron] Temporal workflow cleanup disabled
reason=non-production`), so fleet obligations never finalize after deletion.
In production every delete still pays a WARN, a retained row and a delay of 5+
minutes. It was not a double finalize: the earlier worker finalize succeeded,
and the second, forced finalize records the deleted state.

Local repro: the new case creates a COMPLETED root with a workflow id. The real
trigger enqueues cleanup, and deleting it with archive enabled reproduces
`lastError=Trace archive agent … still has Temporal cleanup pending`.

## Solution

After the kill path has terminated the agent's own workflow, run the canonical
`cleanupTerminalAgentWorkflowZombies({agentIds:[id], ignoreGrace:true})`. This
is the same per-agent exact cleanup that `workflowReplacementStartAcceptance.ts`
already uses. It seals the generation, terminates the exact chain (a closed
workflow is tolerated), reconciles interrupted tools and discharges the row
before the archive retry. A cleanup failure is logged with its inner errors,
and the row stays for the cron. Temporal calls become injectable
(`AgentKillDependencies`) so the kill path is tested without a live server.
The finalization AggregateError message now includes each inner cause, so
`lastError`, the cron log and the AgentKill WARN all name the failure.

At 10k agents: deletion adds one indexed `TemporalWorkflowCleanup` lookup per
deleted agent, plus one claim and discharge per pending row. Work stays O(tree
size) on the delete path, and nothing is shared or fanned in.

## Human feedback

None recorded.

## Reusable lesson

When a path performs the side effect that a durable obligation exists to guarantee, discharge that obligation through its canonical owner in the same path, or downstream fences will fail on every call.
