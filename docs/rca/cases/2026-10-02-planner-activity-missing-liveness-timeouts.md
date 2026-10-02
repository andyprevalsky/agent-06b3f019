---
id: 2026-10-02-planner-activity-missing-liveness-timeouts
date: 2026-10-02
title: Planner activity used StartToClose as worker-liveness timeout, so a dead assignment sat on Generating Plan for 241s
surface: agents
component: set-plan
classification: our-bug
problem_class: other
first_bad_boundary: agents/domains/set_plan/service.py run_planner_attempt — execute_activity(call_planner_llm_activity) set only start_to_close=240s with heartbeat_timeout=0
symptoms:
  - "This agent got stuck planning"
  - "Generating Plan"
  - "activity StartToClose timeout"
  - "call_planner_llm_activity"
  - "ACTIVITY_TASK_STARTED attempt 2"
tags:
  - set-plan
  - planner
  - temporal
  - heartbeat
  - start-to-close
  - generating-plan
sources:
  - agent 292022e4-06f8-49ea-90e5-4aaaded6518a
repro: agents/tests/blackbox/set_plan.blackbox.py::test_run_planner_attempt_redelivers_after_dead_worker
status: fixed
---

## Problem

SMS agent `292022e4-06f8-49ea-90e5-4aaaded6518a` (Blue Bottle Ferry Building
pickup) sat on `Generating Plan` from 15:16:24Z to 15:20:47Z. The user reported
it as stuck planning. Temporal history shows `call_planner_llm_activity`
scheduled at 15:16:24.361Z with `startToCloseTimeout=240s` and
`heartbeatTimeout=0s`. The next history event is `ACTIVITY_TASK_STARTED`
**attempt 2** at 15:20:25.368Z (`lastFailure.message = "activity StartToClose
timeout"`, `timeoutType = TIMEOUT_TYPE_START_TO_CLOSE`) on a different worker
(`634@48e64d2f591448`, same build `8c518cf10f78a83f2c5f4e8309b44be6`). There is
no attempt-1 STARTED or TIMED_OUT event. Attempt 2 completed the plan in 22s
(`gpt-6-sol-gpt`, 576 output tokens). Planner memory on the successful attempt
was cheap (search 522ms, compress 456ms, 0 hits injected). The 241s stall was
worker assignment, not the planner LLM.

Archive searches: `stuck planning Generating Plan set_plan call_planner_llm_activity`,
`activity never started schedule-to-start worker admission planner queue`,
`agent hangs planning worker did not start activity`,
`ACTIVITY_TASK_STARTED attempt 2 planner 240s`. No matching first-bad boundary.
Relative of `2026-07-02-cdp-coupled-heartbeat-dies-in-cloudflare-freeze`
(heartbeat coupled to work) and `2026-07-05-unbounded-paused-wait-loop-starves-worker`
(worker starvation). Novel: planner scheduled without any liveness timeout.

## Diagnosis

Critical path: SMS create → PLAN `set_plan` → `run_planner_attempt` →
`workflow.execute_activity(call_planner_llm_activity)` → Temporal worker →
Rose planner LLM → plan artifact.

Midpoint (Temporal history) is already wrong: the activity is scheduled and
then absent for 241s. Downstream (LLM usage at 15:20:47) is healthy. Upstream
(plan_loop LLM, agent_init) completed in seconds on worker `635@e82dd491c26198`.

What / Where / Why / Proof / Problem:

1. **What:** UI stuck on Generating Plan for 241s.
2. **Where:** `run_planner_attempt` scheduled the planner with only
   `start_to_close_timeout=240s`. No `heartbeat_timeout`, no
   `schedule_to_start_timeout`.
3. **Why:** Temporal treats that 240s as both LLM budget and worker-liveness
   budget. When the assigned worker dies, drains, or never records STARTED,
   the server waits the full StartToClose, then retries. Attempt 2 on a live
   worker finishes in 22s.
4. **Proof:** Temporal events 167–169; `lastFailure` StartToClose; no attempt-1
   STARTED; local blackbox failed with `heartbeat_timeout must be set so a dead
   worker is redelivered` before the fix and passed after.
5. **Problem:** A long LLM activity scheduled with `heartbeatTimeout=0` has no
   liveness contract, so Temporal's StartToClose clock (meant for model work)
   becomes the only way to redeliver a started-but-silent assignment.

Step 5a: Why was this possible? `call_llm_activity` already passes
`heartbeat_timeout=180s`; the planner path never copied that contract. The
next why (which worker reserved attempt 1, eager vs crash vs drain) leaves
owned Fly/Temporal fleet state we could not read (ClickHouse DNS NXDOMAIN).
Fix the scheduling contract we own. Not `concurrency-inefficiency`: one agent,
no slot/fleet occupancy numbers. Named missing bucket: missing activity
liveness contract.

Not timeout-too-aggressive: the LLM finished in 22s. Not model intelligence:
the same call succeeded on retry. Not a prompt edit. Do not add a short
`schedule_to_start` with `max_attempts=2` — that can fail a healthy pickup
that would have succeeded inside the 240s budget (this incident's attempt 2).

## Solution

`run_planner_attempt` now schedules the planner with `heartbeat_timeout=30s`,
keeping `start_to_close=240s` and `maximum_attempts=2`. Because Temporal
already applied StartToClose, it considered the activity started — the same
clock starts heartbeat timeout. `call_planner_llm_activity` heartbeats every
10s on a timer so TTFT silence (up to 120s) cannot look like a dead worker.
A started-but-silent assignment is redelivered in ~30s instead of 241s.
Sibling: any planner assignment Temporal has started that then goes silent.
10k-agent behavior: one activity, one heartbeat stream, no per-user fan-in;
Temporal redelivers to any live worker instead of pinning the 240s LLM budget
to a silent assignment.

Permanent regression:
`agents/tests/blackbox/set_plan.blackbox.py::test_run_planner_attempt_redelivers_after_dead_worker`.
Pre-fix: `AssertionError: heartbeat_timeout must be set so a dead worker is redelivered`.
Post-fix: `planner_activity_redelivers_after_dead_worker` PASS (0.3s).
`cd agents && python scripts/run_blackbox_tests.py set-plan` is on the `/deploy`
agent blackbox path.

## Human feedback

None recorded.

## Reusable lesson

Never schedule a long LLM activity with only StartToClose — set heartbeat and
schedule-to-start so a dead worker cannot consume the model budget.
