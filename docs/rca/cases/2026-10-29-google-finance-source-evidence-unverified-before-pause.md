---
id: 2026-10-29-google-finance-source-evidence-unverified-before-pause
date: 2026-10-29
title: BU067 source-specific historical price remains unverified before pause
surface: agents
component: browser-verifier-and-cancellation-evidence
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Captured verifier cannot establish requested Google Finance unadjusted historical price; later completion and local cancellation delivery are unrecorded
symptoms:
  - Low progress score 0.00
  - Google Finance chart evidence shows split-adjusted prices
  - Agent paused by user
tags:
  - r56
  - it14
  - polar-bu-067
sources:
  - commit 85d37fc8ab8e284459977debdef34348d825ef84
  - agent fc626be6-cd9a-422d-bd74-af1b7755b642
  - plan: original archive 4847860bd7a4ec696141795635e881df81397cdb2f851418f20460b8cfd1282e
repro: none-recorded; original encoded requests and event chronology
status: open
---

## Problem

R56 original assignment04:14UTC; cancellation-edge phase04:17UTC, both on
2026-10-29. The task asks, according to Google Finance, the first year Apple
stock exceeded $50 without adjusting for stock split. NativePAUSED2423.5s,
passed=false, canonicalFAIL/infraFALSE; no declared judge present. Root progress
is0 with failure reason Low progress score0.00. That root score is distinct
from the earlier browser verifier's0.5. No value or criterion is regraded.

The ordered119209363byte archive and all seven normal files independently
verify. Manifestdce2e8972446c7c549d9b00eac19788cf55221a5cd9c46e74be1b8e532af48ed;
run2f1c80c14a726e1466ecbbafa53663da4df025fc1ede252ba3008c06905d6e17;
worker89deb8bfadb431d0e581611b597e860fa08a7dbaf46f8fb87bdc4c00e891a27c.
Execution is85d37fc8ab8e284459977debdef34348d825ef84/patchnone.

## Diagnosis

Actual schema asks for an integer year specifically from Google Finance
unadjusted prices. At03:46:36.155089, captured verifier requestf650f6aa5a68
SHA21a662a7f6cdf782b6d685a95934152a0e752f47ecd82f32e96712df94aa459c
contains the original task, schema and recorded browser evidence. The response
extracts1983 from Digrin's Real price column ($50.49 in April1983), but returns
score0.5/task_completed=false because Google Finance unadjusted source evidence
is missing. The local catalog retains stored answer2018; that is not independent
proof of the financial interpretation and does not justify a definition change.

The actor continues, later reading Google Search finance-card adjusted prices
and reasoning that0.23 times224 establishes the1983 threshold. There is no
captured second verifier evaluation of that later derivation. Late model dumps
are skipped with payload_too_large; absence of an encoded final request is an
explicit coverage gap, not proof the actor's reasoning was right or wrong.

The final action-history entry144 is read_browser_state. Worker explicitly
logs that observation did not consume budget, with iteration99. The catalog's
browser step limit is100, wall-clock timeout0. This is not144 budgeted model
turns. Original backend records POST/pause04:02:37.665 to20004:02:38.311;
worker workflow receives pause04:02:42.465 and requests activity cancellation
04:02:42.466. An actor request starts04:02:50.146 and returns04:02:54.262;
the activity logs cancellation04:02:55.664. An existing owner-retained driver excerpt subsequently confirms the pause
initiator: cloudbench-driver.log line18485 says Browser step budget reached:
100/100 — pausing for polar judge. Exact line SHA256
9e57e844fdfe223b8bbfbd6840bd7f52e70afb1ab9b19ab1588ff6a0879c3ddd
was recomputed from the supplied literal line; owner-bound full driver SHA256
b3bec44f685284d31aa626c63cb6620c82147d63efeb829c9440c586dff08365.
The full driver bytes were not independently opened here. Lines141/165 also
record wall-clock disabled and browser step budget100. Thus the initiating
policy is a recorded100step budget pause, not a wall-clock or human pause.

## Solution

OPEN, no candidate. Missing source-specific evidence in the actual verifier is
not proof of a mechanical transport defect; no rubric/answer/model/cap changes.
Earlier provider socket closure and closed-page input errors are real but the
agent continued producing evidence afterward, so they do not establish the
terminal cause.

The separate cancellation lookup distinguishes workflow signal receipt from
activity cancellation delivery. AgentWorkflow.pause sets workflow is_paused;
the browser manager calls activity_handle.cancel. Installed Temporal worker
later handles that command, sets its cancellation event, and cancels the
activity task. The original packet has no local delivery timestamp or flag
value. Exact85 already checks activity.is_cancelled in browser_activity_checkpoint
before model preparation. Therefore the request after workflow pause is a real
ordering observation, but cannot prove a missing local-cancellation guard.
A test setting the local flag at workflow signal time would invent parity.
Needed existing proof is the activity-cancel poll/heartbeat response timestamp
for the same activity. The driver excerpt resolves the initiator but does not
resolve that local cancellation delivery gap. No new
capture, provider call or replay is requested.

## Human feedback

Parent required preserving source criterion and separating root progress0 from
browser verifier0.5, nativePAUSED from canonicalFAIL, and workflow pause from
local activity cancellation. Do not count144 action entries as144 model turns,
force a year, infer a second-verifier result from missing dumps, or attribute
the terminal outcome to recovered CDP errors. Original04:14 clock is retained.

## Reusable lesson

Bind source-specific answer and cancellation conclusions to their actual
verifier input and activity-delivery evidence, not aggregate grades or earlier
workflow signal timestamps.
