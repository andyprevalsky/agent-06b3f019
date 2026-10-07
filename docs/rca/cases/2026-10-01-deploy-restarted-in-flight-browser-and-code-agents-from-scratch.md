---
id: 2026-10-01-deploy-restarted-in-flight-browser-and-code-agents-from-scratch
date: 2026-10-01
title: Deploys killed in-flight browser and Claude Code activities instead of resuming them where they left off
surface: agents
component: deploy-drain-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py step loop and spawn_claude_code_agent/service.py monitor loop, which had no way to checkpoint when their worker began draining
symptoms:
  - Tool interrupted by deployment
  - DEPLOY_INTERRUPTED
  - browser task fails with a heartbeat timeout during a rolling deploy
  - Claude Code run reports cancelled by user after a deploy
  - a retried Claude Code activity creates a second sandbox and starts over
tags:
  - deploy
  - drain
  - browser-agent
  - claude-code
  - continue-as-new
  - temporal
sources:
  - agent 3efa7cae-8051-4efd-9c49-d09f65b6e22e
  - commit 30e102346
  - commit 75754719f
  - commit 145990cd9
  - PR #1354
repro: agents/tests/blackbox/deploy_resume_e2e.blackbox.py
status: fixed
---

## Problem

On agent 3efa7cae a deploy stopped the worker running a browser task. The
activity kept stepping until the process died, Temporal reported a heartbeat
timeout, and the single-attempt browser task failed instead of continuing. The
user expected deploys to leave running agents exactly where they were.

Claude Code had the same shape, but worse. On SIGTERM the activity monitored
until the 5-minute grace expired, then took its pause path: it closed the E2B
sandbox that was still working, and the parent read "cancelled by user". A
crashed worker caused the Temporal retry to create a second sandbox and restart
from zero.

## Diagnosis

Long activities (browser up to 30+ minutes, Claude Code up to its max runtime)
outlive a worker's deploy lifetime, and nothing let them hand off:

- The activities never asked whether their worker was draining
  (`activity.is_worker_shutdown()`), or whether their generation's queue had been
  superseded by a cutover.
- Browser activities are single-attempt (`MAX_ACTIVITY_ATTEMPTS = 1`) because
  automatic retries could duplicate external writes. So any mid-step death was
  terminal.
- The Claude Code activity could not tell a requested cancel from a
  worker-shutdown cancel, so it treated a drain as a user pause.
- Each heartbeat replaced the details a retry reads, so one heartbeat without
  details (an LLM-stream heartbeat) erased the session a retry needed to
  reattach to.

The deepest owned cause is that resumability was implemented only for
user-initiated pauses (write-lock and approval), not for the platform's own
deploys.

## Solution

- `helpers/activity_generation_drain.activity_drain_reason()` reports
  `worker_shutdown` or `generation_superseded`. It does one pointer read per
  worker per 30-second window, and fails open.
- Browser: between steps, with no approved action owed, the loop checkpoints the
  same resume payload a write-lock pause returns and returns
  `yielded_for_deploy_drain`. The manager restarts the task at that step on a
  live worker. On a cutover it parks the tool call across `continue_as_new` so
  the new generation re-enters the same tool call: one chip, no
  `DEPLOY_INTERRUPTED`, usage billed once.
- Claude Code: on a drain the activity detaches without touching the sandbox and
  returns its `code_session`. The ws-server keeps serving its final buffer for
  late reattaches. Sticky heartbeat details
  (`helpers/activity_heartbeat.py`) keep the attached session on every beat, so
  a retry after a dead worker reattaches instead of creating a sandbox. Only a
  requested cancel closes the sandbox.
- Explore: cemented that a live explore's parent wait plus cancel grace fits
  inside the worker shutdown grace, so explores finish or recover their evidence
  before the machine exits. They need no reattach machinery.
- End-to-end repro (`deploy_resume_e2e.blackbox.py`): a real `AgentWorkflow`
  runs the real browser and Claude Code activities on real Temporal workers, and
  only external services are faked. Two deploy shapes are covered. In a rolling
  deploy, a new machine joins the queue and the old one gets a real
  `Worker.shutdown()`. In a cutover, the queue pointer moves to a new generation
  mid-run. Each test asserts that the old machine stops within its grace, that
  the task finishes from the step where it stopped on the same Steel session or
  E2B sandbox, that the user sees one chip, and that usage is billed once.
  Before the fix all four tests fail: the browser shows "Browser Session Paused"
  or runs every step on the old generation, and Claude Code shows "Session
  Cancelled" or never releases the run.
- Narrower repros: the real browser step loop yielding under
  `ActivityEnvironment.worker_shutdown()` in `spawn_browser_agent_v3.blackbox.py`,
  the real ws-server drain and reattach in `spawn_claude_code_agent.blackbox.py`,
  and parked-tool cutovers in `workflow.blackbox.py`.

10k agents: one cached pointer read per worker process per 30 seconds; parked
calls are bounded by the 256KB carry budget, and larger resume snapshots go to
the encrypted archive.

Residuals: a browser Steel session is not released when the user pauses after a
drain yield; `APPROVAL_REQUIRED_TOOLS` must never park; a heartbeat-error cancel
(`cancellation_details` is None) is treated as a requested cancel.

## Human feedback

The user asked that deploys let in-progress browser agents "pick up exactly
where they left off" rather than kill them, and that explore and coding agents
get the same treatment.

## Reusable lesson

Any activity that can outlive a worker's deploy lifetime needs a checkpoint at a
safe boundary that is triggered by worker drain, not just by user pause.


## Verification fixture maintenance, October 6

The full covered deploy-resume domain on commit850706177 failed its rolling
deploy checks at the elapsed shutdown assertions. Those assertions measured
the whole awaited Temporal Worker.shutdown, including polling/runtime teardown,
against the activity grace. Elapsed shutdown time alone cannot establish that
an activity was cancelled. The original production drain/resume repair remains
in place; this is maintenance of its fixture endpoint contract.

Two archive searches were `rolling deploy shutdown grace elapsed` and
`Worker.shutdown activity handoff joined task`. This case owns the exact browser
and code handoff. Its original real native join, same Steel session/E2B sandbox,
activity yielded-for-deploy-drain to completed sequence, one chip and usage
assertions remain required. The SDK activity grace inputs remain3 and4seconds.

The fixture now requires the old worker task to be joined after shutdown instead
of rejecting total wall time. A controlled4.2second delay inserted only after
that native join reproduced both original elapsed assertions: two failures in
69.083seconds. The same browser control passed41.634seconds with the endpoint
change. Its paired code setup hit a separately retained native EADDRINUSE before
the owning handoff; it earned no pass. A normal fresh fixture port, without
signalling any listener, then passed the missing code control in34.860seconds.
These split receipts are not represented as one uninterrupted two-case run.
All four ordinary real Temporal worker cases then passed in87.349seconds.

Only the two wall-time assertions become joined-worker endpoint assertions. All
other test functions, runtime code, grace budgets and downstream handoff checks
are unchanged. Captured native child births are independently revalidated absent;
no provider/model calls were added. The original covered failure and the native
port setup failure remain private and retained. Final normal covered-domain and
combined deploy qualification remain pending; these local controls supply no
benchmark acceptance or production performance claim.
