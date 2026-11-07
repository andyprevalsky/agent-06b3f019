---
id: 2026-11-07-cloud-cleanup-merge-omitted-sealed-source-argument
date: 2026-11-07
title: Cloud cleanup merge omitted sealed source binding and adapter fixture dependencies
surface: harness
component: deploy-test-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_native_cleanup.py preallocation isolated_canary_release call omitted the retained source_binding argument
symptoms:
  - "TypeError: isolated_canary_release() missing 1 required positional argument: 'source_binding'"
  - "NameError: name 'prepare_source_transport' is not defined"
tags:
  - deploy
  - merge-integration
  - sealed-source
  - fixture-extraction
sources:
  - commit 0ddc00c032afdd9c72343b52801fb5ac9a40d58f
  - plan: .context/cli-nov07-controller-failure/resume-1628-independent-review.json
  - plan: .context/cli-nov07-controller-failure/resume-1629-focused-merge.log
repro: python3 scripts/tests/deploy-test-cycle.test.py CloudSealedCanaryTransport Round19ExactIsolation Round19InheritedAdmission GenericNativeInheritedAdmission RelayStartupEvidence
status: open
---

## Problem

The isolated complete-source merge retained the branch's eleven-argument sealed
source validator and upstream's new preallocation call site, but the latter
still supplied ten arguments. Two positive cases errored and three negative
subcases stopped at the argument error instead of their intended proof checks.
The extracted adapter supervision fixture omitted the retained source-transport
helpers and failed before checking native owned supervision or Hub joining.

## Diagnosis

Gate: INTRODUCED by the merge integration, bounded to these two call boundaries.
The parent focused log and an identical local command on unchanged 0ddc both
reported 32 tests with three errors and three failing subcases. The neighboring
failed-canary call already passed the existing source_base/source_patch/adapter
tuple. The upstream fixture extracted execute alone, while the retained execute
requires prelaunch source sealing and post-command preallocation capture.
No provider outcome, historical cleanup or financial settlement was established.

Archive searches used the raw missing-argument symptom and the extracted-execute
source-helper behavior. This is a relative of the helper extraction failure in
2026-07-21-helper-moved-out-of-run-sh-broke-extraction-tests, not evidence that a
historical provider incident has been resolved.

## Solution

Pass the existing verified source binding tuple to the new preallocation call,
with no signature default or rejection fallback. Exercise the actual source
transport helpers in the supervision fixture using a temporary Git repository,
an explicitly offline origin advertisement and the real full-workspace patch
producer. Keep native dispatch and result collection synthetic. Assert that the
actual emitted source seal and complete patch digest reach the launch environment,
in addition to the original owned_lifecycle and native Hub join assertions.

The unchanged 32-test command is red before and green after. The existing five
StartupCleanup tests also pass, followed by the complete owning cycle suite.
Exact logs, durations and final counts are retained in .context/resume-1630 in
the isolated preparation clone and the parent handoff report. Original assertions,
deadlines and cleanup/source proof requirements remain intact. This case stays
OPEN until parent combined-source review and required native validation finish.

## Human feedback

The user required the exact original focused command, the original StartupCleanup
family and the full owning suite, with no fake production proof, weakened
signature, catch/fallback, provider actions or canonical writes. Independent review
identified the two missing dependencies; it was not human review or release credit.

## Reusable lesson

A text-clean integration does not compose a newly added call site or extracted
fixture with a retained stronger dependency contract. Exercise both original
producer families and actual source-seal helpers before accepting the merge.
