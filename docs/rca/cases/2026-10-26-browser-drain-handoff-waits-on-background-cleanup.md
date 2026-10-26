---
id: 2026-10-26-browser-drain-handoff-waits-on-background-cleanup
date: 2026-10-26
title: Under deploy-gate load a drained browser activity missed the 3 s rolling-deploy grace, so it failed instead of resuming
surface: agents
component: spawn-browser-agent-v3-drain-handoff
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py:9445-9505 drain-yield return — the drained activity's result is reported only after the background browser cleanup finishes, so cleanup time sits on the graceful-shutdown critical path
symptoms:
  - "the browser task must finish exactly once"
  - "WorkerShutdown: Worker is shutting down and this activity did not complete in time"
  - "Browser manager failed ... error_type=ActivityError"
  - rolling_deploy_resumes_browser_task_on_the_new_machine fails in the /deploy agents coverage gate (Step 4g) only
  - chips show 'Browser automation failed' and no 'Browser automation complete' after a rolling deploy
tags:
  - deploy-resume
  - rolling-deploy
  - browser-drain
  - load-sensitive
  - coverage-gate
sources:
  - deploy branch deploy/devbox-20261026-ui26 @ 6a9c39735 (Step 4g agents coverage, 2026-10-26)
  - /tmp/ui26-int/deploy-resume-e2e-fail.log (gate failure log, not committed)
  - agents/tests/blackbox/deploy_resume_e2e.blackbox.py:76 (BROWSER_DEPLOY_GRACE)
repro: agents/tests/blackbox/deploy_resume_e2e.blackbox.py (rolling_deploy_resumes_browser_task_on_the_new_machine) — passes locally; the failure is not reproduced
status: open
---

## Problem

On 2026-10-26 the `/deploy` agents coverage gate (Step 4g) ran on the
combined branch `deploy/devbox-20261026-ui26` @ `6a9c39735`. The domain
`deploy-resume-e2e` failed one case,
`rolling_deploy_resumes_browser_task_on_the_new_machine`, with "the browser
task must finish exactly once". Observed chips: `[..., 'Starting up a
browser', 'Browser automation failed', None, '✓ Attempting completion', ...,
'✅ Task Complete']`. There was no 'Browser automation complete'.

Timeline from the gate log:

- 19:58:08 `Browser task yielding at step boundary` (`drain_reason=worker_shutdown`, step 3)
- 19:58:08 `Browser cleanup started in background`
- 19:58:10 `Browser cleanup finished in background` (2 s under load; about 1 s or less when idle)
- 19:58:11 the manager on the new machine received `ActivityError` / `WorkerShutdown: Worker is shutting down and this activity did not complete in time`. It posted 'Browser automation failed' and did not restart the task.

The old machine's grace is `BROWSER_DEPLOY_GRACE = timedelta(seconds=3)`
(`deploy_resume_e2e.blackbox.py:76`). The gate ran while the deploy structural
gates were running. `/deploy` runs those in parallel with Group 3 by design,
so this overlap will recur.

## Diagnosis

The drain yield (`handler.py:9445-9505`) returns its `BROWSER_DRAIN_YIELD_STATUS`
result promptly. The activity's completion reaches the old worker only after
the background browser cleanup (`_schedule_browser_cleanup`) finishes:
CDP/Playwright stop, diagnostics, recorder and recording finalization. Under
CPU contention plus coverage tracing, the in-flight step plus that cleanup can
exceed the 3 s graceful-shutdown window. The SDK then fails the activity with
WorkerShutdown and the yield result is lost, so the task fails instead of
being handed to the new machine.

The suspected ui26 regression was ruled out. Same test, same conditions, with
only the ui26-changed agents files swapped back to `f8bfbc45a`. The metric is
the test's own "old machine stopped N s after SIGTERM (grace 3 s)":

| Condition | HEAD 6a9c39735 | f8bfbc45a files |
|---|---|---|
| Idle, 3 runs each | 0.61–0.62 s | 0.60–0.63 s |
| 4 busy loops pinned to the test's core | 1.79 s | 1.52 s |
| Coverage plus 6 busy loops on one core | 2.46 s | 2.47 s |

All of these local runs passed; the gate failure was not reproduced. ui26 did
not change the drain path:

- The post-close unread-input read runs only after the completion, max-steps,
  user-pause and failure closes.
- The pause lane's "Browser Paused" row is gated on `paused_session_id`, which
  is unset when draining.

Status is therefore open, as an observability gap. Under heavy load the
margin is about 0.5 s, and the cleanup duration was never measured inside the
gate.

## Solution

None shipped. Raising `BROWSER_DEPLOY_GRACE` would mask the race and is not
allowed (timeouts are not raised as workarounds).

Open follow-up for the deploy-resume / browser-drain owner, who owns
`handler.py:9445-9505` and `_schedule_browser_cleanup`: take background cleanup
off the drain handoff's critical path. The drained activity's yield result
should be reported to Temporal before local cleanup runs. Provider session
pause and CDP release stay owned and bounded, but must not delay the result
the new machine needs. Add a deploy-resume regression that injects slow
cleanup (more than the grace) and still requires the task to resume and finish
exactly once.

Until then, a recurrence in the coverage gate during the structural-gate
overlap is this case, not a ui26 browser-composer or pause change. Rerun the
domain when the overlap is gone. At 10k agents the fix reduces per-drain
shutdown time; it adds no new channels or polling.

## Human feedback

None recorded.

## Reusable lesson

When a drain or handoff result must beat a graceful-shutdown deadline, report it before running local cleanup, and test that path with deliberately slow cleanup.
