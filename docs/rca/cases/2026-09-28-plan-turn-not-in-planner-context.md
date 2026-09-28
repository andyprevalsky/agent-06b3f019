---
id: 2026-09-28-plan-turn-not-in-planner-context
date: 2026-09-28
title: Current assistant plan decision was absent from the set-plan planner request
surface: agents
component: set-plan-context-handoff
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/set_plan/handler.py SetPlanManager.execute_tool reads workflow_instance.context before current assistant turn is polled
symptoms:
  - "Timeout after 482s (dynamic cap=480s)"
  - "Agent status: ACTIVE (expected COMPLETED)"
  - "Tokyo child researched resident-register and estimated-population series sequentially"
tags:
  - planner
  - context
  - delegation
  - benchmark
sources:
  - agent b5e068c5-9db8-4572-a4e6-fa00aa8b77d5
repro: agents/tests/blackbox/set_plan.blackbox.py
status: open
---

## Problem

After the Haiku request-body fix, the exact unchanged `spawn-sub-agents`
benchmark still failed: root `b5e068c5-9db8-4572-a4e6-fa00aa8b77d5`
stayed ACTIVE at its 480-second dynamic cap, with a 519.3-second recorded run
duration, 44 LLM calls, and 3.0 cents recorded cost. NYC child
`71eb1535-1ffb-4816-8335-ef66457c0047` completed; Tokyo child
`6efe162b-9d63-4cae-9702-687764ebe24f` remained active until cancellation.
The rerun artifact is
`agents/benchmarks/runs/20260928_181418_spawn-sub-agents.json`, and its durable
frontend is `https://www.roselabs.ai/?agent-id=b5e068c5-9db8-4572-a4e6-fa00aa8b77d5`.

## Diagnosis

The root's first PLAN model output chose the Tokyo Metropolitan Government's
official *population estimate*, but the separate `planner` request contained
only the raw ambiguous user goal and older context, omitting that assistant
turn. The planner produced “latest available official population figure” and
the Tokyo `dag_param_populator` passed that wording to the child. Its first
explore returned 14,137,164 from the official resident-register series while
misidentifying it as the standard monthly estimate. The child noticed the
series mismatch and launched a second explore, which found 14,303,513 in the
official estimated-population series about 12 seconds before cancellation. Two
explore calls took roughly 294.5 and 162 seconds. The child did not return a
Tokyo integer to the root before the cap, so multiplication never ran.

The first bad owned boundary is same-turn context freshness: `run_agent`
awaits writing the assistant turn before executing `set_plan`, but
`SetPlanManager.execute_tool` reads the workflow's cached `context` before its
next poll. A newly added blackbox
`test_handler_planner_sees_just_posted_plan_decision` simulates that stale
context and fails pre-fix with `AssertionError: the workflow context must be
refreshed before planning` in 1.89 seconds. Archive searches for Tokyo
population/official estimate and spawn-agent timeout found related completion
and research cases but no same context-handoff boundary. The first explorer's
wrong series should not be accepted merely to meet the timeout. No model-only
replay was performed, so this is not classified as model intelligence.

## Solution

Proposed, not yet applied: make `set_plan` refresh the workflow context from
its latest existing message timestamp before constructing planner messages or
posting its own in-progress tool event. The existing poll merges messages by
persisted ID, preventing duplicate rows, and the bounded timestamp avoids an
all-history read. This passes the already-written assistant decision into the
planner without changing the benchmark prompt, evaluator, timeout, or model.
The contract change is approval-gated because it changes LLM-visible planner
context. The focused blackbox remains red and the exact benchmark remains
failed until approval, implementation, an unchanged blackbox green run, and an
unchanged benchmark green run. At 10k simultaneous plans the proposal adds
10k bounded database reads, with no new provider calls.

## Human feedback

None recorded.

## Reusable lesson

Refresh a workflow's persisted current turn before a same-turn planner or delegated tool reads its cached conversation context.
