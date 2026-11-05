---
id: 2026-11-05-diagnosed-repair-blocked-independent-full-observations
date: 2026-11-05
title: Diagnosed repair state blocked independent full observations
surface: harness
component: deploy-test-cycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_phase independent admission required pending triage while focused_plan required every repair gate including a retained cleanup owner
symptoms:
  - independent FULL observation requires quiescent unresolved triage
  - focused plan must cover every blocking gate
  - gates still own unreconciled cleanup; refuse launch
tags:
  - deploy
  - admission
  - retained-owner
sources:
  - commit 7fb3727d88047a2fd4dad38bdec3f5112ba87b42
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_diagnosed_independent_full_keeps_blocking_debt_and_excludes_retained
status: fixed
---

## Problem

All 23 occurrences in the current deployment had blocking dispositions, so the
cycle correctly required a focused plan. A financial gate still owned native
cleanup. The focused plan must contain that gate and its universal owner guard
correctly refuses execution. Independent FULL observations were only admitted
while RCA was pending, leaving no supported transition for unrelated workers
once all failures were diagnosed. No disposition or retained obligation should
be erased to create that transition.

## Diagnosis

The registered synthetic regression creates 23 blocking dispositions, preserves
a retained owner, and attempts an unrelated original FULL command. On source
7fb3727d8 it fails `0 != 2`: the independent action rejects the diagnosed phase
before any new worker runs. With the change the identical test passes. Tests use
local synthetic commands and temporary repositories, never provider resources.
Archive searches were `needs-focused-plan retained owners` and `triage independent
full observation`; related ownership cases did not cover this transition gap.

## Solution

Allow the existing independent action in quiescent `needs-focused-plan` with
recorded disposition evidence. Exclude retained gate/worker identities and
current or historical conflicting roots. Keep original commands, FULL inventories,
source/environment/input verification, native receipt validation, admission
locks and all original failures/repair obligations. Successful observations leave
the phase unchanged and ready false; fresh failures return to RCA with prior
repair obligations carried forward. Normal focused/full/final transitions are
unchanged. No skips or readiness credit are manufactured.

Nine targeted regressions cover retention, repaired FULL observations, invalid
or missing dispositions, stale inputs, non-quiescence, concurrent coordinators,
new failure routing, no empty attempts, and unchanged focused/final requirements.
A successful native FULL observation is reusable only through the existing
strict receipt checks, not by rewriting its old failing occurrence.

## Human feedback

The user required the retained financial worker and forensic database to remain
untouched, all 23 failures to remain blocking, no state reset or disposition
reopening, no provider/financial/live pipeline execution, and isolated-clone
implementation and verification. Parent owns integration and deployment.

## Reusable lesson

Separate independent observation admission from repair completion without weakening exact resource ownership or changing historical outcomes.


## Validation

The full registered cycle suite passes 180 tests. The targeted admission cohort
passes twelve tests, deploy static checks pass nine tests, and planner checks pass
22 tests. The structural-runner suite passes 64 of 65: its unchanged documentation
control reports that Step 4s does not list the already registered
`python3 scripts/tests/local-stack-retention.test.py`. The registry, failing test,
and Step 4s document match the starting source byte-for-byte; the isolated
single-test control reproduces that independent failure. This patch leaves the
separate retention work untouched and does not claim that structural suite green.


Independent review identified two path-admission holes before parent integration:
exact-only exclusions did not cover ancestors/descendants, and relative gate cwd
was compared relative to the invoking shell rather than the explicit source root.
Two registered regressions fail before correction and pass afterward. All worker
path comparisons now use the shared execution-root resolution and symmetric
overlap check; original receipt validation and cleanup code are unchanged.

A second review found cloud-CLI metadata could name a declared worker checkout
while the actual local driver ran from the coordinator root. Root exclusions
previously applied only to local-isolated transports. Two exact synthetic
cloud-CLI admission controls failed on that implementation and passed after
checking every transport's actual invocation cwd. Declared worker roots remain
additional host-scoped conflicts; remote paths are not resolved as local paths.
A separate transport control covers boxes-thread, SSH, cloud-CLI, and explicit
drivers and rejects ambiguous relative remote roots. No original failure,
repair obligation, command, timeout, assertion, or readiness rule is relaxed.
