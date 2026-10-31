---
id: 2026-10-31-r137-extracted-recovery-fixture-dependencies
date: 2026-10-31
title: Extracted recovery fixtures omitted current production helper dependencies
surface: harness
component: cloudbench-dependency-sync-tests
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Test shells invoked recovery and reaper callers without extracting their required current helper functions
symptoms:
  - The registered gate failed with command not found in unchanged recovery fixtures
  - The first startup archive case could not reach its intended evidence checks
  - Retirement and guest cleanup latch cases failed on the same omitted dependencies
tags:
  - r137
  - test-fixture
  - recovery
sources:
  - commit 618430e2a32e619406cb24fb537e2f6e2fe291e7
  - task R137 registered benchmark-live-results gate after R134 integration
repro: Run the unchanged startup archive and representative retirement fixtures against their exact production fleet source
status: open
---

## Problem

After R134 integration, the registered benchmark-live-results gate was stopped
with 27 failures, 247 passes and 1269 deselected tests. It did not pass. All 27
reported failures were in the unchanged dependency-sync test module. A separate
pytest cache contained historical failures and was excluded from this diagnosis.
No benchmark result or resource-release status is changed by this case.

## Diagnosis

The exact production fleet source contained the R122 replacement-member guards,
but the tests assembled shell fragments without those required functions. Six
representative cases independently failed on missing phase/reaper helpers;
the bounded-retirement case also omitted the current-disposable predicate.
The original startup archive case reproduced the reported environment line747
failure: fleet_recovery_confirm_replaced_preconfig was not defined.

Once those real dependencies were present, the startup fixture also lacked the
common directory and process-birth inputs required by the existing diagnostic
dispatcher. Its old ownership directory did not match the canonical namespace.
This fixture has 50 tasks, so with correct inputs the real dispatcher declines
the single-primary diagnostic branch and retains ordinary archive validation.
It must not be replaced with a successful guard stub.

Archive searches found the earlier helper-extraction and native-inventory fixture
cases (2026-07-21 and 2026-10-02). Their solutions require actual helper bodies
and complete caller inputs, rather than no-op admission or timeout changes.
R137 is another occurrence at the newer replacement-member and dispatcher seam.

## Solution

Frozen test-only patch
3eb742e7244691e6d06a4503173cc505c913e8f1d8a29b3f163b8f8ef5acab0f
adds the specific actual helper dependencies to the existing extraction utility.
It supplies the startup fixture's canonical ownership path, common directory and
actual shell process birth. Three additional adjacent cases also failed on
baseline. Their fixtures now include actual bounded native-read and lock-release
helpers, the canonical forensic namespace, and current snapshot/identity inputs.
The reconnect fixture supplies the existing prestart inventory read while
retaining exact-Machine, neighbor-exclusion and authenticated-shutdown assertions.
Its former blanket no-list assertion is replaced by exactly one read, matching
the current controller contract. No production helper, ownership rule, native check, unsafe-owner refusal,
timeout, benchmark criterion or cleanup behavior changes.
Independent review and integration remain pending at this writing.

## Validation

The same original startup case fails before the correction. All eight startup
variants pass afterward, including wrong-owner, accepted-executor, unconfirmed
cleanup, missing-worker, changed-config, changed-source and guest-run-record
refusals. The retirement/reaper/latch selection passes 49 cases, and the existing
extraction identity control passes. The final combined run passes 69 distinct cases in 56.99 seconds: the requested
58 and adjacent 16 have five overlaps. Collection verifies that every one of
the 27 interrupted-gate failures is included, with related adverse cases.
All three additional adjacent cases also failed on the unchanged baseline.
Diff checking and Python compilation pass. This is not a full registered-gate
pass; that gate still requires a completed rerun after qualification.

The source-bound bootstrap fixture used a disposable local Git repository built
from supplied source bytes, because its normal test machinery reads committed
blobs. Those local commits are not historical 618430 ancestry. Initial attempts
missing package source operands were excluded from the causal RED evidence.
No native or provider operation was performed.

## Human feedback

None specific to this test-harness correction was recorded.

## Reusable lesson

Tests that extract production functions must carry the current dependency closure
and real identity inputs. Otherwise a negative may pass for an unintended missing
command, while positive controls never reach the behavior they are meant to test.
