---
id: 2026-08-04-no-liveness-reconciler-for-externally-closed-workflows
date: 2026-08-04
title: No job repairs an agent row whose Temporal workflow was closed out-of-band, so terminated agents stay ACTIVE forever
surface: back-end
component: agent-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agent lifecycle ownership — every terminal status write originates inside the workflow, and no scheduled job selects non-terminal agents and asks Temporal whether their workflow is still running
symptoms:
  - agent stuck ACTIVE with status_message "Processing" after its workflow ended
  - WORKFLOW_EXECUTION_STATUS_TERMINATED while the agent row is ACTIVE or PAUSED
  - front-end shows a permanent "Thinking" indicator for a dead agent
  - "Cannot resume agent because its workflow is not running"
  - agent pinned to the top of the sidebar indefinitely
tags:
  - temporal
  - agent-lifecycle
  - reconciliation
  - zombie-agent
  - observability
sources:
  - agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc
repro: back-end/.context-repro-d.ts (scratch; to be promoted to back-end/src/tests/blackbox/agents.blackbox.ts)
status: fixed
---

## Problem

On 2026-08-03 a cleanup script terminated 16 live production agent workflows (that
terminator is fixed separately). A day later, measured live against prod Temporal and
the prod API:

```
9edecb8d-b9be-4f70-b68b-2f56d2d1ebff  db=ACTIVE  temporal=WORKFLOW_EXECUTION_STATUS_TERMINATED
e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc  db=ACTIVE  temporal=WORKFLOW_EXECUTION_STATUS_TERMINATED
f0f03928-c3c0-4d0a-830f-c3183724dd00  db=ACTIVE  temporal=WORKFLOW_EXECUTION_STATUS_TERMINATED
1997c12e-674c-4786-87f7-5a80e8cdf879  db=PAUSED  temporal=WORKFLOW_EXECUTION_STATUS_TERMINATED
```

Of all 16: 3 ACTIVE, 5 PAUSED, 8 COST_LIMIT_REACHED, and **0 reached a failed state**.
`e14d5abb` still reports `status_message: "Processing"` with `updated_at`
2026-08-03T04:22:49Z.

## Diagnosis

The system assumes a single observer of an agent's death: the workflow itself.
`_mark_failed` / `_mark_complete` (`agents/workflows/agent_workflow.py`) are in-band
returns from `run()`. Temporal TERMINATE executes no workflow code, and
`@workflow.run` has no `try/finally` or `except BaseException` that would help even
under CANCEL. Kill the workflow and the only reporter of its death dies with it.

Nothing outside fills the gap:

* No scheduled job performs the repair. A scan of all 589 backend source files finds
  none that both selects non-terminal agents and queries Temporal
  (`back-end/.context-repro-d.ts`). The six registered crons are
  `scheduleTemporalWorkflowCleanup`, `scheduleGmailSync`, `schedulePlaidSync`,
  `schedulePurchaseHoldReconcile`, `scheduleAgentCardOrgWalletMonitor`,
  `scheduleProactiveSmsOutreach`.
* The one Temporal-aware cron runs the OPPOSITE direction:
  `cleanupTerminalAgentWorkflowZombies` finds rows that are already DB-terminal whose
  workflow is still Running, and terminates the workflow
  (`providers/workflowTerminalCleanup.ts:368`).
* No heartbeat or lease column exists on `Agent`; `updatedAt` is never compared
  against a cutoff in backend or front-end. (Two 30-minute stale-ACTIVE reapers do
  exist — `agents/benchmarks/run_benchmark.py:8679` and `scripts/pre-smoke-cleanup.sh:51`
  — but both are local-Docker-only, so prod has none. Both also key on `createdAt`
  rather than `updatedAt`, which would reap healthy 31-minute-old agents.)
* No workflow execution timeout is set at the sole start site
  (`providers/temporal.ts:418`), so Temporal's default is unlimited and nothing
  expires these.

So "forever" is literal. `FailureSource` even includes an `'agent_watchdog'` literal
(`errorAlert.ts:24`) with no implementation behind it.

User impact: the front-end treats live-ness as a deny-list
(`useThinkingVisibility.ts:54`), so ACTIVE renders a permanent "Thinking" shimmer,
pinned to the sidebar, with Stop the only enabled control. Resume returns
409 "Cannot resume agent because its workflow is not running" without changing status;
sending a message signals the dead workflow and swallows the error. Delete is the only
escape.

This is two defects: (i) no liveness reconciler; (ii) an out-of-band terminate with no
paired DB write — `cleanup-stale-workspaces.ts` imports no Prisma at all, unlike every
in-app terminate, which pairs termination with a status seal.

## Solution

`back-end/src/providers/workflowLivenessReconciler.ts` is the missing half of
`workflowTerminalCleanup.ts`: that cron kills workflows whose row is terminal,
this one seals rows whose workflow is already closed. Registered in
`serverCron.ts` on a 60s interval, gated by `DISABLE_WORKFLOW_LIVENESS_RECONCILE`.

It selects non-deleted, workflow-backed, non-terminal rows untouched for at least
5 minutes (a healthy agent PATCHes status on every LLM call, so quiet is the
signal), describes each in Temporal, and seals to FAILED only on an authoritative
closed reading — TERMINATED/COMPLETED/FAILED/TIMED_OUT/CANCELED or NotFound.
A transient Temporal error leaves the row untouched and is counted as
inconclusive; sealing a live agent on a failed read would be strictly worse than
leaving a stale row for the next tick. The seal is a conditional `updateMany`, so
it is idempotent and safe against a concurrent reconciler or a late in-workflow
write. `finalizeInterruptedWorkflowTools` closes dangling IN_PROGRESS chips so the
UI settles too.

Cemented in `back-end/src/tests/blackbox/agents-liveness-reconcile.cases.ts`.
Pre-fix (reconciler stubbed to HEAD behavior) 4 of 5 fail with the exact prod
symptom `agent previously ACTIVE should be sealed FAILED, got ACTIVE`; the
"Temporal reports RUNNING" control correctly passes both ways. Post-fix the agents
domain is 183/183.

10k agents: one bounded batch per tick, one describe per candidate, bounded
concurrency, no cross-agent shared state. Work scales with open workflows examined
per tick, never with total agent count.

Proposed, not yet implemented. A scheduled reconciler that selects non-terminal agents
with a `temporalWorkflowId` and seals any whose workflow is closed, reusing the
existing candidate query (`snapshotOpenRootWorkflows`) and the existing liveness probe
pattern (`agents/helpers/query_parent_state.py`, which already treats TERMINATED as
terminal for parents). Any out-of-band terminator must additionally pair its
termination with the DB seal.

10k-agent behavior: must be a bounded, batched sweep keyed per agent — one Temporal
describe per candidate with bounded concurrency, not a per-agent poller. The candidate
set is agents in a non-terminal state, not all agents.

## Human feedback

None recorded.

## Reusable lesson

If the only reporter of a process's death is the process itself, an external kill
leaves the record wrong forever — pair every out-of-band terminate with a state seal
and add a reconciler for the ones you miss.
