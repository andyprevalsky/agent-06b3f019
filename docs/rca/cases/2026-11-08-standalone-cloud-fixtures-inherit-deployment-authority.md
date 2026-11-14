---
id: 2026-11-08-standalone-cloud-fixtures-inherit-deployment-authority
date: 2026-11-08
title: Standalone cloud fixtures inherited deployment custody and width
surface: harness
component: deploy-test-worker-fixtures
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Standalone fake request was interpreted under an inherited real DEPLOY_GATE_REQUEST; independent headroom fixture inherited DEPLOY_CLOUD_CONCURRENCY4
symptoms:
  - "historical custody: missing request-owned custody locator"
  - "AssertionError: 16 != 4"
  - "AssertionError: 11 != 4"
  - "AssertionError: 7 != 4"
tags:
  - fixture
  - environment
  - custody
  - capacity
sources:
  - commit 74311e0479c97a8ba770646fa83bf84ba5893081
  - commit 6b505755463d2ef066abdf50978f25616659da02
  - commit 02874c560cb858502e2576780fd2712aaf511045
  - plan:.context/rca-browser-4f77/structural-worker-rca-2141/report.md
repro: scripts/tests/deploy-test-worker.test.py Cloud CloudCampaign CloudSharedProviderHeadroom
status: open
---

## Problem

Original unit156 tests ended9FAIL/7ERROR. Thirteen failures are a standalone fake request inheriting the real deploy authority path; three are fake account-headroom expectations inheriting the real campaign width4.

## Diagnosis

Frozen743 reproduces all16. Removing only each ambient input removes only its cluster; both removed pass36 unchanged methods.02874 passes23 existing cloud methods under the same environment. Incoming6b505 reproduces six custody errors and lacks the restored width cap behavior. See private exact command/exits and source comparisons. Archive searches used literal custody error and ambient fixture/DEPLOY_GATE_REQUEST behavior; the October15 credential scope and October30 sharded fixture cases are relatives, not causal substitutes.

## Solution

Private proposed fixture setup isolation only; retain parent environment restoration and all156 original test bodies. Two added permanent methods poison parent inputs, invoke original native tests and verify restoration; explicit inner width4 remains enforced. Parent integration, review disposition and full native gate acceptance remain pending. No source patch applied by this child.

## Human feedback

Keep original real cloud width4, caps56/140, all tasks/assertions/budgets and live workers unchanged. No sixth automated review or override. Prefer environment-only repair only when supported by the actual normal runner contract; otherwise prepare private source patch and report the consequence.

## Reusable lesson

Isolate standalone fixture authority and capacity inputs within restoring test setup while preserving explicit production guard and limit tests.

## November 10 recurrence: opted-in Kernel custody in offline layout fixtures

PR1910's full deployment enabled the required Kernel allocation guard in its
real worker environment. Three offline worker-layout assertions inherited that
policy even though their fixture expectations describe the default, unselected
layout. The same commands reproduce two failures in `deploy-gates.test.py` and
one in `deploy-test-github.test.py` with custody enabled.

The offline fixture setup now explicitly selects its default policy and clears
the inherited Node preload within the restoring environment patch. Production
worker environments and the guard remain unchanged. The three original
assertions pass, as does the unchanged positive control that explicitly enables
custody and loads the guard in a real Node child. Full deployment qualification
remains separate. Evidence: the original PR1910 deployment gate receipts and
`.context/rca-3a0-hermetic-tests/report.json`.

## November 10 recurrence: three extracted fixtures omitted controller dependencies

The full controller log for frozen `5690b07270b16e82c1cf024207a915be9c2925cc`
records **3 failed, 516 passed** in the same 519-case selection that previously
recorded **9 failed, 510 passed** on
`3a0e4877008c337f1ab345c74cf6225305f54935`. Reading both complete failure lists
confirmed that the current three were already among the original nine; the six
prior release/projection failures no longer occurred. The worker recipe and
selected runner source were unchanged. This is another fixture-bootstrap
recurrence, not evidence of a native Source lease or provider cleanup defect.

- `test_migrated_registry_reaps_seals_audit_and_retires_lock_directory[0]`
  and `[143]` extracted the real cleanup function without its new
  `finish_private_source_lease` dependency. The missing command changed cleanup
  status to 1 instead of preserving 0 or 143. The repair extracts the actual
  helper and retains its ordinary no-holder branch.
- `test_autoscaled_worker_failure_publishes_durable_failure_marker` omitted
  the five ordinary private-source capture defaults used by the real worker
  wrapper. Its first storage-mode failure masked a second missing input,
  `EXECUTION_PROVENANCE_FILE`, in the upload modes. The repair initializes the
  ordinary defaults and uses the existing real `_make_execution_provenance`
  constructor; it adds no permission stub or empty provenance substitute.

**Gate: INTRODUCED.** The unchanged four-case reproduction passed on baseline
`8046dcbc3a67e7d4241d8eb6171b5c1652b85f71` (4 PASS, 4.29s), failed on frozen
5690 (3 FAIL/1 PASS, 3.48s), and passed with ignored candidate `717e6260`
(4 PASS, 7.45s). This includes the migration's no-cleanup control and every one
of the worker fixture's eight storage/upload/readiness modes. All original
assertions, test names and timeout expressions remain identical. Root's
independent source review cleared patch `334c42cf` before its application as a
quiescent batch; this focused proof does not grant a full native gate pass.

Evidence: `.context/rca-5690-three-fixtures/report.json`,
`current-native-failures.json`, `candidate-seals.json`, and
`root-independent-review.json` in that directory. The complete current remote
log has SHA256 `c84fd1103ec11e377821dfa5e7b67d08a5052b5a337fa9413f888ac529e2fe84`;
the report retains its exact path and the baseline, failed and candidate logs.
