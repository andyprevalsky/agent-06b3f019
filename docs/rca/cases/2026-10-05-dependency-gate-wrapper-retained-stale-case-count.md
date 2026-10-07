---
id: 2026-10-05-dependency-gate-wrapper-retained-stale-case-count
date: 2026-10-05
title: Dependency gate wrapper retained an obsolete passed-case count
surface: harness
component: agents-benchmark-blackbox
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Four owning warm-preflight controls increased the selected suite from 44 to 48 while the wrapper kept its old count
symptoms:
  - cloudbench_dependency_rebuild_permanent_gate failed with AssertionError
  - the selected behavior suite returned zero and reported 48 passed
tags:
  - cloudbench
  - dependency-sync
  - regression
  - test-registration
sources:
  - commit e3753f80a5d518a876f173a18ba72cba4a22dc70
  - task canonical agents benchmark coverage deployment gate
repro: test_cloudbench_dependency_rebuild_behavior_is_in_permanent_gate
status: fixed
---

## Problem

The final benchmark domain reported 510 distinct passing cases and one failed
permanent-gate wrapper. The wrapper ran its intended dependency suite correctly,
then rejected the zero-exit result because it still expected the older count.

## Diagnosis

The original final aggregate failed in 167.527 seconds. Executing the exact
unchanged owning function separately reproduced its assertion failure in 36.990
seconds, while the unchanged selected behavior suite returned zero and reported
48 passing controls. The four new owning warm-preflight controls account for the
increase. No behavior case failed.

## Solution

Update only the expected passed count and its comment from 44 to 48. Preserve the
same selection, subprocess execution and zero-exit assertion. The final acceptance
retains the original failed aggregate and its 510 passing cases, verifies that the
entire module AST except this owning function is identical, and binds all runtime
and test dependencies to their original hashes. Execute the corrected actual
owning function under coverage, combine its coverage with the retained final
aggregate and unchanged domain/cache/unit coverage, then enforce the normal
coverage threshold. This is explicit composite acceptance, not a replacement
claim that the original full aggregate passed.

## Human feedback

Retain successful unchanged funded cases, reproduce the exact owning failure,
and repair its test registration without another funded benchmark reset. Do not
weaken selection, behavioral assertions or coverage requirements.

## Reusable lesson

Adding owning cases to a permanent suite requires updating its declared wrapper
count. A green subprocess result and an obsolete count assertion describe a
registration failure, not a failed runtime behavior.

## October 6 recurrence: growing selection and diagnostic cardinality

The final `9d617bc3` covered benchmark aggregate failed in 196.466 seconds.
Its unchanged dependency selector returned zero, then the wrapper rejected it
at the retained `"48 passed"` assertion after new owning cases enlarged the
selection. The other failure was a fixture-discovery mismatch documented in
the October 1 merged benchmark identity case. The four paid Blue Bottle judges
and unchanged passing cases remain valid component evidence; the original
aggregate remains failed.

The same two registered families, selected through the actual `run_all_tests`
and `BlackboxResult` path under coverage, reproduced both failures in 42.213
seconds. After the narrow registration repairs, the identical selector passed
both families in 43.372 seconds. The dependency subprocess still uses the same
`-k` expression and zero-exit assertion, and all selected behavioral assertions
are unchanged. Its observed count is printed as diagnostic output instead of
being a second acceptance condition. Pytest's no-collection exit remains a
failure. This removes the recurring need to update a count whenever the owning
suite grows.

The private selector executes no paid judge and records original native births
and terminal absence. Final acceptance composes the original failed aggregate's
unchanged passing cases with these corrected covered families and the normal
coverage report at the unchanged 80% threshold. It does not claim an exact-head
whole-domain cache pass or replace the original failed record. Archive searches
were `missing required positional arguments tmp_path monkeypatch blackbox` and
`pytest parameterized fixtures native benchmark runner stale cardinality`.
