---
id: 2026-11-05-round19-native-source-mismatch-isolation
date: 2026-11-05
title: Round19 native source mismatch blocked isolated successor admission
surface: harness
component: deploy-test-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: isolated_canary_release requires the failed canary ref to equal requested source despite its authentic unpatched base provenance
symptoms:
  - failed canary source/owner linkage
  - parent patch present but allocated canary patch none
tags:
  - cloudbench
  - source-isolation
  - ownership
sources:
  - commit e23dcd094d6fbafa6dcc120a4f79c3acc6e57408
repro: python3 scripts/tests/deploy-test-cycle.test.py Round19ExactIsolation Round19InheritedAdmission
status: mitigated
---

## Problem

The original round19 standard isolation proof fails its canary source/owner
check. Ten parent controllers have the requested base plus patch, one allocated
canary has the base with no patch, and another canary has an authentic original
preallocation abort. The canary source mismatch remains a failure and cannot
be repaired by fabricating old provenance or describing all execution as the
requested source.

## Diagnosis

The actual standard candidate was rejected locally. All twelve local/canonical
native audit pairs and seven Hub records are preserved. Fresh read-only native
observations confirm the exact old/new excluded resources, stopped warm identity
and configuration, and the current Hub socket belongs to its exact native owner.
A six-entry ancestry includes ce/e92/round12/round14/round16 and round19. The
canonical cycle had not yet incorporated the round19 receipt while another gate
was active; combined native qualification therefore uses an explicitly labelled
in-memory projection, not a claimed canonical transition.

## Solution

An exact source/token/pin-bound investigator path validates each distinct
original provenance class, the original adapter-bound abort, all audits, outcomes
and debts. Reuse the existing current partition and local identity checks. The
new path returns only isolated future-validation authority with cleanup and
credit false. The normal validator continues to reject the original candidate.
The existing ancestry validator is parameterized for this exact sixth entry;
full clean-successor checks remain unchanged and apply to every original debt.
A complete native FAIL remains FAIL even when it proves execution cleanup.

## Validation and limits

Registered tests cover original pin/Hub omissions, unknown identities, active
resources, changed actors, six-debt closure and clean PASS/FAIL versus incomplete,
owned, cancelled, timed-out or tampered successors. The real immutable snapshot
and fresh read-only partition qualified with twelve participants and seven Hub
records. This never runs a cloud task, reconciles canonical state or releases
financial or native obligations. A new source requires fresh explicit proof
before admission; the saved observation is not future execution authority.

## Reusable lesson

Preserve actual source divergence as failed history while proving current
execution exclusion separately; do not rename that history to gain cleanup.

## Human feedback

Preserve genuine failures and every unpaid or unverified obligation. A
qualified isolated retry must not be reported as historical cleanup or a
passed deployment gate.
