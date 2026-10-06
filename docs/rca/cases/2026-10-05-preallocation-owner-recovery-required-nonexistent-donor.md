---
id: 2026-10-05-preallocation-owner-recovery-required-nonexistent-donor
date: 2026-10-05
title: Exact recovery required a donor for a controller canceled before allocation
surface: infra
component: cloudbench-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: exact_recovery_is_pool_only rejected canonical empty ledgers and entered a clone source graph with zero roots
symptoms:
  - documented exact-owner recovery failed before retiring an empty owner registry
  - 41 canceled preflight owners had no pool claims or clone allocations
tags:
  - cloudbench
  - exact-owner-recovery
  - preallocation
sources:
  - agent /root/fresh_cli_validation actual 50-copy CLI diagnostic
  - agent /root owning reproduction and independent review
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_pool_only_skips_nonexistent_warm_source
status: fixed
---

## Problem

After an interrupted startup diagnostic, the documented
`run-bench-fleet --recover-stale-owner <exact-token>` command failed on an
owner whose canonical clone, expected-fresh, fresh, machine-index and pool
ledgers were all empty. Its source-graph resolver required one external donor
root even though this controller had never allocated a resource.

The actual failed recovery and allowlisted identity evidence remain private in
`.context/fresh-cli-validation-20261005/`. The earlier diagnostic remains failed
and receives no execution, lifecycle or acceptance credit.

## Diagnosis

The existing no-fresh-source path required at least one borrowed pool record.
Removing the last pool record therefore changed an otherwise valid empty owner
into an invalid source graph. A filesystem Hub-root mismatch was initially
inferred from generic error words; matching the actual exception to its source
constant corrected that interpretation. Hub ownership fields were correct.

Archive searches for `empty allocation recovery donor` found related exact
recovery mappings and unused capacity reservations. Those cases did not cover
the entirely empty allocation graph.

## Solution

Permit an empty or absent pool directory in the existing no-fresh-source path.
The pool directory is created only at the first claim. The first repair admitted
an empty directory, but the actual CLI retry still failed because the original
preallocation owner had no such directory. Its same recorded failure was kept;
the owning control was extended to that actual shape before the final repair.
The next actual retry passed the source guard and exposed the same absent-pool
assumption in the runtime-evidence mapper. That consumer now also interprets
absence as zero borrowed claims, retaining all task/provenance, admitted-output,
guest result, log/hash and durability checks. It adds no guest receipt to an
unallocated task.
Retain the exact owner/app/run binding, ordinary directory checks, empty clone
and fresh ledgers, source-manifest exclusion and validation of every present
borrowed pool record. Existing non-directory or linked pool paths remain rejected.
Normal recovery still owns registry, Hub, capacity and
proxy retirement. This adds no inferred Machine identity or cleanup credit.

## Verification

The extended existing control failed old source at the empty-pool assertion in
1.23 seconds. The unchanged control then passed the repair, together with the
existing unsafe hierarchical graph control, in 0.44 seconds. It also rejects
a populated partial clone ledger and a linked pool directory. The real absent
directory shape failed the intermediate repair in 1.38 seconds and passed the
same extended control plus unsafe graph cases in 0.68 seconds. The existing
runtime-copy control's absent-pool and preallocation cases failed old mapping in
0.22 seconds; all 12 existing recovery controls passed the repair in 1.29 seconds.
An independent reviewer passed all 10 copy/corruption/fsync variants in 1.16
seconds. The same documented actual recovery then exited successfully in 1.22
seconds, retired that exact registry and sealed provider teardown. The original
failed benchmark remains rejected; retained Hub ownership is a separate cleanup
step. The existing
compact deploy control selects both owning tests; no paid verification is added.
Actual stale-owner recovery is a separate runtime check, and cannot turn the
interrupted diagnostic into an accepted benchmark.

## Human feedback

The user requested a usable documented CLI, safe interruption, quick cemented
regressions and independent validation from a fresh context. Recovery must
release real ownership without inventing evidence or restarting valid work.

## Reusable lesson

An exact owner can exist before its first resource allocation. Validate that
empty state directly instead of requiring a source graph that cannot exist yet.
