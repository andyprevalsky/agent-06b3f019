---
id: 2026-10-31-r141-browser-iteration-budget-counted-initial-navigation
date: 2026-10-31
title: Initial browser navigation made iteration99 appear to exhaust100 iterations
surface: agents
component: benchmark-browser-budget
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: native iteration stop reused distinct trajectory event count including initial zero
symptoms:
  - original driver reports100/100 while highest native iteration is99
  - budget-stop request is followed by fallback pause during an in-progress goto
  - original canonical failure reports missing completed browser call
tags:
  - r141
  - it33
  - browser-budget
sources:
  - commit 71548b68172df23752d1ec866d7a8395baa3366c
  - agent c2aefaf5-4b2d-4a56-ab37-80a90f57c625
  - plan: original normal7 archive 3c69f94ea9f8df519a463fbae01f095bcf9a39f5b38695bba5e529f3383efbda
repro: exact original295-message prefix plus actual poller baseline RED and candidate GREEN
status: open
---

## Problem

It33 r002-j0016, the gift-shortlist task, remains canonicalFAILED/nativePAUSED/progress0. This case repairs a demonstrated premature native-budget decision; it does not claim the original research was correct or would pass. Source715 and all originalnormal7 receipt entries were independently checked. Original resource release is separately parent-verified.

## Diagnosis

The producer emits initialabout:blank navigation with steps_taken0. Original messages0..294 contain distinct counters0..99. At05:17:44.067, iteration99's goto is still IN_PROGRESS. The exact benchmark trajectory counter returns100 because it counts distinct values; driver14501 reports100/100. Budget-stop POST begins05:17:50.722, returnsHTTP200 at05:17:53.522, then fallbackpausePOST begins05:17:53.921. Worker receivesPAUSE05:17:55.928909. The last finished evaluate was05:17:18.774.

Native iteration counting is different from trajectory evidence counting: the native loop must reach MAX_ITERATIONS100, leave the action loop and announce its finalizer. It had not done so at iteration99. The budget response/ticket body is not captured, so its particular refusal predicate is not claimed. However, the earlier erroneous100 decision and resulting pause request are source- and original-bound.

No positive global unrecoveredtransport evidence was established. All101 retained compressed model payloads hash-verify; late oversized payloads were explicitly skipped. The gift_shortlist/under60 schema is present, and no final completion/verifier call was found. Initial progress0 and accounting0 do not establish a schema rejection.

## Solution

Frozen patchf99679817ff8190a069dbc0d104c55ddc7dad6c58c31f1986b1eb0cdd544bb5c uses the maximum native browser counter only for the native budget decision. It reuses existing instance grouping, deduplication and strict integer checks. Default trajectory/min_steps semantics, including zero, remain unchanged, as do the100limit, deadlines, task contract and finalizer refusal/pause behavior. Separate R142 owns background browser-call accounting; this patch does not change it.

Actual original-prefix replay changes native budget100 to99 while retaining trajectory100. A permanent actual-poller test proves originalRED/candidateGREEN: no stop at0..99, stop at100. Five repeated runs of counter boundaries/new poller/existing accepted-refused poller pass; ten unchanged min_steps/trajectory tests pass. Compile/diff checks pass. Tests are registered in the existing benchmarkblackbox runner. Independent B review grounded exact patchf9967981 after checking the original300 messages,295-row prefix and host driver, running the actual registered controls and all ten unchanged trajectory cases. No checkout application is claimed.

The existing test suite deliberately counts zero navigation as trajectory work. Globally removing zero would change valid smoke/minimum-step contracts, so it was rejected. R136's same-task evidence and the observation-refund case were read; neither is assumed to explain this original.

Remaining limit: iteration100 may be visible while its action is still in progress, before finalizer acknowledgement. This patch does not guarantee that distinct handshake succeeds, does not add retries/waits and does not change pause safety. Original task outcome remains immutable.

The coordinator requires unchanged task/limit semantics and independent review; these are technical scope constraints.

## Human feedback

None specific.

## Reusable lesson

A count of distinct observed counter values is not the counter's current value. Keep trajectory evidence and native execution limits separate when initialization is numbered zero.
