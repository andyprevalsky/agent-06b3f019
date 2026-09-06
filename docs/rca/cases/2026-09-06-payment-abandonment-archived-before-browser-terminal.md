---
id: 2026-09-06-payment-abandonment-archived-before-browser-terminal
date: 2026-09-06
title: Payment-abandonment benchmarks froze Hub evidence without a durable browser terminal
surface: cross
component: spawn-browser-agent-v3-and-benchmark-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/handler.py SpawnBrowserAgentManagerV3 persisted session_paused after TRY_CANCEL while the cancelled activity's task_complete write was only best effort
symptoms:
  - 'FE link browser validation failed: browser task 5955d7c7-281f-43fe-9552-3b6abf64fcd3 has not terminated (missing action_type=task_complete)'
  - agent-payment-production-abandonment passed with status ACTIVE
  - durable Hub bundle ended at action_type=payment_card_ready
  - Payment-abandonment browser did not reach terminal state with a recording before Hub archive
  - root pause produced action_type=session_paused and a FINISHED recording but no task_complete
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
repro: agents/tests/blackbox/benchmark.blackbox.py payment_abandonment_seals_browser_before_hub_archive and agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py manager_cancelled_pause_is_task_complete
status: open
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

The recurrence fix unifies the browser cancellation producer: once
`SpawnBrowserAgentManagerV3` has observed an activity cancellation and returns
from that tool invocation, its task-scoped ToolEvent now uses
`action_type=task_complete`, matching the activity cleanup and publisher
contract. The event remains an ERROR titled `Browser Session Paused`; pause,
resume, cancellation, session handling, and LLM-visible output are unchanged.
This removes the dependency on an activity-side write after Temporal has already
acknowledged cancellation and prevents the same missing terminal for manual root
pause, benchmark timeout cleanup, and payment-abandonment sealing.

The permanent owning-boundary regression
`manager_cancelled_pause_is_task_complete` replays a cancelled activity result
with task/session/browser metadata. On the buggy code it failed in 0.71 seconds
because the manager emitted `session_paused`; with the one-line producer fix the
identical assertion passed in 0.75 seconds. The exact production-only benchmark
cannot execute against localhost by catalog contract; its unchanged pre-fix
production run is the outcome failure, and this case remains open until the same
production gate passes on the deployed fix.

## Human feedback

The user required `/deploy when finished`; the deploy and repository evidence
rules require durable FE links to fail closed until every browser child is
terminal with a recording attached.

## Reusable lesson

Make the deterministic cancellation observer emit the same scoped terminal contract as best-effort activity cleanup before freezing durable evidence.
