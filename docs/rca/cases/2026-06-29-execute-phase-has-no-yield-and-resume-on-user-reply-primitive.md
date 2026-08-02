---
id: 2026-06-29-execute-phase-has-no-yield-and-resume-on-user-reply-primitive
date: 2026-06-29
title: EXECUTE has no yield-and-resume-on-user-reply primitive, so agents polled `wait_for` on a condition it can never observe
surface: agents
component: wait-for-tool
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: wait_for condition mode spawns explore/web agents and can never observe a chat reply, yet nothing rejected a user-reply condition
symptoms:
  - 'wait_for(condition="The user responds with details...") polls 30 times and never resolves'
  - agent sends a clarifying question then appears busy while blocked on a human
  - "You cannot directly request user input" in EXECUTE_PHASE_PROMPT while a user-message tool is in the toolset
tags:
  - wait-for
  - execute-phase
  - prompt-contradiction
  - reward-hacking
  - blocked-on-user
sources:
  - agent 0fbf3a96-a9c7-483a-8ee8-126a11f0ea0c
  - memory:project_wait_for_user_misuse_6pack
repro: agents/tests/blackbox/wait_for.blackbox.py
status: fixed
---

## Problem

In a prod run (agent `0fbf3a96-a9c7-483a-8ee8-126a11f0ea0c`, goal "get me a 6
pack", 2026-06-28) the EXECUTE-phase agent sent the user a clarifying question via
`send_message_to_user_execute_phase` and then called
`wait_for(condition="The user responds with details...")`. Condition mode spawns
explore/web agents and can never observe a chat reply, so it polled 30 times and
never resolved — the agent looked busy while actually blocked on a human.

## Diagnosis

This is a harness/prompt defect, not a model defect. EXECUTE has no sanctioned
yield-and-resume-on-user-reply primitive, and the prompts box the model in:
`EXECUTE_PHASE_PROMPT` says "You cannot directly request user input" and "keep
running until attempt_completion"; `send_message_to_user_execute_phase` is
nonetheless in the toolset with a description saying it "does not block execution"
and "Do not use to ask a question"; `MAIN_SYSTEM_PROMPT` advertises "Prefer
wait_for(condition=...) for polling"; and claudeAuth forces `tool_choice=any`, so
the model _must_ emit a tool while `attempt_completion` is penalized for an
unfinished task. `wait_for` is the only remaining "pause". An A/B replay of the
exact decision turn (`agents/scripts/repro_6pack_decision.py`, direct Anthropic
API reusing `build_system_prompt`, `transform_messages_for_anthropic`, and
`build_anthropic_tools_from_response_model` with `tool_choice=any`) gave Opus 4.8
5/5 `wait_for`-on-user misuse versus Sonnet 4.6 0/5 — a stronger model follows the
contradictory instructions more faithfully, so upgrading makes it worse. A second
probe (`tool_choice=auto` with extended thinking) showed both models independently
conclude the task is literally unexecutable without user-only info, i.e. wanting to
ask the user is the correct judgment; the harness simply offers no legal way to do
it.

## Solution

Fenced the illegal use off at three levels: the `WaitForTool` docstring, the
condition field, and `tools/prompts/wait_for.py` now state that condition mode
checks web evidence only and must not be used to wait for a user or chat reply;
`EXECUTE_PHASE_PROMPT`, the `SendMessageToUserExecutePhaseTool` docstring, and
`send_message_to_user_execute_phase.py`'s prompt now forbid asking, blocking and
polling and direct the agent to make an assumption or call `attempt_completion`;
and a runtime guard `is_user_reply_condition()` in `domains/wait_for/service.py`
(wired into `handler.execute_tool`) rejects user-reply conditions up front with an
ERROR instead of spawning polling explore agents. Cemented by
`agents/tests/blackbox/wait_for.blackbox.py` (25 tests pass). The ranked follow-up
that would remove the contradiction rather than fence it is a real
`await_user_input` tool that suspends the workflow on a signal and resumes on
reply. The sibling routing defect — underspecified goals reaching EXECUTE at all —
is recorded separately.

## Human feedback

The human's framing drove the whole analysis: treat this as a prompt/harness bug
rather than a model bug, and do not accept "upgrade the model" as a fix — the
empirical A/B was run precisely because that instinct had to be disproven. Prompt
changes here require snapshot-scoped deploy-time approval.

## Reusable lesson

When a phase's prompt forbids an action the model can nevertheless see a tool for,
expect it to abuse whatever tool remains — add a runtime guard that rejects the
impossible request instead of letting it poll.
