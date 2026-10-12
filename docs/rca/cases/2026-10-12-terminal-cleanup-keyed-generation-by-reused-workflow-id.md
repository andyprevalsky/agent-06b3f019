---
id: 2026-10-12-terminal-cleanup-keyed-generation-by-reused-workflow-id
date: 2026-10-12
title: Terminal-workflow cleanup sealed and terminated a live follow-up run because root agents reuse Workflow ID = agent ID across runs
surface: back-end
component: workflow-terminal-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/workflowTerminalCleanup.ts sealCleanup/cleanupOne — sealed by temporalWorkflowId only, resolved an unknown run to the currently running chain, and finalized tool chips by a generation string shared with the agent's live follow-up run
symptoms:
  - Workflow ended without reporting a result (terminated or lost). Sealed by liveness reconciler.
  - Terminated stale workflow for replacement
  - Message write fenced after workflow replacement; stopping worker
  - Tool interrupted by deployment
  - agent died ~5 minutes after its previous task completed, during a follow-up run
tags:
  - workflow-generation
  - terminal-cleanup
  - deployment-sealed
  - follow-up-run
  - temporal-workflow-id-reuse
  - liveness-reconciler
  - chat-escalation
sources:
  - agent 572da2a5-4fc0-45f4-b9a7-d20b08e19a4e
  - agent 2dd470aa-b3b9-41ab-9475-75e37986298f
repro: back-end/src/tests/unit/workflow-terminal-cleanup-follow-up.test.ts
status: fixed
---

## Problem

Prod Mac-app agent `572da2a5-4fc0-45f4-b9a7-d20b08e19a4e` finished its first
task, then died during the user's follow-up. Its status became `FAILED` with
`Workflow ended without reporting a result (terminated or lost). Sealed by
liveness reconciler.` and its `temporalWorkflowId` became
`572da2a5-…:deployment-sealed:dba3827a-…`. No deploy happened. The
"deployment" wording is only the seal's label.

Evidence (all UTC, 2026-10-12):

- `01:31:17` "Manual escalation to agent mode" (`startAgentMode`) started run
  `01a12dbc`. Only `temporalWorkflowId` was written; `temporalFirstExecutionRunId`
  stayed null.
- `01:32:28` agent → `COMPLETED`; the `enqueue_temporal_workflow_cleanup`
  trigger inserted `TemporalWorkflowCleanup(agent, workflowId=agentId,
  firstExecutionRunId=NULL, notBefore=+5m)`. Temporal: `01a12dbc` COMPLETED at
  `01:32:33`.
- `01:34:38` follow-up message → `clearWorkflowForTerminalAgent` reopened the
  agent. `01:35:14` chat escalation started run `01a12dbf` under the **same**
  Workflow ID and recorded `(agentId, 01a12dbf)`.
- `01:38:00` cron `Temporal workflow cleanup completed discovered 1 sealed 1
  terminated 1`: `Terminated stale workflow for replacement
  first_execution_run_id=01a12dbf`, `Reconciled stale workflow tool calls
  candidate_count=5 interrupted_count=5`. Temporal history for `01a12dbf`:
  TERMINATED, reason `Restarting with new worker code`, by the backend identity.
- Worker: `Message write fenced after workflow replacement; stopping worker`,
  then 409s. `01:43:43`: the liveness reconciler found the sealed ID
  `NOT_FOUND` and wrote `FAILED`.

Sibling `2dd470aa-b3b9-41ab-9475-75e37986298f` (same night, Mac app). Its
obligation carried the exact old run `01a12d6c`, so the terminate was a no-op
(`Stale workflow already closed before replacement`). The seal still fenced
the live follow-up `01a12d6f`. That run kept running and spending, with every
write returning 409, until `01:15` (continue-as-new then COMPLETED). Meanwhile
the user saw `FAILED` from `00:17:47`.

Archive searches: `Workflow ended without reporting a result terminated or lost
Sealed by liveness reconciler`, `Tool interrupted by deployment generation
replaced by a deploy cooperative cutover agent died after deploy`,
`deployment-sealed successor workflow never started agent FAILED after deploy
replacement`. These are relatives, not recurrences:
`2026-09-29-force-clear-kills-approval-blocked-cutover-stragglers` (a different
killer of live agents: force-clear),
`2026-08-21-descendant-tool-writes-default-to-generation-one` and
`2026-08-21-chat-escalation-overwrites-workflow-generation` (the same identity
family). This exact cause is novel.

## Diagnosis

Critical path: run 1 completes → DB trigger enqueues a cleanup obligation with
a 5-minute grace → user follow-up reopens the agent and starts run 2 with
Workflow ID = agent ID → `cleanupTerminalAgentWorkflowZombies` (backend cron,
every minute) → `sealCleanup` → `resolveExecution` / `terminate` →
`finalizeInterruptedWorkflowTools` → worker fenced → liveness reconciler →
`FAILED`.

1. The obligation and the trigger were correct: run 1 had gone terminal.
2. First-bad boundary: `sealCleanup` decided ownership with
   `current.temporalWorkflowId === obligation.workflowId`. For a root agent,
   every run uses Workflow ID = agent ID, so the follow-up generation matched
   and was sealed (2dd470aa).
3. With an unknown run ID, `cleanupOne` resolved the Workflow ID's currently
   running chain, which was the follow-up, and terminated it (572da2a5).
4. `finalizeInterruptedWorkflowTools(agent, generation=workflowId)` used a tool
   generation string that the follow-up shares, so it marked the live
   follow-up's in-flight tools interrupted.

Step 5a ladder:

- Why did cleanup act on the wrong run? The generation identity is
  `(workflowId, firstExecutionRunId)`, but the consumer compared `workflowId`
  alone.
- Why could the run ID be unknown? Three start paths (`startAgentMode`, create
  `startDirectWorkflow`, SMS `start_new_agent`) used the lossy
  `startAgentWorkflow` helper, which returned only the Workflow ID. They never
  recorded `temporalFirstExecutionRunId`.
- Why does the Workflow ID repeat? Workflow ID = agent ID is a deliberate,
  widely relied-on convention (chat escalation, `reconcileWorkflowStart`,
  liveness). That is a design decision, so the ladder stops here. The fix
  belongs at the identity contract.

Local repro (identical command before and after the fix):

```
cd back-end && DATABASE_URL=postgresql://postgres:postgres@localhost:5432/victoria \
  DIRECT_URL=postgresql://postgres:postgres@localhost:5432/victoria \
  npx tsx src/tests/unit/workflow-terminal-cleanup-follow-up.test.ts
```

The test uses the real trigger, `clearWorkflowForTerminalAgent`,
`acceptChatWorkflowExecution`, and real tool capture/finalize, with Workflow ID
= agent ID. Pre-fix: `follow-up run survives cleanup of an unknown-run completed
generation` failed with `terminations = [<agent>:<agent>:run-2-…]` (the live run
was terminated, `interrupted_count=1`). `follow-up run survives cleanup of an
exact-run completed generation` failed with
`temporalWorkflowId = <agent>:deployment-sealed:…`. Post-fix the suite passes
(8/8 follow-up cases after the review hardening below, plus the original 10), including the guard `still-terminal
agent with an unknown run is still sealed and terminated`.

An adversarial review then found five more holes in the same identity class.
Each now has a case in the same suite that fails on the first fix (`8f87649da`)
and passes after:

- `a live agent still on the exact terminal chain is sealed and terminated`
  covers a start that adopted the finishing chain.
- `a reopened agent between runs keeps its next run and chips` covers the
  chat-mode window with `wf=null`.
- `a later terminal generation retargets the pending obligation` covers the
  trigger's `ON CONFLICT` keeping the oldest run.
- `a reopen committed during the seal is never overwritten` covers the seal
  TOCTOU against the lock-free reopen.
- `a newer generation landing during the lease is requeued, not deleted`.

Golden reference: OpenClaw never acts on a reusable session key alone.
`openclaw/src/config/sessions/provider-review-store.ts:107` requires
`sessionId` **and** `lifecycleRevision` to match. `assertCurrent` in
`openclaw/src/gateway/node-claude-skill-runtime.ts:152-168` refuses to act once
the revision, placement generation or claim `runId` changes. The fix converges:
the reusable key is the Workflow ID, the revision is `firstExecutionRunId`, and
the agent's live installed generation is never acted on. The `claude-code-src`
query and task loops showed no analog.

## Solution

- `workflowTerminalCleanup.ts`: under the generation lock, `sealCleanup` now
  checks whether the agent is live (not deleted, status not
  `COMPLETED`/`FAILED`) on the obligation's Workflow ID. If it is, that run
  belongs to a follow-up, so cleanup does not seal it, finalize its tool chips,
  or resolve-and-terminate it. It closes only the obligation's exact chain, and
  only when both run IDs are known and differ. Temporal scopes a terminate by
  first-execution run ID, so the live run is untouched (as prod 2dd470aa showed).
  Terminal and deleted agents keep the original zombie cleanup.
- `workflowGeneration.ts`: `recordAgentWorkflowExecution` is one
  compare-and-set writer, under the per-agent generation lock, for
  `(temporalWorkflowId, temporalFirstExecutionRunId)`.
  `acceptChatWorkflowExecution` is its ACTIVE-only variant.
- `temporal.ts`: deleted the lossy `startAgentWorkflow`. `startAgentMode`,
  create `startDirectWorkflow`, SMS `start_new_agent` and the two checkpoint
  scripts now start with `startAgentWorkflowExecution` and record the exact run.
  `startAgentMode` returns 409 and terminates its unaccepted start if another
  generation or a deletion won, matching chat escalation. The batch root start
  and the SMS ambiguous-start adoption record the run too. `reconcileWorkflowStart`
  now returns the chain's first run ID, not only the current run ID.
- Review hardening in `workflowTerminalCleanup.ts`:
  - The seal is a compare-and-set on the exact row state it read. A concurrent
    reopen yields `raced`, and the obligation is retained with backoff.
  - A live agent between runs, whose next run may reuse the agent ID, is
    treated like a follow-up.
  - The exact terminal chain still installed on a live agent keeps the
    original seal.
  - `finishCleanup` requeues, rather than deletes, an obligation that a newer
    generation retargeted during the lease.
- Migration `20261012040000_temporal_cleanup_newest_generation`: on conflict,
  the newest known run wins and the later grace is kept. The local SQL hooks
  apply it after the original trigger.
- `force-clear-generation-queue.ts` / `generationQueueCutover.ts`: the orphan
  terminate is scoped to the exact run listed on the superseded queue, never
  the latest run of a Workflow ID that a follow-up may reuse.

Siblings prevented:

- The exact-run variant (2dd470aa): fencing a live follow-up that keeps
  spending invisibly.
- Live tool chips stamped "Tool interrupted by deployment" on reused generation
  strings.
- Unknown-run obligations from every lossy start path (API create, SMS, manual
  escalation).

Regression coverage: `workflow-terminal-cleanup-follow-up.test.ts` (8 cases),
`workflow-generation-locks.test.ts` (+1), `generation-queue-cutover.test.ts`
(the run-scoped orphan) and `coverage-script.test.ts` (hook order) all run via
`scripts/run-unit-tests.ts` inside `run-coverage.sh`, the `/deploy` backend
coverage gate.

Still open, and pre-existing: a chat escalation whose start hits
`WorkflowExecutionAlreadyStartedError` adopts the still-finishing chain, so
that follow-up is never processed. Separately, `routeUserMessage` re-reads a
just-sealed row and signals the tombstone when its reopen compare-and-set loses
to a seal. Neither was observed in this incident.

10k-agent behavior: no new queries on any hot path. Cleanup does the same
single-row read it already did under the existing per-agent advisory lock. One
extra compare-and-set row write per workflow start. No fan-in, no shared lock,
and no change to the cron's per-tick batch bound.

## Human feedback

None recorded.

## Reusable lesson

When an identifier is reused across lifecycles (Workflow ID = agent ID), never
let a destructive cleanup act on that identifier alone: carry the
per-lifecycle revision (first-execution run ID) and refuse to touch the
generation that is currently live.
