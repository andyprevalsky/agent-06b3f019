---
id: 2026-11-06-continuation-carries-the-context-twice-and-wedges-cooperative-cutover
date: 2026-11-06
title: A 384-message agent's continue_as_new carried its conversation twice, exceeded Temporal's 2 MiB payload limit (TMPRL1103) and wedged the cooperative cutover in DRAINING
surface: agents
component: agent-workflow-continuation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py _continuation_resume_state wrote runtime_state["context"] = the full conversation while _continuation_args also passed the same conversation as argument 6, so every continue_as_new payload held the context twice
symptoms:
  - "[TMPRL1103] Attempted to upload payloads with size that exceeded the error limit."
  - "Old bank is still draining; retaining every Machine"
  - "Cooperative cutover phase: managed_deployment_pending"
  - "PayloadsTooLarge"
tags:
  - temporal
  - continue-as-new
  - payload-limit
  - cooperative-cutover
  - deploy-agents
  - generation-handoff
sources:
  - PR #1732
  - commit 25b44dff334567fec68534aed3a0cccb28da23ca
  - agent 76aac11b-7c50-4d3c-9741-47e2cdb912a5
repro: agents/tests/blackbox/workflow.blackbox.py test_workflow_continuation_carries_the_context_once_so_large_agents_hand_off (domain workflow)
status: fixed
---

## Problem

`monitor-cooperative-cutover.ts --verify` for job 39e1d2df… stayed `DRAINING`
(the 90-minute `deploy-agents.yml` step timed out at 14:59Z) because exactly one
workflow remained on the old bank: a stale `DEMO fleet concurrency probe alpha`
agent, ACTIVE since 2026-10-28, paused on an unanswered question. Every
`generation_handoff_available` signal was followed by a workflow task that failed
with `WORKFLOW_WORKER_UNHANDLED_FAILURE` / `[TMPRL1103] Attempted to upload
payloads with size that exceeded the error limit.` (type `PayloadsTooLarge`),
retried forever. Old-bank pollers were healthy (8 workflow, 8 activity).

## Diagnosis

Read-only history of the open run (Temporal Cloud): 780 events, history size
4.4 MB. The run's own start input (a previous continue_as_new) holds 17 payloads;
two are large: argument 6 `context` = 384 messages, 1,032,403 bytes, and argument
16 `resume_state` = 1,050,698 bytes, of which `runtime_state.context` is
1,032,403 bytes, byte-for-byte the same conversation. Everything else in the state
is under 15 KB. So the handoff payload was 2.08 MB, over Temporal Cloud's 2 MiB
per-command limit, and the SDK refuses to upload it; a failed workflow task is
retried, so the workflow can never `continue_as_new` onto the live generation.

Causal chain: `_continuation_args(context)` passes the conversation as argument 6
and `_continuation_resume_state(context)` also stored it in
`runtime_state["context"]`; `run()` restores runtime state first and then
overwrites `self.context` from the argument, so the second copy was never needed
by the continuation (deployment-kind states are built in TypeScript and never
carried a context copy). A 1 MB agent is not exotic: context compaction is
token-driven, so any long-lived tool-heavy agent can reach it.

Local repro (real Temporal dev server configured with Cloud's 2 MiB blob limit,
`.context` scratch `repro2.py`): a workflow that `continue_as_new`s with a
420-message / 1.1 MB context passed twice (argument + `runtime_state.context`)
fails every workflow task with the exact `[TMPRL1103] ... exceeded the error limit`
message and never hands off; the same workflow carrying the context once hands off.
The checked-in regression asserts the same invariant on the real
`AgentWorkflow._continuation_args` contract (it failed before the fix:
`runtime_state` contained `context`).

## Solution

`AgentWorkflow._continuation_resume_state` no longer includes the conversation (the
parameter is gone); the conversation travels once as the `context` argument, and
`_continuation_args` falls back to the live `self.context` when the caller passes
none, preserving the old effective behavior. `run()` still reads
`runtime_state["context"]` for histories written by older generations. A warning is
logged when a continuation exceeds 1.5 MB so a growing context is visible before it
can wedge a cutover. The regression
(`wf_continuation_carries_context_once`, workflow blackbox domain, part of
`/deploy`) builds a 384-message, >1 MB context and asserts the payload stays within
context size plus 200 KB and that the restore round-trip is identical.

10k-agent behavior: no shared state; payload bytes per handoff halve for a
large-context agent, work stays per-agent. Remaining headroom: a single context
larger than ~2 MiB would still fail; compaction bounds it by tokens, and the new
warning makes approach to that bound observable. A DB-backed claim check for such
contexts is a separate, larger change.

Live job: the wedged workflow runs old-bank code that duplicates the context, so
the fix cannot reach it in place. See the deploy record for how that straggler
was resolved.

## Human feedback

None recorded.

## Reusable lesson

Carry bulk state in exactly one continuation argument and keep each continuation
payload well under Temporal's 2 MiB command limit, because a rejected payload fails
the workflow task forever and blocks the generation handoff.
