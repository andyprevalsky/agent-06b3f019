---
id: 2026-11-09-native-cleanup-required-probe-success-for-release
date: 2026-11-09
title: Normal cleanup required a successful infrastructure probe instead of verified resource release
surface: harness
component: staged-deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: normal campaign validation required every linked canary lifecycle to be verified with exit0 even when a failed pre-task probe had complete native release seals
symptoms:
  - ordinary campaign-v1 refused the linked failed canary lifecycle
  - the original isolated operation could not renew through a failed successor without its strict normal cleanup certificate
tags:
  - deploy
  - cleanup
  - infra-canary
  - observation-loss
sources:
  - PR #1896
  - commit 3f15002fc6cfc1c8e8b48869653ef958a4e3486a
  - plan:.context/deploy-pr1896-continuation/cloud76-cleanup-readonly/report.json
  - plan:.context/deploy-pr1896-continuation/normal-failed-canary-candidate/handoff.json
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_normal_failed_canary_preserves_no_credit
status: open
---

## Problem

Eight parent controllers stopped after the first dependency canary failed.
A second linked probe was cancelled before allocating guests. All ten original
participants have matching native provider teardown seals and absent registries;
first-probe guests acknowledged cleanup, and neither probe produced a task root.
The native outcome remains failed, with eight outer UNVERIFIED and five SKIP.

Normal cleanup nevertheless required canary exit0. The existing isolated route
could recognize its pre-task release, but adding a second isolation obligation
would not satisfy the original operation's strict normal-successor renewal.
No participant, lifecycle, source pin or native outcome may be rewritten to
make that renewal admissible.

## Diagnosis

The normal consumer conflated probe success with release evidence. The compared
origin/main-to3f diff changes only the aggregate forensic byte allowance, not
this lifecycle predicate. Gate: NOT_INTRODUCED for that incremental comparison;
the deploy owner still owns the assigned cleanup repair.

Related archive searches covered failed-canary cleanup and shared dependency
sources. The July15 dependency mismatch case describes the upstream setup
failure; the October6 repeated-canary case describes a different scheduling
boundary. Neither supplies normal cleanup authority for this occurrence.

## Solution

Recognize a failed nonparent only in campaign-v1 with its exact native
infra-probe source/owner/parent linkage. Reuse the existing strict pre-task
release verifier: complete matching audit seals, absent registry, exact retired
resources, guest/runtime evidence present, no agent or owned roots, released
INFRA_ERROR projections and no inferred runtime success. Require current
controller/PID-group retirement. Zero-allocation missing provenance additionally
requires absence of every task-artifact class. Allocated probes retain full
provenance and task-matrix verification.

Then continue every ordinary provenance, native release and Hub custody check;
there is no isolated early return or new proof variant. Bounds, source maps,
renewal predicates, test definitions, timeouts and concurrency remain unchanged.
Existing isolated/quarantined-parent negatives still reject ordinary cleanup.

The identical normal-owning command fails on the old lifecycle predicate and
passes after repair. Three added tests cover positive no-credit release, zero
artifact absence and mode/source/guest/runtime/agent/status/live-process
negatives; all original test methods remain unchanged. The canonical full cycle
suite passes412 tests, and each new test passes five consecutive unchanged runs.
Independent exact-diff review cleared93da4665851fae6a1edd0a844311e79e37a818cf03d5b6e291a4eb3fff45a99d.

Parent read-only validation rehashed222 bound proof files and seven supplemental
custody files. Both exact native Hub owners satisfy the current retirement
observer without inventing the missing historical terminal sidecar. The normal
validator accepts all ten participants with credit_granted=false and no isolated
purpose. At this record, no live reconciliation, task PASS, financial release,
new-source gate or production acceptance is inferred from that pure replay.

Private proof and current observations are under
.context/deploy-pr1896-continuation/cloud76-normal-proof-prep and integrated-owning.

## Human feedback

The user requested completion of the deploy and explicitly skipped AgentCard.
The five payment overrides remain separate; this repair never changes their
original financial obligations or resumes historical roots.

## Reusable lesson

A failed probe can have complete resource release. Authenticate that exact
pre-task failure and complete custody independently of test credit; never
require PASS to explain a cleanup fact, and never use cleanup as task PASS.
