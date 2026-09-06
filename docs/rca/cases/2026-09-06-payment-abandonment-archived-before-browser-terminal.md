---
id: 2026-09-06-payment-abandonment-archived-before-browser-terminal
date: 2026-09-06
title: Payment-abandonment benchmarks froze Hub evidence before the browser terminal landed
surface: harness
component: benchmark-runner
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/benchmarks/run_benchmark.py run_single_task archived a successful payment-abandonment snapshot before deleting the still-active agent
symptoms:
  - 'FE link browser validation failed: browser task 5955d7c7-281f-43fe-9552-3b6abf64fcd3 has not terminated (missing action_type=task_complete)'
  - agent-payment-production-abandonment passed with status ACTIVE
  - durable Hub bundle ended at action_type=payment_card_ready
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
repro: agents/tests/blackbox/benchmark.blackbox.py payment_abandonment_seals_browser_before_hub_archive
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

Archive searches for `browser terminal archive payment abandonment`, `payment
benchmark archive before delete`, and `refresh after pause browser recording hub
archive` found the related
`2026-08-31-fe-link-browser-terminate-recording-validation` case and its existing
pause-refresh helper. This is not a recurrence of that verifier bug: the verifier
still fails closed correctly. It is the producer-side relative that allowed a
successful early-terminal payment path to bypass the existing timeout/stall
pause-and-refresh ordering.

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

## Human feedback

The user required `/deploy when finished`; the deploy and repository evidence
rules require durable FE links to fail closed until every browser child is
terminal with a recording attached.

## Reusable lesson

Freeze durable browser evidence only after the same terminal cleanup event that closes the live child is visible in the transcript.
