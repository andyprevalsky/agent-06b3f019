---
id: 2026-11-08-run-size-fixture-used-retained-padding
date: 2026-11-08
title: Native run-size fixture inflated retained metadata instead of forensic logs
surface: harness
component: deploy-test-cycle-native-run-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/tests/deploy-test-cycle.test.py test_native_cloud_cleanup_binds_a_fleet_run_record_beyond_the_receipt_cap
symptoms:
  - native artifact: metadata document byte bound exceeded
  - proof file too large
tags:
  - native-cleanup
  - forensic-logs
  - test-fixture
sources:
  - PR #1708
  - commit 74311e0479c97a8ba770646fa83bf84ba5893081
  - commit 47646bab7fae928c35db89e0c20334adda1abee3
repro: python3 scripts/tests/deploy-test-cycle.test.py Cycle.test_native_cloud_cleanup_binds_a_fleet_run_record_beyond_the_receipt_cap
status: open
---

## Problem

Full34 completed this suite with 255 tests and four errors. This case owns only the run-record size error. The native log SHA-256 is 591572549f6e3617961e112205a2a8e9c1b6cb2b1b2a202490b6bb3c5f415afa; the copied original remains private and unmodified. The failing fixture used top-level padding larger than its reduced metadata limit.

## Diagnosis

Gate: INTRODUCED at integration: main6b505's exact test passes using its larger ordinary JSON reader, while merged74311 fails with the retained strict metadata/opaque reader. Prior02874 has no such test; its selector failure is explicitly not a behavior result. Its parser is byte-identical to74311. Both parser versions reject 4112-byte unknown metadata under4096, but accept a4684-byte native log document under the same metadata cap. The preserved128MiB raw allowance is independent.

The native TaskResult.logs field is a dictionary containing worker_logs arrays, serialized into tasks by BenchmarkRun.to_dict. Only tasks[*].logs and tasks[*].owned_roots[*].logs are designated opaque forensic paths. Unknown padding is intentionally retained metadata; bypassing its bound would weaken the contract. The archive case2026-11-07-native-cleanup-confused-forensic-run-with-receipt-size documents this distinction.

## Solution

Private proposal changes only the fixture payload from padding to a representative task logs.worker_logs array. Original reconciliation and raw-cap refusal assertions stay byte-for-byte unchanged. This exposes a diagnostic compatibility mismatch: the old negative expects proof file too large, while the new parser reports raw file byte bound exceeded. Append the legacy wording to that existing refusal message, preserving the exact raw guard and existing new-prefix tests. No parser behavior or bound changes.

The original native single case exits1 before and0 after. A separate registered NativeRunArtifact test fails before and passes after, preserving raw cap refusal, unknown-metadata rejection and unchanged bytes. All19 parser-class tests and two targeted cleanup cases pass. This is not a fullgate PASS or original99MB artifact proof. Parent integration and full34 continuation remain pending; status stays open.

## Human feedback

The delegated RCA scope required this single-case scope, preservation of original assertions and raw128/metadata64/memory64 limits, proof of a real opaque field, and no changes to the three independently assigned authority fixtures. No canonical source, worker, ledger, environment, database, service, provider or review was changed. No other private proposals were edited.

## Reusable lesson

Model large forensic run payloads with real opaque log fields while preserving separate retained-metadata limits and stable size-refusal diagnostics.
