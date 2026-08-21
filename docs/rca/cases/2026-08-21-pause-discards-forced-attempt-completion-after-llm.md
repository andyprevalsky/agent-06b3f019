---
id: 2026-08-21-pause-discards-forced-attempt-completion-after-llm
date: 2026-08-21
title: External PAUSE after forced attempt_completion LLM return discards tool_calls and leaves agent ACTIVE
surface: agents
component: run-agent-loop
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/run_agent.py — _account_llm_usage pause return after accepted LLM tool_calls, before tool dispatch
symptoms:
  - "Agent paused after cost check"
  - "EXECUTE ended: paused"
  - "run_agent.completed_child_forces_completion"
  - "Timeout after 361s (dynamic cap=360s)"
  - "Agent status: ACTIVE (expected COMPLETED)"
  - "Received PAUSE signal"
tags:
  - attempt-completion
  - pause
  - timeout
  - completed-child
  - gate-subscription
  - structured-response
sources:
  - agent b7b53dfb-20b4-4b8e-b019-432a315cee83
  - PR #1021
  - descend-20260820T202555Z-gate-sub
repro: agents/tests/blackbox/run_agent.blackbox.py::test_pause_after_forced_completion_llm_still_dispatches_attempt_completion
status: open
---

## Problem

`gate-subscription-card-mint-admin-bypass` pass@5 scored 4/5. The failing attempt
(`b7b53dfb-20b4-4b8e-b019-432a315cee83`) minted a card, confirmed payment
(`POST /api/test-payment/confirm` → 200, order `tp_81fcdf56`), and the browser
child returned a schema-complete `structured_response`. The parent logged
`run_agent.completed_child_forces_completion`, the forced-completion LLM returned
`attempt_completion` (tool_choice required), then the benchmark timeout PAUSE
arrived and EXECUTE ended `paused` with durable status ACTIVE until the 360s cap
failed the task.

## Diagnosis

Critical path: browser child SUCCESS → parent
`completed_child_forces_completion` → `call_llm_activity` returns
`attempt_completion` → `_account_llm_usage` → `check_paused()` True →
`return _paused_after_cost_result()` **without tool dispatch** → ACTIVE.

Worker proof (same agent): `run_agent.completed_child_forces_completion` at
18:28:53.258Z; LLM dump
`.llm-dumps/b7b53dfb-…/1787336933765-3a60086092f6-execute_loop.json` shows
`tool_calls:[{name:attempt_completion}]`; `Received PAUSE signal` +
`Agent paused after cost check` + `EXECUTE ended: paused` at 18:28:55.03Z;
no `attempt_completion` TOOL row in the transcript.

Contributing budget burn (not the first-bad completion boundary): all five k=5
agents hit `blankSpaShell` on first `/test_payment` nav; only this agent stayed
blank through repeated reloads/waits (~448s announced waits,
`rootChildren:0`) and reached card request at t+293s, so the forced handoff
landed ~11s after the 360s cap.

Archive searches: `completed_child_forces_completion pause attempt_completion`,
`blankSpaShell`, `Agent paused after cost check EXECUTE ended paused timeout`,
`post-confirm payment COMPLETED structured_response agent stays ACTIVE`. Closest
relatives: `2026-07-11-completion-gated-behind-final-summary-message-post`
(lifecycle gated behind non-critical work) and
`2026-07-03-parallel-provider-subagent-fanout-stalls-until-timeout` (children
done, parent timeout). This incident is a **relative** — same class (terminal
work discarded by a non-completion gate), novel boundary (external PAUSE after
accepted forced-completion tool_calls).

Local owning-boundary repro fails on HEAD (~0.43s):
`test_pause_after_forced_completion_llm_still_dispatches_attempt_completion`
→ `status='paused' executed=[]`.

## Solution

Pending approval. Proposed generalizable fix: after an accepted LLM response that
already contains tool_calls (especially required `attempt_completion` on the
completed-child force path), dispatch those tools before honoring an external
PAUSE. Do not raise the dynamic timeout. Optional follow-up: harden blank-SPA
recovery so k=5 navigations remount Vite before model wait loops burn the budget.

## Human feedback

None recorded.

## Reusable lesson

Never discard already-returned completion tool_calls because an external PAUSE
arrived between LLM acceptance and tool dispatch.
