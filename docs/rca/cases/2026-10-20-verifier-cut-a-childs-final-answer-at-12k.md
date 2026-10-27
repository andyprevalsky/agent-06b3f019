---
id: 2026-10-20-verifier-cut-a-childs-final-answer-at-12k
date: 2026-10-20
title: The execute verifier head-and-tailed a child's FINAL_ANSWER at the generic 12k tool cap
surface: agents
component: verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py::_budget_verifier_tool_result_text capped agent_notification at VERIFIER_MAX_TOOL_RESULT_CHARS (12k)
symptoms:
  - "the notification is truncated across the Lovable entry"
  - "verifier truncated 1707 chars from agent_notification"
  - "The Decagon and Fieldguide descriptions are partly truncated in the notification"
tags:
  - verifier
  - background-agents
  - truncation
sources:
  - agent aef74160-a2f9-4494-9c69-64a9f259af84 (FAIL, forbidden spawn_browser_agent)
  - agent 4cf417f1-0c5d-44c5-a00c-8c7675939853 (same truncation)
repro: agents/tests/blackbox/llm.blackbox.py::test_verifier_keeps_a_childs_whole_final_answer
status: fixed
---

## Problem

In aef74160, the root's verifier scored 0.5 because it could not see the
eighth round's announcement date. The root then tried to continue the finished
explore, got "cannot be continued", spawned a recovery explore, and finally
spawned a browser agent, which the benchmark forbids.

## Diagnosis

The explore's FINAL_ANSWER notification was 13,401 characters. Its
`verifier_execute` dump contains "verifier truncated 1707 chars from
agent_notification". `build_verifier_context_messages` budgets a notification
with the generic 12k per-tool cap and keeps the head and the tail, so the
middle of the deliverable was removed. The 4cf417f1 dump shows the same
truncation (853 characters). In a delegating root, a child's own tool rows are
scoped out of the parent context, so this notification is the only evidence the
verifier has.

## Solution

`agent_notification` now joins `_VERIFIER_DELIVERABLE_TOOL_NAMES` and gets the
100k deliverable cap. The 160k total cap is unchanged. The `llm` blackbox
regression failed with "the child's final answer was cut" before the fix and
passes after it.

At 10k agents: the verifier context grows by at most about 88k characters per
notification, and the existing 160k total cap still bounds it. There is no
shared state.

## Human feedback

None recorded.

## Reusable lesson

Budget evidence by its role, not by the tool that produced it. A child's final
answer is a deliverable.
