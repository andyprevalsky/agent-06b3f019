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
