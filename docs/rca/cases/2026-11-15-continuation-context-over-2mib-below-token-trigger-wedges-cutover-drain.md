---
id: 2026-11-15-continuation-context-over-2mib-below-token-trigger-wedges-cutover-drain
date: 2026-11-15
title: A JSON-heavy context crossed Temporal's 2 MiB payload limit while still far below the token compaction trigger, so one agent's generation-handoff continue_as_new failed forever (TMPRL1103) and wedged the a145f654 cutover drain
surface: agents
component: run-agent-context-compaction
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/run_agent.py step 5 compaction gate compared only the estimated token count (context_tokens >= compaction_trigger) and never the serialized bytes that every continue_as_new and the compactor activity carry under Temporal's 2 MiB payload limit
symptoms:
  - "[TMPRL1103] Attempted to upload payloads with size that exceeded the error limit."
  - "Continuation payload is 2124477 bytes (Temporal rejects ~2 MiB); context messages=602"
  - "Old bank is still draining; retaining every Machine"
  - "Continuation source or destination chain remains unresolved"
  - "37 AGENT_QUEUE_CONTINUATION tickets STARTED"
tags:
  - temporal
  - continue-as-new
  - payload-limit
  - cooperative-cutover
  - generation-handoff
  - context-compaction
sources:
  - agent 8789a5df-0119-4bbf-b90c-c7e58de56fe4
  - PR #1732
repro: agents/tests/blackbox/run_agent.blackbox.py test_run_agent_compacts_context_over_continuation_payload_budget (domain run-agent)
status: open
---

## Problem

Worker-deployment job a145f654 sat in DRAINING from 07:46Z on 2026-11-15 onward:
`retire-agent-queue.ts --retire` for `navi-agent-tasks-pool-1dda220c1c14@8f3f82ebea01`
failed every 30 s, and each DRAIN_TIMEOUT_SECONDS=2700 window ended in
PoolCapacityPending. This blocked every later agents/ deploy, including #2210. The
queue had 37 AGENT_QUEUE_CONTINUATION rows still marked STARTED (29 agents PAUSED,
7 COST_LIMIT_REACHED, 1 ACTIVE), which suggested that parked agents never hand off.

Read-only native reconciliation of all 37 tickets (Temporal describe by workflow id)
showed otherwise. 36 were RUNNING in the same chain on the live queue
`navi-agent-tasks-pool-afeb1a2619db@1db223040faf`, and their runs had started at
07:46:35–36Z. The paused and cost-limited agents had handed off correctly. One
example is setup agent 1772a64a, which re-reads the pointer every 1200 s on the new
queue. The ticket `status` column is never advanced; retirement reads native state.

The single unresolved ticket belonged to ACTIVE agent 8789a5df, workflow
`8789a5df-…:start:08fd9a81-…`, run 794ef8d4, which was still on the old queue. Its
history shows the sequence:
- 07:31Z: `sleep` tool, "Sleeping for 17.0 hours".
- 07:46:35Z: signal `generation_handoff_available(afeb1a…)`; the pointer read
  returns afeb1a; the sleep chip closes with "new code version deployed, retry
  this tool".
- From then on: `workflowTaskFailed [TMPRL1103] Attempted to upload payloads with
  size that exceeded the error limit.` on every attempt (attempt 11 at 19:51Z),
  including after each re-broadcast at 08:32, 14:28, 15:14, 18:50 and 19:36.

The Fly worker log (ClickHouse) for that run at 07:46:36Z reads: "continue_as_new
onto generation queue navi-agent-tasks-pool-afeb1a2619db@1db223040faf (cooperative
cutover)", then "Continuation payload is 2124477 bytes (Temporal rejects ~2 MiB);
context messages=602". The agent row shows model rose-1-ultra and contextSize
191664 tokens.

## Diagnosis

1. `requireQueueRetirementReady` (back-end/src/providers/workflowQueueAdmission.ts)
   throws "Continuation source or destination chain remains unresolved" when any
   ticket's chain is non-terminal and still on the retiring queue. 8789a5df is that
   chain, so the queue can never retire and the cutover loops in DRAINING.
2. 8789a5df can't leave the old queue because its handoff `continue_as_new` (the
   generation_handoff branch of `_handle_incomplete`) carries a 2,124,477-byte
   argument list. Temporal rejects that, so the workflow task fails
   deterministically and retries forever.
3. The context reached that size because run_agent's step 5 compaction gate only
   tests `context_tokens >= compaction_trigger`. For a 1M-window model the trigger
   is far above 191k tokens, while JSON-heavy tool results made the serialized
   context larger than 2 MiB. Nothing bounded the bytes. The 2026-11-06 case had
   already named this as its residual risk: "a single context larger than ~2 MiB
   would still fail; compaction bounds it by tokens". Its only guard was a
   warning log at 1.5 MB.
4. Deepest owned cause: two limits govern the context, the model window (tokens)
   and the Temporal payload cap (bytes, on every continue_as_new and on the
   compactor activity input). The harness enforced only the first.

The PAUSED/COST_LIMIT_REACHED hypothesis is refuted: their pause park
(`_wait_for_unpause_or_handoff` → `wait_condition_or_generation_handoff`) woke on the
signal and continued onto the live queue within one second.

Local repro: `test_run_agent_compacts_context_over_continuation_payload_budget`
runs run_agent with a context below the token trigger but above the byte budget.
- Before the fix it fails: "run_agent must continue_as_new with the compacted
  context". The compactor was never called.
- After the fix it passes (5/5 consecutive), and the run-agent domain passes
  106/106.

## Solution

`agents/loop/run_agent.py`: the step 5 compaction gate now also fires when the
serialized context (`json.dumps(context, default=str)`, the same encoding the
workflow's continuation check measures) reaches `CONTEXT_PAYLOAD_COMPACTION_BYTES`
= 1,200,000. That leaves room under 2 MiB for one turn of capped tool results
(50k chars each) and the rest of the continuation arguments. Three related checks
now count bytes as well as tokens:
- the post-compaction "still over trigger" check, which errors loudly instead of
  continuing with an oversized context;
- the open-breaker check;
- the existing compactor, which compacts and continues as new as before.

Sibling paths covered: pause continue_as_new, generation handoff (top-of-turn and
in-tool parks) and context overflow all carry the same bounded context, and the
compactor activity input stays under the limit.

10k-agent behavior: one O(context) JSON encode per turn per agent, next to the
existing O(context) token estimate. No shared state, no fan-in.

Live job: 8789a5df runs on the old bank's code, so this fix can't reach it in
place. Job a145f654 can't complete until that one workflow leaves the old queue,
and that needs an operator decision on the user's agent (not taken here).

## Human feedback

None recorded.

## Reusable lesson

Bound every piece of state that crosses a Temporal boundary by bytes as well as by
its domain unit (tokens, messages), because a rejected continue_as_new fails the
workflow task forever and wedges the cutover drain behind it.
