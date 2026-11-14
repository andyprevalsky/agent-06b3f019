---
id: 2026-11-13-browser-step-loop-ran-into-its-own-start-to-close-and-fence-refused-before-receipt
date: 2026-11-13
title: Healthy long browser tasks were hard-killed by their own 30-min StartToClose, and the next spawn was refused before the worker's cleanup receipt could arrive
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py `_spawn_browser_agent_activity_v3_real` step-boundary drain checkpoint — yielded for deploy drain and reused-session expiry but not for the activity's own StartToClose; and `SpawnBrowserAgentManagerV3.execute_tool` — refused on `_browser_activity_cleanup_unknown` without waiting for the receipt signal it depends on"
symptoms:
  - "activity StartToClose timeout"
  - "Previous browser activity cleanup is unconfirmed"
  - "Tool spawn_agent failed: Previous browser activity cleanup is unconfirmed"
  - "Browser session cleanup failed"
  - phone-setup browser sub-agent FAILED after exactly 30 minutes while still stepping; the next browser spawn fails within a second
tags:
  - start-to-close-timeout
  - browser-activity-cleanup-receipt
  - drain-yield
  - phone-setup
  - iphone
sources:
  - agent 0b54f65d-f93b-503b-b3d3-f961f9f836c5
  - agent 09b554a3
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_browser_task_checkpoints_before_its_activity_start_to_close
status: fixed
---

## Problem

Prod setup agent 0b54f65d (2026-11-13): browser sub-agent `/root/iphone_setup`
ran 08:50:48→09:20:49Z and `/root/iphone_native_state` 09:40:19→10:10:20Z; both
ended FAILED `activity StartToClose timeout`. Worker logs (ClickHouse
`observability.fly_logs`, activity `browser-cleanup:b155d546…`) show the first
task was healthy, not stalled: 127 `browser.step.phases`, 123 `Action phone
successful`, 4 failed, last step 09:19:45 (~14 s/step), and an in-flight
verifier call when the deadline landed. The task returned no result.

Then:
- 09:20:48.97 workflow: `Browser manager failed … activity StartToClose timeout`
- 09:20:49.13 workflow: `Tool spawn_agent failed: Previous browser activity cleanup is unconfirmed`
- 09:20:49.35 worker: `Browser agent activity cancelled` (`not_found=True`, it learned of the timeout on its next heartbeat)
- 09:20:59.25 worker: `Browser cleanup finished in background` (receipt signalled)
- 09:21:50 the following spawn started normally.

The refusal came 155 ms after the timeout and ~10 s before the receipt. The
root saw a failed setup and a refused probe and drifted (re-planned).

## Diagnosis

1. The default browser budget is "250 steps or 30 minutes". The step loop
   checkpoints at step boundaries (`BROWSER_DRAIN_YIELD_STATUS`) for worker
   drain, generation handoff and reused-session expiry, and the manager restarts
   the same task from the same step. The activity's own StartToClose had no such
   checkpoint, so a task still making progress at minute 30 was killed mid-step:
   no result, no salvage, and a teardown racing the workflow.
2. 30 min is not wrong as an attempt budget; 250 steps at the observed ~14 s per
   phone step needs ~58 min. The defect is that hitting the attempt deadline is a
   hard kill instead of a checkpoint. Raising the timeout would only move the
   kill (rule 25).
3. After a timeout the manager sets `_browser_activity_cleanup_unknown` until the
   worker's exact `browser_activity_cleanup_complete` receipt. The worker can
   only send it after it observes the timeout (next heartbeat) and joins
   teardown. `execute_tool` checked the flag immediately and raised, so any
   spawn queued behind the timed-out turn was refused by construction.

Repro (fails on the pre-fix handler): `BLACKBOX_CASE_FUNCTIONS=test_browser_task_checkpoints_before_its_activity_start_to_close,test_browser_activity_queue_lifecycle python scripts/run_blackbox_tests.py spawn_browser_agent_v3`
→ `AssertionError: started a step the activity may not outlive: 247` and
`AssertionError: successor refused without waiting for the cleanup receipt`;
`python scripts/run_blackbox_tests.py browser-cleanup-receipt` → 3 failed
(`timeout_teardown_receipt` …). All pass after the fix.

## Solution

- `_activity_deadline_near()` adds `BROWSER_ACTIVITY_DEADLINE` as a drain reason:
  when this attempt's StartToClose leaves less than
  `BROWSER_SESSION_MIN_REMAINING_SECONDS` (one supervised step plus teardown),
  the task checkpoints and the manager restarts it at the same step on the same
  session. The 30-minute timeout is unchanged and `MAX_ITERATIONS` still bounds
  the task. Budgets shorter than two margins (3 min Fast Mode demo) stay hard
  ceilings.
- `execute_tool` waits up to `BROWSER_CLEANUP_RECEIPT_WAIT_SECONDS` for the
  exact receipt through `wait_condition_or_generation_handoff` before refusing.
  Without a receipt the fence still holds. Elapsed time alone never clears it.
- 10k agents: one per-workflow timer only after a timeout, no polling, no shared
  state. The checkpoint reads the activity's own info.

Not covered here: the 09b554a3 `Browser session cleanup failed` provider
release error (2026-11-11). It is a separate provider cleanup failure and keeps
the fence held, as intended.

## Human feedback

None recorded. The assignment required: never raise the timeout as a
workaround, do not touch the live phone, do not call Connect and do not resume
agents.

## Reusable lesson

Every hard activity deadline needs the same step-boundary checkpoint as deploy drain, and every fence that waits on a signal must wait a bounded time for it before refusing.
