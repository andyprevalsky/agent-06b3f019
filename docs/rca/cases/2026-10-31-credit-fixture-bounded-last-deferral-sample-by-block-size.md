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


## 2026-11-02 recurrence: first eligibility assumed to precede the first real observation

Append to `2026-10-31-credit-fixture-bounded-last-deferral-sample-by-block-size`.
The earlier fix bound the *last* disabled-arm sample to actual recorded state,
but left the first enabled-arm deferral tied to a 0.3-second gate's assumed
position before the 1Hz sampler. That first historical record is not guaranteed
by the workload. The production scheduler may correctly observe the holder
before the joiner becomes eligible, admit the joiner directly using fresh credit,
and return `admission.deferred=None`.

Original full owning run: `nov2-stabilization-scheduler-retry.log` fails at the
unchanged line598 `admission["deferred"]["first"]["reason"]`. Every preceding
credit, overlap, peak-memory, observation and freshness assertion passed. The
older total<7 incident passed in that run and remains a separate open issue.

Critical path: gate completion -> joiner eligibility -> latest real holder
sample classification -> conservative reservation or fresh credit -> optional
historical deferral -> fixture assertion requiring that history. Deepest owned
cause is incomplete fixture sequencing of the deliberately asserted unknown ->
deferred -> fresh -> admitted transition. Product logic correctly permits
immediate fresh admission; its behavior must not change to satisfy the fixture.

Archive searches used literal `check_materialized_reservation_credit|admission.*deferred`
and behavioral `sample.*process.*lifetime|unknown.*observation|fixture.*sampl|fixture.*clock`.
The existing case's Solution and Human feedback were reviewed. This is a
recurrence of its uncontrolled sampling/fixture-lifetime class on the first
sample, rather than proof the prior last-sample correction was wrong.

Causal forced ordering: the external private harness preserves the .3-second
gate sleep, then waits (guarded3s) for a real native sample >=50MB before the
gate exits. This controls a valid sample-before-eligibility ordering without
fabricating any memory values or changing the owning assertions. The same
focused command runs all four arms from the exact private copied owning test.
Before: exit1 in5.055066s, exact TypeError on missing historical deferral;
native receipt shows admitted fresh holder and deferred=null.
After: exit0 in18.609038s, all four arms pass. First deferral is recorded by
the real scheduler as unknown/headroom; final admission records fresh native
memory. These are owning-function monotonic timings, excluding fixture repo
setup and copying durable evidence.

Candidate changes only the fixture's local run helper and the first arm's
explicit input contract. Its sampler calls the real sampler but withholds
observations until the actual `_record_waiting` has recorded the required
unknown headroom decision; the observer invokes the original recorder and
never creates or edits receipt state itself. Subsequent observations are real.
The disabled, explicit-enabled and permanently-unobserved arms are unchanged.
All44 existing Assert ASTs are identical, hash
`d10eb47a420c22d985ee1659f9286a1af469745ceab969faffc74aff9d8fcb0d`.
All workload constants, budgets, existing timeouts, production modules and the
first total<7 assertion remain unchanged. Negative control that credits unknown
memory incorrectly is rejected (exit1,4.787334s, missing holder peak at the
existing peak assertion); the fixture does not manufacture passing history.

One preliminary baseline also reproduced the same error. Its harness forced
all gates; before the canonical pair the harness was narrowed to force only
the first arm so the deliberately unobserved arm could run normally. That
exploratory evidence is retained separately; canonical before/after used the
same harness bytes and identical argv `python3 .../focused.py before`.

No production patch or root edits. Existing deploy structural registration
already discovers this owning test. Parent application, archive integration
and full owning gate remain pending: keep this candidate append OPEN until
those complete. Golden reference is not applicable to an ordinary test-fixture
change. No provider/DB calls, child agents or full suites were launched. All
initial root source hashes remain equal; Freedom is untouched.

Human feedback: preserve every assertion, budget and timeout; force the causal
ordering in a private copy; no production change, five-run retry loop or change
to the separate total<7 bound. Parent owns integration and all full gates.

Reusable lesson: Explicitly sequence the observation transition asserted by a
fixture instead of assuming a timed dependency will precede a sampling pass.

Integrated Nov2 follow-up: the full unchanged owning command `python3 scripts/tests/run-deploy-pipeline.test.py` completed exit 0 with `run-deploy-pipeline: all checks passed`; log `/project/rose-speed-comparison-20261028/nov2-stabilization-scheduler-final.log`. This verifies the fixture repair, not release completion.
