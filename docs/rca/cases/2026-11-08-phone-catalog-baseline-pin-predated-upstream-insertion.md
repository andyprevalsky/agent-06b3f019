---
id: 2026-11-08-phone-catalog-baseline-pin-predated-upstream-insertion
date: 2026-11-08
title: Phone additive-catalog test retained a baseline pin from before an upstream insertion
surface: agents
component: benchmarks-phone-daily-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the exact catalog-prefix assertion compared merged main against the older b365 snapshot
symptoms:
  - phone_daily_existing_catalog_rows_unchanged
  - assert current[:len(old)] == old
  - first catalog mismatch at index 74
tags:
  - benchmark-catalog
  - source-sync
  - immutable-baseline
sources:
  - commit 43f4e25154d96b26bfa3da1d102b86c5633b6d7f
  - commit a2f08090f48ad118bf2fcc71f55b7a011190512d
  - plan:.context/deploy-google400-stabilized/attempts/47/triage/agents-coverage-blackbox/result.json
repro: agents/benchmarks/phone_daily_test.py::test_existing_catalog_rows_unchanged
status: fixed
---

## Problem

The full agents benchmark domain failed its existing exact-prefix check after
main integration. At index 74 the old baseline expected
`agent-display-revenue-chart`, while merged main contained the upstream-added
`code-agent-rose-repo` task. No task was removed to make this test pass.

## Diagnosis

Gate: INTRODUCED by integration `43f4e251`, not by a2f's cleanup helper.
The test still pinned b365's 207 rows. Upstream inserted one task at index 74,
so 133 later positional comparisons shifted. Independent canonical-JSON
comparisons proved all 207 original named rows remain identical and in relative
order, with no missing or duplicate task. The current catalog has the exact
reviewed 06416/839396 208-row prefix plus the same seven appended phone rows.
The full per-row proof is preserved in `round51-benchmark-readonly.json`.
Related archive catalog cases concern different task contracts, not this pin.

## Solution

Refresh only the immutable reviewed baseline pin to
`06416c4f9f50ecec4f5d2678620e20dc3c0fd3d0`. Preserve the exact prefix assertion
and the entire catalog. The identical owning pytest command was RED (1 failed,
0.17 s) then GREEN (1 passed, 0.08 s); all 35 phone-daily offline cases passed
in 2.24 s. All 30 original Python assert nodes are AST-identical. Both owning
supervisors were quiescent with no orphans or signals. No task prompt,
evaluator, model, deadline, financial action or status changed. A normal full
agents gate on the final source remains required.

## Human feedback

The user authorized syncing main while preserving the phone feature and all
upstream checks. That authorization does not permit dropping the new task or
claiming offline results as normal production Google acceptance.

## Reusable lesson

Advance an immutable baseline only after proving both the old rows and the complete reviewed upstream snapshot are preserved.


## 2026-11-09 recurrence: approved browser catalog edits

The PR #1865 final agents coverage run (GitHub Actions 42690638070) failed
`phone_daily_existing_catalog_rows_unchanged` at the exact prefix assertion on
source `52b7cc41f091286ce1c5d21d87aa7523f65b6814`. The benchmark domain failed;
130 other agent domains passed. The aggregate remains UNVERIFIED until its
normal complete rerun, never a waiver or a claimed passing gate.

Gate: INTRODUCED by this deploy's intentional catalog edits. The archived
`06416c4f9f50ecec4f5d2678620e20dc3c0fd3d0` prefix has 208 rows. All names and
relative positions remain; 198 rows are byte-equivalent as canonical JSON.
Exactly nine rows contain the user-approved signed-in metadata and one
(`browser-auth-assistance-declined`) contains the already-approved evaluator
change. The seven appended phone rows are identical to current main. Reverting
those ten changes would discard authorized deliverables. Main retains the old
pin and the old ten rows, so syncing main alone cannot resolve this failure.

Refresh only the immutable fixture pin to the already-approved integration
catalog at `52b7cc41f091286ce1c5d21d87aa7523f65b6814`. The catalog, task
definitions, timeout values and all 30 Python assert nodes are unchanged. This
now freezes all 215 reviewed rows, including the seven phone rows. It is not a
comparison of current data to itself: the expected value comes from an
immutable Git blob. Separate phone discovery, group, status, evaluator and
scoped-evidence checks remain independent.

Causal proof used the identical owning pytest invocation against a private
copy: old pin RED (0.09s), refreshed pin GREEN (0.07s), unauthorized old-row
mutation RED (0.08s), unauthorized phone-row mutation RED (0.08s), restored
catalog GREEN (0.06s). All 35 owning phone-daily pytest cases then passed
in 1.64s with the unchanged native pyproject configuration. The existing
benchmark blackbox dynamically registers every phone-daily test, including
this exact prefix assertion; the reported native gate confirms that wiring.
This is an offline blackbox assertion failure, not a
failed live phone benchmark; no device operation or benchmark prompt was run
or altered to obtain this proof. Native proof, exact commands and negative
controls are retained in the PR #1865 closeout evidence. The full normal
agents coverage gate on the final integrated source remains required.
