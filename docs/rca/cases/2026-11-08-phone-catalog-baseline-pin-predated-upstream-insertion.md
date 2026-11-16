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


## November 11 recurrence: authorized deploy-only mass quarantine (OPEN)

Gate: INTRODUCED by PR1865's reviewed deploy-only user-quarantine repair
`3a17a82150c28c67669f27a51682a2d234c2a452`, compared with parent4185ac910f.
Native44 initial and rerun benchmark logs both report
`phone_daily_existing_catalog_rows_unchanged: AssertionError`. Native
occurrence7717607a030c47a8b818b6de2ca02c6b is UNVERIFIED/complete=false.
The domain diagnostic additionally lists three expected negative ownership
selftest cases; its owning test passed in both actual native logs. Those
expected negatives are not additional runtime failures or a retention defect.

The owning phone test still freezes the approved52b7 catalog. All215 rows
and their order are identical between parent4185 and current3a17 except
one field at index0: the user's exact deploy-only `deploy_quarantine` marker
on `test-mass-agent-run-0`. Every phone row, prompt, evaluator, ordinary
quarantine and other catalog field is preserved. The existing comparison
removes validated ordinary quarantine, then rejects the newly approved field.

The smallest correction is to advance only the immutable expected-catalog
pin to already-reviewed3a17, preserving the whole comparison and all Python
assert nodes. No deploy metadata is ignored or projected away. This also
freezes the authorized marker so changed reasons, other-case markers and
extra fields remain detectable. Step6a retains the existing exact comparison
and adds no parser, exception framework or alternate production branch.
Golden reference: not applicable (no approval-gated hunk). This same owning
archive case and its November9 recurrence were read before proposing the fix.

The exact existing callback, compiled with its canonical source filename and
called through the same no-argument owning boundary as the native registry,
passed against immutable parent4185 data in0.112s, failed current3a17 in0.117s,
and passed the one-pin candidate in0.110s. Nine meaningful negative controls
all reject unauthorized old/phone prompts, old/phone evaluators, changed mass
reason, a marker on another case, an extra mass field, malformed ordinary
quarantine and row reordering. All original assertions are AST-identical;
the entire module AST differs only in that one immutable Git object string.
Catalog bytes were never edited. Proof and original logs are under
`/var/tmp/deploy-mf1108/rca-phone-catalog44/`. No global benchmark rerun or
paid task was launched for this local causal proof.

The user required finishing deploy while quarantining only the named mass
test from future deploys; this correction preserves that authorized metadata
and manual benchmark eligibility. No new human feedback about this recurrence
was received. Source integration and complete fresh native agents validation
remain pending with the deploy coordinator; this recurrence is OPEN and
original native failures/outcomes remain unchanged.
