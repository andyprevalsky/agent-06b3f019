---
id: 2026-11-16-stopped-inert-producer-pin-not-updated-after-direct-push-capture-change
date: 2026-11-16
title: Stopped-inert producer pin went stale when a direct-push merge changed the capture helper's host-side code
surface: harness
component: deploy-test-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/deploy_test_native_cleanup.py stopped-inert proof pins sha256 of the whole scripts/cloudbench-original-volume-capture.py (527af394…), which b55e854061 changed to 85363bbe… without re-pinning
symptoms:
  - native cleanup: stopped inert guest producer changed
  - native cleanup proof refused: native cleanup: stopped inert guest producer changed
  - deploy-command-structural deploy-test-cycle StoppedInertAllocationIsolation
tags:
  - deploy-gates
  - hash-pin
  - stopped-inert
  - cloudbench-capture
  - direct-push
sources:
  - commit b55e854061
  - commit 609cfca1fa
  - commit 670f0a3eb7
repro: scripts/tests/deploy-test-cycle.test.py
status: fixed
---

## Problem

On origin/main 50b7499b1d the `deploy-command-structural` gate failed in
`scripts/tests/deploy-test-cycle.test.py`. Running
`python3 deploy-test-cycle.test.py StoppedInertAllocationIsolation` (from `scripts/tests`, `agents/venv` active)
ran 3 tests and failed 2 of them (`FAILED (errors=2)`):
`test_inert_worker_admission_preserves_original_debt_and_exclusions` and
`test_large_primary_manifest_member_keeps_its_verified_size_on_final_rehash`. Both raised
`ValueError: native cleanup proof refused: native cleanup: stopped inert guest producer changed`
from `reconcile` in `scripts/deploy_test_native_cleanup.py`. This blocked every deploy gated on main
(#2289, #2285, #2282, #2262, #2288).

## Diagnosis

The stopped-inert native-cleanup proof (`scripts/deploy_test_native_cleanup.py`, the
`need(hashlib.sha256(helper).hexdigest() == ...)` check) pins the sha256 of the whole
`scripts/cloudbench-original-volume-capture.py`. It then extracts `BILLING_GUEST`, the guest-side
quiescence scanner, and binds that separately to the intent's `guest_code_sha256`. Commit b55e854061
("recover a delivered guest that exited before its backend started") changed only host-side
`undelivered_native_stop_record` (and its call in `local_identity`) to admit a `pre-backend-exit` native
stop. The file hash moved from 527af394… to 85363bbe…, but the pin was not updated. The `BILLING_GUEST`
literal is byte-identical before and after (AST-extracted sha256 5964de93…, 3841 chars). So the guarded
guest producer did not change: the pin is stale, not protecting anything.

Why was this possible? `python3 scripts/select_affected_tests.py --changed-file
scripts/cloudbench-original-volume-capture.py` does select `scripts/tests/deploy-test-cycle.test.py`
(deploy-structural-gates 122/154). The selector was correct. But b55e854061 reached main through
609cfca1fa, a local `merge:` commit pushed directly with no PR. The selected structural gate never ran
on the merged tree. The re-pin convention already exists: earlier "Re-pinned ..." comments above the check
for PR #1927, the PR1682 merge and PR #1990. Only the trigger to apply it was skipped.

## Solution

Commit 670f0a3eb7 re-pins the check to 85363bbebd490c8336e3c3c04e6c0361160904d2fd7d1371ebc18fc0e362c36b. It
adds a "Re-pinned for b55e854061 ..." comment recording that `BILLING_GUEST` is still byte-identical
and what changed on the host side. The existing `StoppedInertAllocationIsolation` tests in the
`deploy-test-cycle` structural gate are the regression: they failed before the fix and pass after it
(5/5 consecutive runs). The change is a constant in deploy tooling, so it has no 10k-agent runtime effect.
Sibling: branch `fix/stopped-guest-volume-attachment-list-proof` re-pins the same line for its own helper
version and must rebase its pin onto this one.
Open follow-up (not shipped here): the pin covers the whole helper file, so every host-side edit trips it again.
This is the fourth re-pin. Pinning the AST-extracted `BILLING_GUEST` hash (5964de93…) would guard exactly the guest
producer. That is a design change for its own reviewed PR. An independent sub-agent review reached the same first
bad boundary and intent verdict and found no other stale pin on the helper; the `ddde11af…` entry in
`cloudbench-prepare-source.test.py` is a fixed historical snapshot.

## Human feedback

The user's goal required confirming b55e854061's intent, verifying `BILLING_GUEST` byte-identity under the
existing re-pin comment convention, and leaving `fix/stopped-guest-volume-attachment-list-proof`
untouched.

## Reusable lesson

When "stopped inert guest producer changed" fires, compare the AST-extracted `BILLING_GUEST` across the
helper change: if it is byte-identical, re-pin with a dated "Re-pinned for <commit>" comment, and never
merge a change to `cloudbench-original-volume-capture.py` without running the selected deploy-test-cycle gate.
