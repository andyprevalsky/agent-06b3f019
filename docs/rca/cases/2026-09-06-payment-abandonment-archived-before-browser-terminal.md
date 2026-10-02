---
id: 2026-09-06-payment-abandonment-archived-before-browser-terminal
date: 2026-09-06
title: Payment-abandonment benchmarks froze Hub evidence without a durable browser terminal
surface: cross
component: spawn-browser-agent-v3-and-benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py SpawnBrowserAgentManagerV3 started the cancellable activity before allocating its stable browser task ID, then persisted session_paused after TRY_CANCEL while the activity's task_complete write was only best effort
symptoms:
  - 'FE link browser validation failed: browser task 5955d7c7-281f-43fe-9552-3b6abf64fcd3 has not terminated (missing action_type=task_complete)'
  - agent-payment-production-abandonment passed with status ACTIVE and its durable Hub bundle ended at action_type=payment_card_ready
  - Payment-abandonment browser did not reach terminal state with a recording before Hub archive
  - root pause produced action_type=session_paused and a FINISHED recording but no task_complete
  - 'new code version deployed, retry this tool' task_complete row with no task_id; purchase_cancelled / purchase_blocked rows never close the browser task
tags:
  - agentcard
  - benchmark-hub
  - browser-recording
  - payment-abandonment
  - durable-evidence
sources:
  - fleet run 3da38a07-8732-412b-a479-f674e88eeeaf
  - agent 83e9b442-612e-467c-8e9b-8fe56435a401
  - PR #1267 production verification
  - fleet run e9bbf8a2-9090-49c9-bed9-85ecac8cf9bd
  - agent 043e4578-ef91-46d6-9ec1-37520d7cebd3
  - PR #1268 production verification
  - fleet run 31b6ab02-5e02-4022-802b-1e7e23528e76 (local post-fix lifecycle)
  - agent 0aaf7e12-d050-46b4-8a35-2be0baa51b93 (durable https://www.roselabs.ai/?agent-id=0aaf7e12-d050-46b4-8a35-2be0baa51b93)
  - PR #1269 production verification at merge ef22ea81e0cda2780cd4d16d8023083ecc37df6d
  - hub run 7f9d7018-54c4-4ed6-a29c-91815c8bd380 (production)
  - agent 10a722c3-a1a3-435d-8c32-0eca142119e9 (durable https://www.roselabs.ai/?agent-id=10a722c3-a1a3-435d-8c32-0eca142119e9)
  - task production semantic workflow https://github.com/Rose-Ai-Labs/rose/actions/runs/34013583378
  - agent f2e7166d-e90f-4f25-8f07-375383eca5f4 (production 13c recurrence, 2026-10-02)
  - hub run f9f16b34-55b1-4297-8caa-38bb1d8533f9 (production)
  - PR #1381 concurrent cooperative cutover https://github.com/Rose-Ai-Labs/rose/actions/runs/36961086645
repro: agents/tests/blackbox/benchmark.blackbox.py payment_abandonment_seals_browser_before_hub_archive and agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py manager_cancelled_pause_is_task_complete, manager_generation_handoff_during_payment_card_approval_is_task_scoped, and the manager_*_terminal_is_task_scoped / manager_payment_gate_* exits
status: fixed
---

## Problem

The production `agent-payment-production-abandonment` gate passed its monetary
lifecycle checks: the purchase was voided, the organization transfer was
reclaimed, the Stripe capture was refunded, the AgentCard was closed, and no
attention request remained open. Its durable FE evidence still failed closed:

```text
FE link browser validation failed:
- browser task 5955d7c7-281f-43fe-9552-3b6abf64fcd3 has not terminated (missing action_type=task_complete)
```

Hub run `3da38a07-8732-412b-a479-f674e88eeeaf` and root agent
`83e9b442-612e-467c-8e9b-8fe56435a401` contained a playable finished recording
but ended at `payment_card_ready`; the root status captured in the run JSON was
still `ACTIVE`.

## Diagnosis

Critical path:

`browser requests payment card -> harness observes payment_card_ready -> harness
abandons and reconciles the card -> poll_agent returns its pre-submission ACTIVE
snapshot -> run_single_task archives that snapshot -> run_single_task deletes the
live root -> delete terminates the browser after the immutable archive snapshot`.

The payment lifecycle and live-agent cleanup were both correct, but their order
did not satisfy the durable evidence contract. Deletion happened after
`finalize_archive_and_score_world_model`, so its terminal browser event could not
appear in the run JSON or the Hub archive. A later pause request returned 404,
confirming that the runner had already deleted the live root and that the missing
row could not be recovered honestly from production.

The first production verification of that ordering fix exposed a recurrence at
the deeper producer boundary. Hub run
`e9bbf8a2-9090-49c9-bed9-85ecac8cf9bd` and agent
`043e4578-ef91-46d6-9ec1-37520d7cebd3` reached a fully reconciled monetary
lifecycle. The harness paused the root before archive and the transcript then
contained a task-scoped `session_paused` plus a playable FINISHED Kernel
recording, but no `task_complete`; after 60 seconds the new seal correctly failed
with `Payment-abandonment browser did not reach terminal state with a recording
before Hub archive`.

Archive searches for `browser terminal archive payment abandonment`, `payment
benchmark archive before delete`, and `refresh after pause browser recording hub
archive` found the related
`2026-08-31-fe-link-browser-terminate-recording-validation` case and its existing
pause-refresh helper. This is not a recurrence of that verifier bug: the verifier
still fails closed correctly. It is the producer-side relative that allowed a
successful early-terminal payment path to bypass the existing timeout/stall
pause-and-refresh ordering.

The recurrence is the same durable-terminal contract class, not a verifier
regression: the publisher and new seal both rejected the bad archive. The
critical path was `root pause -> workflow manager TRY_CANCEL -> browser activity
CancelledError cleanup -> manager ToolEvent -> transcript -> harness seal`. The
cancelled activity attempts to save `task_complete`, but Temporal `TRY_CANCEL`
can acknowledge cancellation before that activity-side best-effort write lands.
The manager is the deterministic cancellation observer, yet its own event used
the divergent `session_paused` action type. This made the earlier wait depend on
a terminal producer that was not guaranteed.

Archive searches for the literal seal error and for `browser pause cancel
task_complete session_paused recording durable FE` found this case plus
`2026-08-31-fe-link-browser-terminate-recording-validation` and
`2026-08-31-claude-code-chip-stuck-spinning-up-on-pause`. Runtime evidence
confirmed a recurrence/relative: browser cancellation had the same split terminal
producer already fixed for Claude Code, while the fail-closed browser publisher
continued to work correctly.

## Solution

Payment-abandonment tasks now pause the live root after the monetary lifecycle is
terminal but before context validation, log collection, trace finalization, or
deletion. The runner reuses the existing bounded post-pause refresh to wait for
both a browser terminal row and a playable recording, merges the refreshed live
transcript with harness-only lifecycle metadata, and fails the benchmark if pause
or durable browser sealing does not complete.

The focused blackbox drives an open browser snapshot through mocked pause and
refresh boundaries, verifies the refreshed transcript is terminal and retains
the payment lifecycle, pins the call ordering before archive finalization, and
proves a rejected pause is a gate failure. Before the fix it failed with:

```text
AttributeError: module 'benchmarks.run_benchmark' has no attribute '_seal_payment_abandonment_browser_for_archive'
```

The same test passes after the implementation. This adds one bounded pause and
at most 60 seconds of two-second polling only to payment-abandonment benchmark
runs; it adds no production request path, shared scan, background task, or
per-agent state and therefore does not change 10,000-agent production behavior.

The recurrence fix unifies the browser cancellation producer and moves browser
task identity to the deterministic owner. `SpawnBrowserAgentManagerV3` derives a
replay-stable UUID from the agent and tool-call IDs before starting the activity;
the backend accepts that ID at session initialization and both Kernel and Steel
(including local CDP) persist it as `BrowserSession.id`. Once the manager has
observed an activity cancellation and returns from that tool invocation, its
task-scoped ToolEvent uses the preallocated ID and
`action_type=task_complete`, matching the activity cleanup and publisher
contract even when Temporal discards the cancelled activity result. The event
remains an ERROR titled `Browser Session Paused`; pause, resume, cancellation,
session handling, and LLM-visible output are unchanged. This removes the
dependency on an activity-side write after Temporal has already acknowledged
cancellation and prevents the same missing terminal for manual root pause,
benchmark timeout cleanup, and payment-abandonment sealing.

The permanent owning-boundary regression
`manager_cancelled_pause_is_task_complete` replays a cancelled activity result
with task/session/browser metadata. On the buggy code it failed in 0.71 seconds
because the manager emitted `session_paused`; the identical assertion passed
after the producer fix. `manager_cancelled_pause_preserves_task_id` drives the
actual paused/not-done `TRY_CANCEL` branch, makes the activity raise before
returning any metadata, and requires the manager's terminal to retain the same
preallocated task ID passed into the activity. The repository HTTP regression
and backend provider-selection regression pin that ID through the init request
and provider boundary.

The post-fix local AgentCard lifecycle run
`31b6ab02-5e02-4022-802b-1e7e23528e76` passed 4/4. Its abandonment agent
`0aaf7e12-d050-46b4-8a35-2be0baa51b93` persisted a task-scoped
`task_complete` after pause, retained a FINISHED Kernel recording, reconciled
the payment as VOIDED/RECLAIMED/refunded/CLOSED, mirrored the Hub bundle, and
passed the fail-closed evidence publisher at the durable FE link recorded in
this case's sources. This is merge-enabling integration evidence, not closing
production evidence. The exact production-only benchmark cannot execute
against localhost by catalog contract; its unchanged pre-fix production run is
the outcome failure.

Production verification closed the case on merge
`ef22ea81e0cda2780cd4d16d8023083ecc37df6d`. The exact
`agent-payment-production-abandonment` gate ran with fast-mode replay disabled
and passed in 264.9 seconds as Hub run
`7f9d7018-54c4-4ed6-a29c-91815c8bd380`, agent
`10a722c3-a1a3-435d-8c32-0eca142119e9`. Its 56-message durable transcript has a
FINISHED recording and `task_complete` carrying the same deterministic browser
task ID, `9808a8ba-7a6f-586a-8bc1-a57b6f49b36b`. The lifecycle snapshot was
VOIDED/RECLAIMED/refunded/CLOSED with a succeeded live $1 Stripe capture, a
reclaimed live organization transfer, and no open attention request. The
fail-closed evidence publisher verified the recording, terminal, public FE
rehydration, and an R2-backed verifier LLM dump; its manifest is archived under
`/opt/cursor/artifacts/rca_evidence/10a722c3-a1a3-435d-8c32-0eca142119e9/`.
The exact-merge production semantic workflow also passed both the complete
frontend flow suite and five-sample chat lifecycle latency ratchet.

## Recurrence: deploy handoff during the payment approval wait (2026-10-02)

The `/deploy` 13c AgentCard production gate for PR #1362 failed with the same
seal error, `Payment-abandonment browser did not reach terminal state with a
recording before Hub archive`, for agent `f2e7166d-e90f-4f25-8f07-375383eca5f4`
(Hub run `f9f16b34-55b1-4297-8caa-38bb1d8533f9`). Another agent's cooperative
cutover (PR #1381, deploy-agents run 36961086645) landed while browser task
`01248403-b20f-5399-9963-b21c268d6fad` was parked on its payment-card approval.
`GenerationHandoffRequested` surfaced in the manager, which posted
`Browser automation interrupted` / `new code version deployed, retry this tool`
with `action_type=task_complete` but **no `task_id`**. The task already had a
FINISHED, playable Kernel recording, so the only missing piece was the
task-scoped terminal. Replaying `_agent_messages_ready_for_durable_browser_evidence`
on the archived transcript returns `False`; adding only `task_id` to that row
returns `True`. The agent was already COMPLETED, so neither the seal's pause nor
its 60-second poll could have produced the row. The parent re-issued the browser
call with a new tool-call id (new deterministic task id, new session), so the
interrupted task was never resumed or closed by anyone.

Searches for the literal seal error and for `GenerationHandoffRequested
task_complete task_id browser` found this case. It is a genuine recurrence: the
earlier fix made the pause producer task-scoped and pinned only that branch, and
it left the remaining manager exits on hand-built metadata. A parked activity
(`awaiting_write_approval`, `awaiting_payment_card_approval`,
`awaiting_auth_assistance`) posts no terminal of its own, so every manager exit
after it owns the terminal. Before this fix, these exits closed the task without
a task-scoped `task_complete`:

- deploy handoff and generic manager failure (no `task_id`)
- write-lock rejection (`write_lock_rejected`, which the FE accepts but the
  durable predicates do not)
- `purchase_cancelled` and `purchase_blocked` (no `task_id`, and not FE-terminal
  either)
- `purchase_funding_delayed`
- the AgentCard setup re-prompt and setup timeout (no terminal at all)
- the auth-assistance failure (no `task_id`)

Problem class: logical inconsistency in harness contracts. One terminal
contract had many producers, and only the one that had failed before honored it.

### Recurrence fix

`_browser_task_terminal_metadata(result, started_task_id, code=...)` is now the
single producer of manager-side terminal metadata. It emits
`action_type=task_complete` with the result's `task_id`, falling back to the id
the manager handed the started activity, plus `browser_url`/`session_id` and an
optional `code` that keeps the specific outcome (`write_lock_rejected`,
`purchase_cancelled`, `purchase_blocked`, `purchase_funding_delayed`,
`agentcard_user_<status>`, `agentcard_setup_timed_out`,
`auth_assistance_failed`). This follows the existing `purchase_above_max_limit`
precedent. Every manager exit listed above uses it.

The fallback id is recorded only after `workflow.start_activity`, so a
pre-activity failure still names no task. The AgentCard setup timeout has no
final row to annotate, so it posts an FE/evidence-only terminal with
`excludeFromModel=True`. That keeps the setup request as the parent model's tool
result, the same pattern as `_emit_browser_task_terminal_for_fe`. Titles,
messages, statuses, control flow, and every LLM-visible tool result are
unchanged. The only consumers of the old purchase action types were these
blackbox tests, and the FE and evidence predicates keep accepting historical
`write_lock_rejected` rows.

Local repro, using the same 17 manager-exit tests against `origin/main`
`a0423fed0` and against the fix:

- Before: 14 failed and 3 passed. The 3 that passed were the already-fixed pause
  exit, the already-terminal above-max-limit exit, and the pre-activity failure.
- After: all 17 passed.

The handoff test drives the production branch, a payment-card approval wait that
raises `GenerationHandoffRequested`. The exact benchmark is production-only and
needs a concurrent cutover, so these tests are the causal proof. The post-merge
13c production rerun is outcome evidence; production verification is pending
until that run passes. The change is metadata-only: no new queries, rows per
exit, or per-agent state, so its behavior at 10,000 agents is unchanged.

Open follow-ups the adversarial review raised and this fix leaves open:

- Workflow cancellation while the manager is parked re-raises with no terminal.
  Emitting one there needs a cancellation-safe activity, so this is an open gap.
- A deploy handoff leaves the parked Kernel session alive until terminal-agent
  cleanup. That is a session-cost follow-up, not verified in this RCA.

## Human feedback

The user required `/deploy when finished`; the deploy and repository evidence
rules require durable FE links to fail closed until every browser child is
terminal with a recording attached.

## Reusable lesson

Route every manager exit that ends a browser task (pause, rejection, purchase outcome, deploy handoff, failure) through one task-scoped terminal producer, and pin each exit with a test, before freezing durable evidence.
