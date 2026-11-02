---
id: 2026-10-31-credit-fixture-bounded-last-deferral-sample-by-block-size
date: 2026-10-31
title: The materialized-credit fixture bounded the final deferral's holder sample by the block size although the 1 Hz sample before the reap can postdate the holder's free
surface: harness
component: run-deploy-pipeline
classification: test-bug
problem_class: other
first_bad_boundary: "scripts/tests/run-deploy-pipeline.test.py:check_materialized_reservation_credit disabled arm — `last[\"running\"][\"holder\"][\"tree_anon_mb\"] >= 50` on the joiner's final deferral record"
symptoms:
  - "AssertionError: observations are still sampled and recorded for evidence"
  - "check_materialized_reservation_credit"
  - "assert last[\"running\"][\"holder\"][\"tree_anon_mb\"] >= 50 and last[\"running\"][\"holder\"][\"tree_pss_mb\"] >= 50"
  - "failed deploy structural gates: deploy-pipeline"
tags:
  - deploy-gate
  - run-deploy-pipeline
  - memory-admission
  - process-tree-sampling
  - fixture-timing
  - flake
  - load-sensitive
sources:
  - memory:structural-gate-load-flakes
  - PR #1640
  - commit da2dbd8b14e25c77dcd5d3b0df3fb42e27e7d9ea
repro: scripts/tests/run-deploy-pipeline.test.py
status: fixed
---

## Problem

`scripts/tests/run-deploy-pipeline.test.py` failed once (run 5 of 5, 34 s in)
on unchanged bytes beside a concurrent deploy round at load ~8.8
(`/var/tmp/f1-pipeline-run5.log`, head `ffcb33a6`), in the
`DEPLOY_ADMISSION_CREDIT=0` arm of the inherited-flag variant:

```
  File ".../scripts/tests/run-deploy-pipeline.test.py", line 558, in check_materialized_reservation_credit
    assert last["running"]["holder"]["tree_anon_mb"] >= 50 and last["running"]["holder"]["tree_pss_mb"] >= 50, \
AssertionError: observations are still sampled and recorded for evidence
```

The focused rerun on the same bytes passed; a quiet-box streak passed 5/5.

## Diagnosis

Critical path: the holder lane (`b'x' * 60 MiB`, marker, `sleep 4`, `del
block`, exit) runs under `scripts/run-deploy-stage` → the driver's loop samples
every running lane's process tree once per `HOST_SAMPLE_SECONDS` (1 s) and
re-marks it with that pass's value → with the credit disabled the joiner is
deferred on every check until the holder is reaped → `deferred.last` is the
inputs of the final deferral, carrying the holder's latest sample.

Timeline of the unchanged plan in-process, every sampler call stamped
(`/var/tmp/sf8-flake/probe-window-2.log`, quiet box): samples at 1.01, 2.02,
3.03 and 4.04 s after the holder's spawn read 79.7 MB; the holder freed its
block at 4.10–4.12 s and its lane was reaped at 4.24–4.25 s. The stage
wrapper's post-command work (`_worktree_fingerprint`, record writes) keeps the
lane alive 0.09–0.29 s after `del block` (`probe-window-1.log`, load ~17), and
the fourth sample sits only 60–80 ms before the free. Load moves both edges —
holder startup grew from 0.10 s quiet to 0.30–0.56 s at load 17 and the 0.2 s
loop granularity drifts the sampler — so the last 1 Hz sample can land inside
the freed→reaped window, where the tree truthfully holds ~15–20 MB.

Deterministic mechanism repro (`/var/tmp/sf8-flake/probe_linger.py`): the same
plan with the holder lingering 2 s after `del block`, so a sample is guaranteed
after the free:

```
RUN 1 last.running.holder={anon=19.6, pss=19.9, obs=disabled, age=0.01} holder.peak_anon=79.6
      OLD-assertion(last>=50)=FAIL NEW-assertions=PASS
RUN 2 last.running.holder={anon=19.6, pss=23.3, obs=disabled, age=0.0}  holder.peak_anon=79.6
      OLD-assertion(last>=50)=FAIL NEW-assertions=PASS
```

The driver is correct: "every pass re-marks every running lane" and the final
deferral records the latest sample. The fixture assumed that sample predates
the free. Ten runs of the unchanged check under 16 CPU burners (load 15–18)
passed; the window needs the sampler phase to drift into it, which the deploy
round's process count (longer `/proc` scans) and I/O supply and a CPU-only
load does not — the mechanism is proven by the timeline and the linger repro,
not by a CPU-load recurrence.

Why possible (Step 5a): the assertion bound a record to the fixture's block
size instead of to the driver's own sampled state; nothing in the plan ties
the holder's lifetime to the sampler. Sibling in the same fixture: the enabled
arm's `admission.running.holder.tree_anon_mb >= 50` is taken at the admitting
check, which the credit only reaches once a fresh sample is >= 40 MB, so it is
bound to the sampled state already (a mid-fill sample of 40–49 MB remains a
residual, unobserved risk).

Problem class: a fixture asserting a bound on a periodically sampled value
without controlling where the sample falls in the sampled process's lifetime
(`other`; same class as the timing fixtures in `memory:structural-gate-load-flakes`).

## Solution

The disabled-arm assertions now bind the final deferral record to the sampled
state: sampling saw the block (`holder.tree_peak_anon_mb >= 50` — deterministic,
the block is held 4 s against a 1 Hz sampler — and `tree_sampled_at` set) and
the record carries that sampling (`tree_anon_mb`/`tree_pss_mb` present,
`0 < anon <= pss`, both at most the lane's peaks, `observed_age_s >= 0`,
`observation == "disabled"`). The `>= 50` bound stays on the record that
guarantees it; the final deferral is no longer required to predate the free.
No driver change, no threshold lowered, no timeout or retry added.

10k-agent: test fixture only; no runtime path.

## Human feedback

The coordinator required an induced-load local repro before any fix, no
lowered thresholds, no longer timeouts and no retries; the fix had to make the
assertion deterministic. No feedback on the fix itself was recorded.

## Reusable lesson

Assert a periodically sampled value against the sampler's own recorded state (peaks, freshness, consistency), never against what the sampled process is assumed to hold at an uncontrolled instant of its lifetime.
