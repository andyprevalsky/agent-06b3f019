---
id: 2026-08-04-subagent-success-decided-by-last-event-not-evidence
date: 2026-08-04
title: spawn_agent success was decided by the last event's status, so an explore agent that returned the answer cancelled the whole DAG
surface: agents
component: agent-workflow-tool-dispatch
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py:2553 — `failed = last_status == MessageStatus.ERROR` decides the verdict while the returned evidence (`result_text`) is used only as the error string
symptoms:
  - "[DAG] Task 0 tool 'spawn_agent' returned failure: Findings on"
  - "[DAG] Task 0 failed - canceling remaining DAG work"
  - "[spawn_agent] Finished type=explore, events=2, last_status=MessageStatus.ERROR"
  - explore agent returns usable findings but the parent treats the task as failed
  - DAG cancels remaining work after a sub-agent that actually produced a result
tags:
  - spawn-agent
  - explore-agent
  - dag
  - success-accounting
  - sub-agent
sources:
  - agent e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc
repro: agents/.context-repro-f.py (scratch; to be promoted to agents/tests/blackbox/workflow.blackbox.py)
status: wontfix
---

## Problem

Prod agent `e14d5abb-1ff9-40f2-a910-2d3a1e9bb1cc` was asked to schedule an SMS to a
contact. An explore sub-agent found the contact and reported it. The parent threw
the result away and cancelled the plan. Worker log, 2026-08-03 04:20:17:

```
04:20:17.967  [spawn_agent] Finished type=explore, events=2, last_status=MessageStatus.ERROR
04:20:17.968  [DAG] Task 0 tool 'spawn_agent' returned failure: Findings on "Andy Prevalsky"
              contact info in Tamara Chayo's data: **Phone number (E.164): Not definitively
              confirmed.** - There is a strong candidate: the iMessage thread +19729777432 ...
04:20:17.968  [DAG] Task 0 failed - canceling remaining DAG work
04:20:17.969  [DAG] Task 2 tool 'wait_for' returned failure: User paused the agent during
              browser execution
```

The "failure" message *is* the successful result, and it contains `+19729777432` —
the exact number the agent went on to use. The agent then re-planned and re-spawned
explore agents twice more (04:21:54 ERROR, 04:22:40 FINISHED), burning a further two
minutes and a second context blow-up.

## Diagnosis

`agents/domains/spawn_agent/handler.py:886` overwrites `last_status` on **every**
status-bearing event, so the verdict is whatever the final event happened to carry.
It separately captures `last_result` from the FINISHED event and returns
`(last_status, last_result)`.

`agents/workflows/agent_workflow.py:2549-2556` then decides:

```python
last_status, result_text = executor_result
failed = last_status == MessageStatus.ERROR
if failed:
    return {"error": True, "message": result_text or f"{tool_name} failed"}
```

`result_text` never influences the verdict — it is demoted to an error string. The
explore agent's final tool calls were the `grep` and `web_fetch` failures diagnosed
in the sibling cases, so the run ended on an ERROR event *after* the result had been
produced. `loop/dag_executor.py:1032` reads `result.get("error")` and cancels the DAG.

Step 5a ladder:
1. The DAG cancelled — because task 0 returned failure.
2. Task 0 returned failure — because `_execute_tool` mapped `last_status == ERROR`
   to `{"error": True}` while holding a non-empty result.
3. That mapping exists — because sub-agent success is defined by terminal event
   status rather than by evidence produced. Evidence: the same file returns
   `{"success": True, "message": result_text or ...}` one line later, proving the
   result was in hand at decision time.

Rung 3 is the deepest owned cause. `docs/rca/cases/2026-07-21-evidence-free-explore-completion-counted-successful.md`
already established the principle — "Define sub-agent success by the evidence it
produced, not by the fact that it completed" — but fixed only the
evidence-free-counted-SUCCESS direction. The evidence-rich-counted-FAILURE direction
was never covered, so this is a **relative** of that case: same rule, opposite sign.

Sibling failure the same fix prevents: any explore/browser/code sub-agent whose last
tool call errors after a usable result, which is the common case for agents that
probe several sources and fail on the last one.

Incidental defect found on the same path: `agent_workflow.py:2561` returns the
hardcoded string "User paused the agent during browser execution" from its
`except asyncio.CancelledError` handler. In this trace the cancellation was the DAG's
own cancel, not a user pause, so the log actively misattributes causation — directly
against the repo rule that pauses are user-initiated symptom reporters, never causes.

## Solution

**Not fixed — the user ruled this behavior correct.** Do not re-propose it.

The original framing was also wrong twice and is corrected here:

1. The claim that the parent "threw the result away" is FALSE. `execute_tool`
   posts the result to context regardless of status
   (`loop/dag_executor.py:1027` — "uses existing flow - posts result to context").
   Verified against the prod messages: idx 30 carries `toolStatus=ERROR` AND the
   full findings text including the phone number. The main agent had the answer.
2. What actually happened is that the DAG cancelled remaining tasks and re-planned,
   re-deriving the same number two explore agents later (idx 75). That is wasted
   work, not lost data.

The user's verdict on that: "this is normal fine behavior". A sub-agent whose last
event is an ERROR is legitimately a failed task, and cancelling dependent DAG work
is the intended contract.

The real defect behind this trajectory was that the explore agent errored at all,
which is a separate, fixed case: see
`2026-08-04-grep-emits-pointers-no-tool-can-dereference.md`.

Proposed, not yet implemented. Decide sub-agent outcome on evidence first:
treat a non-empty `result_text` as success regardless of terminal event status, and
reserve failure for runs that produced no usable evidence — mirroring the accounting
already used for the evidence-free direction. Replace the hardcoded "User paused"
string with the actual cancellation reason.

10k-agent behavior: strictly reduces work — it removes a spurious DAG cancel and the
re-plan/re-spawn cycle it triggers, so it lowers LLM calls and sub-agent spawns per
agent. No new per-agent state, no new queries.

## Human feedback

The user asked for an RCA of every remaining issue in this agent beyond the
already-fixed deploy-cleanup terminator. No fix has been approved yet; this case is
recorded at diagnosis-ready.

## Reusable lesson

When a sub-agent's result is discarded, check whether success is being read from the
last event's status instead of from the evidence the sub-agent actually returned.
