---
id: 2026-11-06-credit-fixture-gate-raced-holder-allocation-under-load
date: 2026-11-06
title: Materialized-credit fixture admitted the joiner before its holder allocated, and credited a mid-allocation sample, under host load
surface: infra
component: deploy-structural-tests
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/tests/run-deploy-pipeline.test.py:check_materialized_reservation_credit — gate lane `sleep 0.3` raced the holder's interpreter start, and the enabled/disabled arms fed the driver /proc samples taken before the holder's 60 MB block existed"
symptoms:
  - "assert holder[\"tree_peak_anon_mb\"] >= 50, holder KeyError: 'tree_peak_anon_mb'"
  - "check_materialized_reservation_credit(tmp / \"inherited-flag\", env)"
  - "assert lanes[\"joiner\"][\"admission\"][\"reserved_live_mb\"] < 60 ... 'tree_anon_mb': 40.8"
tags:
  - deploy
  - structural-gates
  - flaky
  - load
  - timing
sources:
  - PR #1724 staged deploy (failed source bf81ac6a4, originating merge 0ee70b27c), deploy-command-structural, 2026-11-06 07:49-08:03Z
  - PR #1706 (fix/deploy-structural-timing-flakes), whose event-ordered fixtures this change lands
repro: scripts/tests/run-deploy-pipeline.test.py (the inherited-flag call runs check_materialized_reservation_credit with holder_start_delay_s=1.5)
status: fixed
---

## Problem

On the PR #1724 deploy, `deploy-command-structural` (suite deploy-pipeline)
failed in `check_materialized_reservation_credit`, `inherited-flag` case:
`KeyError: 'tree_peak_anon_mb'` at `assert holder["tree_peak_anon_mb"] >= 50`.
That deploy ran 11 gates at once on an 8-CPU / 15.6 GB devbox, with load 10-18,
swap in use and the coordinator scope over MemoryHigh=11G. The same unchanged
suite passed earlier on that box and on a rerun. #1724 touched neither the
driver nor this test.

## Diagnosis

The scenario mocks headroom as 300 MB until the holder touches its marker
(after building its 60 MB block), then 120 MB. The joiner is meant to be
deferred at 120 MB with the holder still `unknown`, then admitted on credit
once a fresh sample exists. That arm's sampler stays empty until that
deferral is recorded.

The gate was a fixed `sleep 0.3`. It finished 0.6-0.8 s after the holder lane
started (measured from the receipts). Under load, the holder's interpreter
had not yet allocated and touched the marker by then. The joiner's first
decision therefore saw headroom 300: `100 + 60 <= 300`, so it was admitted
with no deferral. The sampler then never returned data and `tree_peak_anon_mb`
was never set. Joiner `started_epoch < holder finished_epoch` still held, so
line 608 was the first assertion to notice.

Repro on main 0ee70b27c: delay the holder's allocation by 1.5 s, past the
gate's margin. Result 2/2 `KeyError: 'tree_peak_anon_mb'`, and the receipt
showed joiner `headroom_mb 300`, `deferred None`, holder peak None.
Load alone (16-32 busy loops, a 5-10 GB memory hog, a MemoryHigh or CPUQuota
scope) did not open the margin on this box. Those throttles slow the driver
too.

On the event-ordered fixtures from #1706, the whole file under load 28 hit a
second case of the same class, in the explicit-enabled arm. A real /proc pass
ran while the 60 MB block was still being built: `tree_anon_mb 40.8`, fresh,
0.21 s old. The driver credited it exactly as observed, giving
`reserved_live_mb` 60, and the arm's `< 60` assertion failed. The driver was
right. The fixture had not tied its samples to the allocated holder.

## Solution

Test-only. The assertions, timeouts and driver accounting are unchanged.

- The gate exits on the holder's allocation marker (`released_lane(marker)`,
  from #1706), so the joiner's first decision always sees post-allocation
  headroom.
- Real /proc samples count only from a scan that starts after the marker
  exists. The first arm's deferral sequencing still wraps that.
- Regression: the suite's inherited-flag call runs the scenario with
  `holder_start_delay_s=1.5`, a holder descheduled past the old gate margin.
  It fails on the old gate (KeyError) and passes now.
- Also lands #1706's event-ordered fixtures for this file and its
  `reconcile_owner_runs` `waited_s` fix unchanged: the delayed-probe
  `check_observation_validity` scenario failed the same command under load
  (`unknown` instead of `stale`). Those bytes are identical to #1706.

10k-agent behavior: none. These are deploy-test fixtures, with no runtime path.

## Human feedback

None recorded.

## Reusable lesson

When a fixture switches mocked state on a child's marker, gate the dependent
lanes and the observations on that marker as well. Never rely on a sleep that
the child's startup can outlast.
