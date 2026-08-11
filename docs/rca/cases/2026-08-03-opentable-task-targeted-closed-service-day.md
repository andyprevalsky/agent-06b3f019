---
id: 2026-08-03-opentable-task-targeted-closed-service-day
date: 2026-08-03
title: The OpenTable task targeted a day when Prospect is closed
surface: agents
component: benchmark-catalog
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: commit c549523c4 — the task fixed Prospect to Sunday without validating the restaurant's service days
symptoms:
  - Prospect is closed Sundays, so a Sunday reservation cannot be completed
  - Timeout after 605s (dynamic cap=600s)
  - the browser reported that Prospect is closed on Sundays and no reservation was available
tags:
  - benchmark
  - opentable
  - ecommerce
  - fixture
  - availability
sources:
  - commit c549523c4b
  - plan:official-hours:https://www.prospectsf.com/location/prospect/ — retrieved 2026-08-03; official hours list Monday-Friday dinner and Saturday/Sunday closed
  - plan:provider-listing:https://www.opentable.com/prospect — retrieved 2026-08-03; provider listing shows dinner Monday-Friday 5:00 PM-9:00 PM
  - plan:agents/benchmarks/runs/20260803_223558_browser-opentable-reservation,browser-instacart-grocery-order,browser-alchemy-springs-sauna,browser-hotel-booking,browser-event-ticket,browser-imax-group-tickets,minted-agent-accounts-uber.json
  - agent e254de30-7291-44c4-84dd-9412159b5f78
repro: agents/tests/blackbox/benchmark.blackbox.py test_opentable_proposed_weekday_matches_prospect_service_contract
status: open
---

## Problem

The exact task prompt was: “Use OpenTable to reserve a table for 2 at
Prospect, 300 Spear Street, San Francisco, this Sunday at 7:00 PM. If 7:00 PM
is unavailable, choose the closest standard table between 6:00 PM and 8:00 PM.
Complete the reservation using the saved guest details.”

The epoch-9 browser reached Prospect's grounded provider data and found the
restaurant closed on Sunday, then exhausted the 600-second task timeout without
a valid reservation path. Prospect's official location page lists Monday
through Friday hours and explicitly lists Saturday and Sunday as closed;
OpenTable also lists service only Monday through Friday. The task's two-hour
fallback cannot repair a closed service day.

## Diagnosis

Commit `c549523c4` introduced the Sunday prompt and matching evaluator language
without a fixture contract tying the requested weekday to Prospect's published
service days. The task therefore requires a completion that its named live
fixture cannot supply. Archive searches for the timeout, Prospect Sunday
availability, and closed restaurant task fixtures found related generic
fixture cases but no case at this first-bad boundary.

The permanent local contract reproduction records Prospect's published
Monday-through-Friday service set. The captured Sunday prompt fails membership;
changing only the requested weekday to Friday passes the identical assertion.
This proves the fixture mismatch without weakening the requirements for venue,
party size, time window, confirmation, or the final reservation write lock.

## Solution

The proposed fix changes `Sunday` to `Friday` in the title description, exact
task prompt, semantic criterion, and judge prompt. It preserves the exact
restaurant, address, party size, 7:00 PM preference, 6:00–8:00 PM fallback,
saved guest details, completion requirement, runtime checks, timeout, and
approval behavior. The task definition remains unchanged until harness-fix
approval; the exact post-change benchmark remains required for outcome proof.

## Human feedback

None recorded.

## Reusable lesson

Validate fixed live-service dates against the named provider's operating calendar before making a benchmark runnable.
