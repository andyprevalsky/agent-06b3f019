---
id: 2026-10-02-pending-llm-context-slot-keyed-only-by-agent-outlived-workflow-migration
date: 2026-10-02
title: A same-worker LLM context slot keyed only by agent id outlived a workflow migration and fed a later turn a stale conversation
surface: agents
component: llm-context-handoff
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py call_llm_activity read `_pending_llm_context[agent_id]` without checking which LLM call wrote it
symptoms:
  - "Declared evaluator t3-max-three-explore-spawns-per-gp failed: T3: general-purpose agent e268b1db spawned 4 explore agents; maximum is 3 per general-purpose agent (1/50 over limit)"
  - "Workflow task not found"
  - test-mass-agent-run-0 fails once after many passes, only on an overloaded host
  - an LLM turn has no "Backend LLM context fetch" log yet its prompt lacks the newest tool result
tags:
  - temporal
  - workflow-migration
  - sticky-cache
  - pending-llm-context
  - stale-context
  - fast-cache
  - dag-param-populator
  - mass-agent-run
sources:
  - agent f7586d58-3d8c-42d5-820c-c98f6f988e4c
  - agent e268b1db (general-purpose child)
  - PR #1378
repro: agents/tests/blackbox/llm.blackbox.py::test_call_llm_activity_ignores_pending_context_left_by_an_evicted_workflow
status: fixed
---

## Problem

The /deploy smoke task `test-mass-agent-run-0` (root agent
f7586d58-3d8c-42d5-820c-c98f6f988e4c) failed for the first time after 14
consecutive passes:
`T3: general-purpose agent e268b1db spawned 4 explore agents; maximum is 3 per
general-purpose agent`. The host was overloaded (load average ~60 on 14 cores,
other workspaces' gates running), with 4–8s event-loop stalls on worker.8.

Evidence from the preserved isolated-stack logs
(`.context/mass-run-fail-e268b1db/logs/`):

- The GP's four explore spawns came from four distinct cached tool-call ids
  (execute steps p:1..p:4), so none was a duplicate or an activity retry.
- At 23:25:58 the GP's workflow task timed out on worker.8 (`Workflow task not
  found`); the workflow resumed on worker.4, then worker.7.
- worker.8 still held the `_pending_llm_context[agent_id]` slot written for the
  GP's turn 2, containing only one explore spawn.
- At 23:29:11 the turn-4 LLM activity was scheduled onto worker.8 and built its
  prompt from that slot (no `Backend LLM context fetch` for that call). The
  Fast Mode July-GP cap (`_JULY_GP_MAX_EXPLORE_SPAWNS = 3`,
  `providers/fast_cache/rose_cache.py`) counts prior explore spawns in the
  request messages, saw one, and replayed a fourth.

## Diagnosis

1. Symptom: a fourth explore spawn past a cap that counts prior spawns in the
   prompt, so the prompt was missing spawns.
2. The prompt for turn 4 came from the same-process handoff dict, not the
   backend: no backend context fetch was logged for that call.
3. `run_agent` (workflow scope) writes `_pending_llm_context[agent_id]` before
   scheduling `call_llm_activity`, which reads it if present and fetches from
   the backend only on a miss. The key is the agent id alone.
4. A workflow task timeout / sticky eviction moves the workflow to another
   worker, but the old worker's slot stays. When a later turn's activity lands
   back on the old worker, the stale slot is a "hit" and the call silently uses
   an older conversation.
5. Deepest owned cause: the handoff contract never identified which LLM call a
   slot belonged to. The DAG param populator (`loop/dag_executor.py`) wrote the
   same untagged slots and had the same exposure. In live (non-cache) mode the
   identical bug sends the model an out-of-date conversation, so it can redo or
   contradict completed work.

## Solution

- `run_agent` gives every LLM turn a deterministic token
  (`f"{stream_id}:{counter}"`, `stream_id` from `safe_uuid4`, counter in workflow
  scope — replay-stable), stores it as element 4 of the slot, and passes it as a
  new LAST activity argument (`pending_context_token`, default `None`, so old
  histories replay unchanged).
- The DAG param populator tags its slot with `f"dag:{tool_call_id}"`
  (`tool_call_id` is `workflow.uuid4()`) and passes the same token.
- `call_llm_activity` uses a slot only via `pending_llm_context_for_call`, which
  requires an exact token match (token-less callers match only untagged slots).
  A mismatch is a miss → canonical backend fetch. Cleanup pops only the call's
  own slot.
- Repros: `test_call_llm_activity_ignores_pending_context_left_by_an_evicted_workflow`
  (drives the real `run_agent` writer and `call_llm_activity` reader across a
  simulated migration; fails pre-fix with "the newest tool result is missing"),
  `test_call_llm_activity_consumes_only_its_own_tagged_pending_slot`, and
  `test_execute_dag_param_populator_never_adopts_a_stale_pending_context_slot`
  (fails pre-fix with "param call carries no context token").
- 10k agents: slots remain per-agent, per-process entries; the change adds one
  short string per slot and at most one extra backend context fetch on a
  mismatch. No shared channel, lock, or fan-in.
- Not fixed here: slots that are never revisited stay in worker memory until the
  agent's own cleanup paths pop them (pre-existing).

## Human feedback

None recorded.

## Reusable lesson

Any process-local handoff keyed by a long-lived id must also carry the identity of the exact call that wrote it, because Temporal can move the workflow off the process and leave the entry behind.
