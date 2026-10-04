---
id: 2026-10-04-direct-fleet-live-results-waited-for-teardown
date: 2026-10-04
title: Direct fleet registered startup in the Hub but published outcomes only after teardown
surface: harness
component: benchmark-live-publication
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet unified aggregation wrote only a local report card
symptoms:
  - Hub remains live with all task statuses starting after local outcomes exist
  - Hub never received evaluated outcomes before teardown
tags:
  - benchmark-hub
  - cloud-fleet
  - evaluation
  - teardown
sources:
  - PR #1299
  - fleet run 20261004-181653-20858
repro: scripts/tests/benchmark-live-results.test.py
status: mitigated
---

## Problem

The production Hub returned fifty `starting` rows while the same owned fleet's
local projection already had forty-seven running tasks, two passes and one
failure. Its upload timestamp still matched startup registration. Task failures
were valid evaluated outcomes; waiting for resource teardown hid useful results.

## Diagnosis

The direct fleet registered its parent in the Hub and suppressed child uploads,
but its live aggregator wrote only local files. The next Hub upload was the
final bundle after children finished. The dispatch poller already had a live
publisher; direct fleets lacked that path. Normal task results also reached the
report coordinator only after agent deletion and the phone callee's `finally`.

Archive searches were `GET /api/benchmarks/runs starting live report-card` and
`fleet benchmark frontend stale status publication`. The September 9 terminal
projection case is a relative: its terminal source was repaired, while this
first-bad boundary is pre-teardown live transport.

The real aggregator plus real Hub client against a loopback server failed with
`Hub never received evaluated outcomes before teardown`; the unchanged test
then passed in 1.45 seconds. The real task runner's pass/fail cleanup control
also failed on original functions and passed unchanged after the callback fix.
Early fixture setup failures were excluded from causal proof. Independent RCA
review checked parent identity, terminal fencing, publisher ownership and
cleanup-error replacement. Original private evidence remains outside git.

## Solution

Reuse the existing owned aggregation process and Hub transport. Changed task
outcomes publish on the next aggregation poll; unchanged metadata is coalesced
for fifteen seconds. The dispatch poller shares the same metadata projection.
An evaluation callback emits a separate reporting overlay before normal
agent/phone cleanup. The guest writes an immutable evaluated packet; after
the Hub response confirms the exact live task projection, the controller
acknowledges that packet through the existing authenticated status proxy.
The callback awaits this exact-owner acknowledgment before normal cleanup; the coordinator replaces it with the actual final result.
Repeated tasks retain distinct owning dispatches. Resource-release proof and
recording availability remain separate from early task outcomes.

The existing thirty-second transport bound applies; a one-second idle poll is
not a one-second delivery guarantee. Frontend polling remains five seconds. Publication acknowledgment has sixty
seconds of breathing room and is warning-only if unavailable; cancellation
still propagates and resource cleanup takes priority. ACK delivery uses bounded
parallel metadata requests so one slow guest does not serialize the fleet.
One compact always-run deploy control covers the real publication and cleanup
boundaries without model calls, and frontend blackbox coverage verifies live
pass/fail transitions and terminal polling retirement. Production fleet outcome
verification remains pending at this archive revision.

## Human feedback

The user requested correct frontend status updates and evaluated pass/fail as
soon as possible, before teardown, to shorten iteration. They required compact
tests cemented in deploy and prohibited adding massive verification.

## Reusable lesson

Publish evaluation outcomes through the owned live path; do not make useful
result visibility depend on resource teardown completing.

## Follow-up evidence

The next actual fleet exposed a separate startup publisher-order gap and late
post-evaluation acknowledgment warnings. Start the publisher before allocation,
forward phase changes through Hub summaries, keep polling through teardown, and
finalize only after release. Compact renderer/API controls cover the phases.
The exact post-evaluation delay cause remains open; metadata-only upload/ACK
latency receipts will distinguish it in the next actual run. Startup ordering
alone is not claimed to explain those late warnings. The final HTTP 413 boundary
is archived separately; no synthetic check grants live fleet credit.

Independent integration review also caught a final-publication edge: a failed
cleanup must retain the live flag. The unchanged owning cleanup control failed
on the pre-correction source and passed after final publication was fenced on
successful teardown, disabled clone retention, and exact owner-registry absence.
The Hub acknowledgment validates phase and startup labels as well as verdicts;
an older backend cannot acknowledge fields it omitted. The compact deploy gate
covers both boundaries without provider calls.
