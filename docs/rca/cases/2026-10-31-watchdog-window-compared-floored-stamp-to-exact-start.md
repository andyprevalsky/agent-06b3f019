---
id: 2026-10-31-watchdog-window-compared-floored-stamp-to-exact-start
date: 2026-10-31
title: The deploy pipeline dropped memory-watchdog TERMs stamped in the run's first millisecond because it compared a floored timestamp to the exact start epoch
surface: harness
component: run-deploy-pipeline
classification: our-bug
problem_class: other
first_bad_boundary: "scripts/run_deploy_pipeline.py:watchdog_terminations — `started_epoch <= at` with `at` parsed from a millisecond-floored stamp and `started_epoch` a full-precision time.time()"
symptoms:
  - "check_watchdog_receipts"
  - "AssertionError: []"
  - "assert [row[\"pid\"] for row in receipt[\"watchdog_terminations\"]] == [4242]"
  - "watchdog_terminations=[]"
  - "failed deploy structural gates: deploy-pipeline"
tags:
  - deploy-gate
  - run-deploy-pipeline
  - memory-watchdog
  - timestamp-resolution
  - flake
  - load-sensitive
sources:
  - memory:structural-gate-load-flakes
  - commit da2dbd8b14e25c77dcd5d3b0df3fb42e27e7d9ea
repro: scripts/tests/run-deploy-pipeline.test.py
status: fixed
---

## Problem

`scripts/tests/run-deploy-pipeline.test.py` failed once on unchanged bytes
during a five-run streak beside a concurrent deploy round (log
`/var/tmp/f1-pipeline-b-run1.log`, head `8ecdffaa`):

```
  File ".../scripts/tests/run-deploy-pipeline.test.py", line 419, in check_watchdog_receipts
    assert [row["pid"] for row in receipt["watchdog_terminations"]] == [4242], receipt["watchdog_terminations"]
AssertionError: []
```

The check starts the driver on a `sleep 2` lane, waits for `receipt.json`,
stamps a TERM row `at=datetime.now(utc).isoformat(timespec="milliseconds")`,
appends it to the watchdog log, and expects the receipt to attribute it. The
driver returned an empty list although the row was written inside the run.
The quiet-box streak (`/var/tmp/sf8-tests/quiet/summary.txt`, load ~1) passed
5/5, so the failure was filed as load-sensitive.

## Diagnosis

Critical path: driver sets `receipt["started_epoch"] = time.time()` and writes
`receipt.json` atomically → the test's 50 ms poll sees the file → the test
stamps `during` and appends the row → the lane runs 2.4 s → the driver calls
`watchdog_terminations(started_epoch, finished_epoch)` which keeps a row only
when `started_epoch <= at <= finished_epoch`.

Timing probe of the unchanged check (`/var/tmp/sf8-flake/probe-watchdog-1.log`,
8 runs at load ~17): `during - started_epoch` was +3 ms to +45 ms — the poll
lands a few milliseconds after the rename. `isoformat(timespec="milliseconds")`
floors the microseconds, so the parsed `at` is up to 0.999 ms earlier than the
instant the test took. When the poll lands within a millisecond of the receipt
the floored stamp sorts before `started_epoch` and the row is dropped.

End-to-end reproduction on the unchanged check and unchanged driver bytes
(`python /var/tmp/sf8-flake/repro.py --check watchdog --runs 80 --load 0
--stop-on-fail`, `/var/tmp/sf8-flake/watchdog-80.log`): run 72 of 72 failed
at load 0.9 with exactly the production signature:

```
RUN 72 FAIL 2.4s load1=0.9->0.9: AssertionError: []
  receipt: started_epoch=1793445378.524657 finished_epoch=1793445380.7559714
  row pid=4242 at=2026-10-31T11:16:18.524Z epoch=1793445378.524 at-started=-0.001s
```

`at` parsed to 1793445378.524, 0.657 ms before `started_epoch`. Load is not a
cause: the race is between the poll and the rename at sub-millisecond scale,
and 71 of the 72 runs at load 0.9 missed it by 3–45 ms.

Why possible (Step 5a): the window test treated a truncated stamp as an exact
instant. The real watchdog (`/run/boxes-memory-terminations.jsonl`) also stamps
`at` to the millisecond, and the test's own `before` row models producers that
stamp whole seconds; against either, every TERM that lands in the run's first
resolution unit after `started_epoch` is unattributed. The deeper rung — the
watchdog's chosen resolution — is third-party; stop there.

Problem class: an interval membership test that compares a resolution-floored
timestamp against a full-precision boundary. No taxonomy bucket names it;
candidate bucket "timestamp resolution mismatch at an interval boundary".

Archive searches (`watchdog_terminations receipt started_epoch window
AssertionError []`, `load-sensitive flake sampler 1 Hz timing assumption fixture
deploy pipeline`, `observations are still sampled ...`): no prior case; novel.

## Solution

`watchdog_terminations` now derives each stamp's resolution from its own digits
(`_iso_epoch_interval`: "…:41.333Z" covers [41.333, 41.334), "…:41Z" covers
[41, 42)) and keeps a row when that interval overlaps the run window
(`interval[1] > started_epoch and interval[0] <= finished_epoch`). The end
comparison is unchanged. Production code change, in the driver.

Regression, in the owning suite `scripts/tests/run-deploy-pipeline.test.py`
`check_watchdog_receipts` (deploy structural gate `deploy-pipeline`): six rows
around a start of 20.4237 and finish of 22.9237 — a stamp floored 0.2 ms past
the start, one whose whole millisecond precedes it, a whole-second stamp in the
start's second, the second before, 0.7 ms before the finish and after it — must
yield pids `[1, 3, 5]`. On the da2dbd8b driver bytes the same rows yield `[5]`
and the run-72 values yield `[]`; on the fixed driver `[1, 3, 5]` and `[4242]`
(`/var/tmp/sf8-flake/boundary.py`). The end-to-end check is unchanged.

Siblings prevented: a TERM stamped whole seconds in the run's first second,
and a watchdog TERM in a real deploy's first millisecond, are now attributed.

10k-agent: one receipt read per run; the interval arithmetic is per row.

## Human feedback

The coordinator required an induced-load local repro before any fix, no
lowered thresholds, no longer timeouts and no retries; the fix had to make the
assertion deterministic. No feedback on the fix itself was recorded.

## Reusable lesson

When testing whether a stamped event falls inside a window, treat the stamp as the interval its resolution implies, never as an exact instant against a full-precision boundary.
