---
id: 2026-10-12-terminal-cleanup-obligation-sealed-reused-workflow-id
date: 2026-10-12
title: Terminal-cleanup obligation from a finished chain sealed the live follow-up chain that reused the same root workflow id
surface: back-end
component: workflow-terminal-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/workflowTerminalCleanup.ts sealCleanup — matched the agent row to the obligation by workflow id only, so an obligation for chain A (first run 01a12d6c) sealed live chain B (first run 01a12d6f) that chat had restarted under the same workflow id (the agent id)
symptoms:
  - "new code version deployed, retry this tool"
  - "spawn_browser_agent_v3: workflow generation was replaced by a deploy; stopping"
  - "Workflow ended without reporting a result (terminated or lost). Sealed by liveness reconciler."
  - follow-up sent within 5 minutes of COMPLETED dies with DEPLOY_INTERRUPTED and no deploy
  - Temporal workflow RUNNING while Agent.status=FAILED with a :deployment-sealed: workflow id
tags:
  - temporal
  - workflow-generation
  - terminal-cleanup
  - follow-up
  - workflow-id-reuse
  - deployment-sealed
  - liveness-reconciler
sources:
  - agent 2dd470aa-b3b9-41ab-9475-75e37986298f
  - agent 572da2a5-4fc0-45f4-b9a7-d20b08e19a4e
  - PR #1468
  - PR #1470
repro: back-end/src/tests/blackbox/agents-followup-cleanup-obligation.cases.ts
status: fixed
---

## Problem

Prod root agent `2dd470aa-b3b9-41ab-9475-75e37986298f` (MAC_APP, "compare onleet,
vanta, and agency…") completed its first run at 00:06:29Z on 2026-10-12. The user
sent a follow-up ("schedule calls with the top 3…") at 00:07:19Z. Chat restarted
the agent as Temporal run `01a12d6f-7583-79fe-94a1-5ee4974582b0` under the same
workflow id `2dd470aa-…` (the root workflow id is the agent id). The first run
was `01a12d6c-0c65-7214-bb70-0763da4cf98d`.

At 00:12:00Z, while the follow-up's calendar browser agent was mid-step, every
in-progress chip became "Tool interrupted by deployment / new code version
deployed, retry this tool". Every later write from the run failed:
`WorkflowGenerationSealed` from `post_agent_message`, and `409 Conflict` from
`/api/tool-usage`. No deploy had happened: `fetch_agent_queue_pointer` still
returned `navi-agent-tasks@a2f398f5a272` before and after 00:12. At 00:17:47Z the
liveness reconciler marked the agent FAILED with "Workflow ended without
reporting a result (terminated or lost). Sealed by liveness reconciler."
(`temporalStatus: NOT_FOUND` for the `:deployment-sealed:` sentinel).

The real execution was never terminated. It kept calling the LLM and retrying
`spawn_browser_agent` about every 18 seconds, getting a fenced result each time:
80 `call_llm_activity` in run 2. At 00:35:22Z it continued-as-new onto the next
real build queue (`@e60a75c8e785`) and made 115 more LLM calls there, about an
hour in total, until it completed on its own. Temporal history for both runs is
saved locally under `.context/rca-2dd470aa/`; that directory is not checked in.

Render logs at 00:12:00Z: `Stale workflow already closed before replacement`
(first_execution_run_id `01a12d6c…`). Then `Reconciled stale workflow tool calls`
(generation `2dd470aa…`, candidate_count 2, interrupted_count 2). Then
`Temporal workflow cleanup completed` (discovered 1, sealed 1, terminated 1).

Same night, unknown-run variant: Mac-app agent
`572da2a5-4fc0-45f4-b9a7-d20b08e19a4e`. Its first run `01a12dbc` was started by
`POST /:id/start-agent` ("Manual escalation to agent mode"), which then stored
only the workflow id. The run COMPLETED at 01:32:33Z, so the obligation had no
first-run id. A follow-up chat escalation started run `01a12dbf` under the same
id at 01:35:14Z. At 01:38:00Z the cron logged `Temporal workflow cleanup
completed discovered 1 sealed 1 terminated 1` and `Terminated stale workflow
for replacement first_execution_run_id=01a12dbf`. The obligation had no run id,
so `describe(workflowId)` returned the live follow-up, and Temporal shows run
`01a12dbf` TERMINATED with reason `Restarting with new worker code`. Five live
tool chips became "Tool interrupted by deployment". The liveness reconciler then
marked the agent FAILED at 01:43:43Z. That is what "randomly died" meant: no
deploy happened. The fix above, live since 05:31Z, covers this path (`live`
scope, plus Start-agent recording its run id).

## Diagnosis

1. On the first run's COMPLETED transition (between 00:06:01Z and 00:06:29Z),
   the schema trigger `enqueue_temporal_workflow_cleanup` queued
   `TemporalWorkflowCleanup(agentId, workflowId=2dd470aa…,
firstExecutionRunId=01a12d6c…, notBefore=+5 min)`. It was this transition and
   not the 00:07:19 reactivation: that clear would have given notBefore 00:12:19,
   after the 00:12:00 tick, and `ON CONFLICT` never moves `notBefore`.
2. The follow-up went through `routeUserMessage` → `clearWorkflowForTerminalAgent`
   and then chat. Render logs: `[ChatHandler] Escalating to superintelligence`
   (00:07:21.646), `Starting agent workflow workflowId=2dd470aa…`
   (00:07:21.718), `Workflow started runId=01a12d6f…` (00:07:21.748),
   `[ChatHandler] Escalated to agent mode` (00:07:21.771). That last line is
   written after `acceptChatWorkflowExecution`, which leaves the row on
   `(2dd470aa…, 01a12d6f…)`. The obligation for chain A stayed queued.
3. When the grace expired, the 00:12:00 cron ran
   `cleanupTerminalAgentWorkflowZombies`. `sealCleanup` checked only
   `current.temporalWorkflowId === obligation.workflowId`, which is true because
   the id is reused. It then:
   - wrote the `:deployment-sealed:` sentinel over the live chain;
   - finalized the live chain's in-progress tools, which share generation string
     `2dd470aa…`, as DEPLOY_INTERRUPTED;
   - terminated only chain A by its exact first-run id. A was already closed.
4. Chain B was fenced but alive. The liveness reconciler then failed the row
   because the sentinel id does not exist in Temporal.

Step 5a ladder:

- **Why 1:** the seal targeted the wrong chain.
- **Why 2:** cleanup acted on whatever the agent row named under the obligation's
  workflow id, without asking whether the agent was still ended. The obligation
  exists to stop the workflow of an ended (terminal or deleted) agent. Root
  follow-up restarts reuse the workflow id (the agent id), so after a follow-up
  the same id names the agent's live workflow. The existing unit test "two
  reactivations before sweep preserve both generations" only modeled
  reactivations under distinct workflow ids. The reuse that chat, Start-agent and
  direct starts perform was untested.
- **Why 3:** the obligation is keyed `(agentId, workflowId)`. When a later chain
  under the same id also ends before the sweep, the trigger's
  `ON CONFLICT … COALESCE(firstExecutionRunId)` merges its terminal transition
  into the older row. The newer chain's cleanup is never targeted exactly.

Siblings reproduced in the same suite:

- **Direct start, then a chat follow-up.** Direct plan/execute starts never
  record `temporalFirstExecutionRunId`, so the obligation has a null run id.
  Old `cleanupOne` called `resolveExecution(workflowId)`, which describes
  whichever chain is open now. After a follow-up that is the live chain, so old
  code would **terminate** it, not merely seal it.
- **Direct start, then Start agent.** `POST /:id/start-agent`
  (`agentControlService.startAgentMode`) also records only the workflow id. The
  obligation and the live row then both carry a null run id. Run-id equality
  alone cannot detect this case, which is why the fix checks whether the agent is
  still ended rather than comparing run ids. The adversarial review found it.

Not fixed and not evidenced in this incident: a message write from an orphaned
activity of the old chain carries the same generation string as the new chain,
so the generation fence cannot reject it. Removing that would need a unique
workflow id per follow-up chain. That is a broader identity change across the
chat, Start-agent and direct start paths.

## Solution

`workflowTerminalCleanup.ts` `sealCleanup` now runs under the per-agent
generation lock. It first locks the Agent row (`FOR UPDATE`), then reads it, and
only then touches the obligation row. The schema trigger runs inside Agent
writes and then upserts the obligation, so Agent-then-obligation is the only
lock order that cannot deadlock with a concurrent follow-up, delete or status
write. It also makes any in-flight trigger merge commit before the agent is
read. `finishCleanup` takes the same Agent row lock before deleting the
obligation. The sweep then picks one of four scopes:

- `released`: the row moved to another workflow id. Unchanged behavior.
- `live`: the row still has this workflow id and the agent is not ended (not
  COMPLETED/FAILED, not deleted). The id now names the agent's live workflow.
  Temporal keeps at most one open run per workflow id, so the ended chain is
  closed, or a start adopted it as the live chain. The obligation is discharged
  with no seal, no tool finalization and no termination. This also covers the
  case where a follow-up start adopts a still-finishing chain.
- `rebound`: the agent is ended but its row records a different, known first-run
  id. That newer chain ended too, and the trigger merged it into this row. The
  obligation is pointed at that chain with a fresh 5-minute grace.
- `sealed`: the agent is ended on this chain, or on a chain whose run id the row
  does not know. Unchanged behavior: seal, terminate exactly (or describe when
  the run id is unknown), reconcile tools.

`WorkflowTerminalCleanupResult.superseded` counts `live` and `rebound`
obligations.

`agentControlService.startAgentMode` (`POST /:id/start-agent`) now records the
new chain's `temporalFirstExecutionRunId`, as chat escalation already did.
CodeRabbit flagged that it stored only the reused workflow id. If such a
follow-up chain also ended before the sweep, the merged obligation still named
the older chain. Cleanup then terminated that older, already closed chain
instead of the newer one. The `agents-configuration` start-agent blackbox now
asserts the run id: it failed with `null` before this change and passes after
it. New agents created by direct plan/execute starts and SMS starts still
record only the workflow id. Their first chain needs nothing more, because any
later chat or Start-agent chain records its run id.

The regression is in
`back-end/src/tests/blackbox/agents-followup-cleanup-obligation.cases.ts`, which
is registered in `agents.blackbox.ts` (backend blackbox suite, `/deploy`). It
replays the production sequence through the real trigger,
`clearWorkflowForTerminalAgent`, `acceptChatWorkflowExecution` and the
Start-agent row write, with only Temporal faked. Its five cases are:

1. a chat-started chain with a chat follow-up;
2. a direct-start chain with a chat follow-up;
3. a direct-start chain with a Start-agent follow-up (both run ids null);
4. a follow-up that also ends before the sweep (rebind);
5. a follow-up reactivation that holds the Agent row while the sweep runs
   (lock order).

Each of the first three cases also runs the next liveness tick with a Temporal
double in which only the agent id is running. A sealed sentinel would be failed.

Pre-fix (main): cases 1–4 FAIL, 240/244 pass. Post-fix: 245/245 pass.

Case 5 came from an independent review of the first fix. That version locked the
obligation row before the Agent row, the reverse of the trigger. Run against
that version, case 5 failed with `40P01 deadlock detected` and the follow-up
reactivation was aborted. With the Agent-first order it passes. The unit suite gains a
test for an unknown-chain obligation adopting the ended row's known chain
exactly. The `already-closed` fixture now nulls the row's run id too, so it
models a coherent direct-start state.

Golden reference: two of the reference harnesses guard delayed cleanup with an
identity check against a replacement registered under the same key:

- `codex/codex-rs/core/src/thread_manager.rs:1373` `remove_thread_if_matches`,
  which uses `Arc::ptr_eq`;
- `openclaw/src/gateway/chat-abort.ts:295`, which checks
  `chatAbortControllers.get(runId) === entry`.

This fix converges on that pattern: before the delayed cleanup acts, it
re-checks that the agent row still holds the ended chain. A live owner of the
same id wins, as in `remove_thread_if_matches`. Unlike `Arc::ptr_eq`, two
unknown run ids are never treated as proof of the same chain.

10k agents: per obligation, one extra `SELECT … FOR UPDATE` on that agent's own
row and three more columns in the existing per-agent locked read.
There is no new fan-in, polling or cross-agent lock.

Follow-up hardening (PR #1470, from the 572da2a5 RCA, reconciled onto this fix):

- Every root start path now records its first run id through one
  compare-and-set writer, `recordAgentWorkflowExecution` (best-effort
  `bindStartedRunIdentity` after the start succeeded). This covers direct
  plan/execute create, batch root, SMS `start_new_agent` and its
  ambiguous-start adoption (`reconcileWorkflowStart` now returns the chain's
  first run id), and the checkpoint scripts. The lossy `startAgentWorkflow`
  helper is deleted, so new obligations almost never need `describe`. The
  best-effort bind requires the row to still carry that workflow id, so a run
  that finished and was reopened before the bind is never written back onto
  the chat-mode row.
- `force-clear-generation-queue` terminates the exact run it listed on the
  superseded queue, never the latest run of an id a follow-up may reuse.

A `between-runs` scope was prototyped and dropped: it skipped `describe` for
an unknown-run obligation while a reopened agent had no installed workflow,
to avoid a follow-up that Temporal started milliseconds before chat committed
it. Review showed the cost. For pre-existing rows with no run id, it would leave
a chain still parked at COST_LIMIT_REACHED or OUT_OF_CREDITS running, and a
later escalation would adopt that chain and hang. The fix above terminates it.
Now that new starts record their run ids, that millisecond window only affects
legacy rows, so this fix's `describe` behavior stays.

Still open: a terminal generation that goes terminal while the earlier
obligation is leased merges into the leased row (COALESCE keeps the older run),
and `finishCleanup` then deletes it. That newer generation's zombie is not
terminated. It needs both chains to end inside one sweep's lease and has not
been observed.

## Human feedback

None recorded.

## Reusable lesson

A delayed cleanup keyed by a reusable id (a Temporal workflow id, a session id)
must re-check, when it fires, that its target is still the ended run it was
queued for. That means the owner is still ended and the run identity is
unchanged. Unknown identities never count as a match, because a newer live run
may own the same id.
