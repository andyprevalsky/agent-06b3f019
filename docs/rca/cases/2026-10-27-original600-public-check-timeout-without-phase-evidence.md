---
id: 2026-10-27-original600-public-check-timeout-without-phase-evidence
date: 2026-10-27
title: Original600 public read-only check exceeded its child deadline without retained phase evidence
surface: harness
component: original600-portable-operator
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Original disabled-policy child exceeded 10 seconds; active internal operation is unrecorded
symptoms:
  - "Portable.test_public_check_is_path_independent_read_only_and_creates_no_state"
  - "subprocess.TimeoutExpired disabled-policy child timed out after 10 seconds"
tags:
  - deploy
  - read-only-check
  - subprocess
  - observability
sources:
  - commit 46bfbfb5f3f33e273fefbbf0fc560cf9a3e00277
  - plan:.context/deploy-fresh-20261027/original600-portable-operator-batch2-failure.log
  - plan:.context/deploy-fresh-20261027/rca-original600-timeout/findings.json
repro: scripts/tests/original600-portable-operator.test.py::Portable.test_public_check_is_path_independent_read_only_and_creates_no_state
status: open
---

## Problem

At source46bfbfb5, the 82-test native structural suite timed out in the disabled-policy subprocess at line2068. Its temporary fixture was subsequently removed. The original ten-second guard and all read-only/no-state assertions remain unchanged.

## Diagnosis

Not established. Two correctly located focused native observations passed; disabled-policy children completed in2.164s and2.065s. The traced command performed173 subprocess launches including168 local Git reads. Eighty reads arose from duplicated per-shard catalog interpretation. This work is observed, but there is no evidence locating the original timeout within it. It must not be presented as a causal fix or host-load diagnosis.

## Solution

No repair is claimed. Scratch observers retain each native child's stdout/stderr, argv, duration, function/subprocess trace and an eight-second stack capture while retaining the original ten-second guard. The remaining proof is an actual failing native invocation with that phase evidence, followed by a justified correction and unchanged-command green. Details and source hashes are in REPORT.md and findings.json beside this draft.

## Coordinator constraints

Preserve the native command, all assertions, the ten-second deadline, path independence, read-only provider behavior and empty state directory. A baseline pass is not a repair. No shared source, archive/index or production mutation was authorized to this worker.


## Human feedback

No additional user feedback was recorded. The coordinator retained the original ten-second deadline and the unresolved classification; a later passing gate is not a causal repair of the missing original phase evidence.

## Reusable lesson

Retain child timeout streams and phase evidence before temporary fixture cleanup; an isolated green rerun cannot identify a lost slow operation.
