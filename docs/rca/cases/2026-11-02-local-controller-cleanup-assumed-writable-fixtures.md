---
id: 2026-11-02-local-controller-cleanup-assumed-writable-fixtures
date: 2026-11-02
title: Local controller cleanup rejected successful fixtures with sealed audit directories
surface: harness
component: cloudbench-local-runner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-cloudbench-controller-local.py run_case called bare shutil.rmtree on quiescent owned fixture directories sealed to 0500
symptoms:
  - "[Errno 13] Permission denied: 'expected-fresh'"
  - '518 passed, 1028 deselected in 305.13s'
  - 'selected-pytest status UNVERIFIED after supervisor_exit 0'
tags:
  - cloudbench
  - cleanup
  - readonly
  - fixture
sources:
  - PR #1662
  - commit c13dc65fa03083ac6c4490f0c572ae21c439f8da
repro: scripts/tests/deploy-test-worker.test.py
status: open
---

## Problem

The full selected-pytest row on c13dc65fa reported 518 passed, 1028 deselected
in 305.13 seconds. Its supervisor recorded native_exit=0, quiescent=true,
orphaned_children=false and remaining=[]. The newly introduced local runner
then replaced its row with UNVERIFIED after shutil.rmtree raised PermissionError
for expected-fresh. This is a cleanup failure after test success, not a failed
assertion, process leak, provider outage or permission to fabricate PASS.

## Diagnosis

Gate: INTRODUCED. Compared baseline bf92cbd98ab436af20f9a8d647c32e748c67e93a,
where the local runner is absent, with frozen c13dc65fa03083ac6c4490f0c572ae21c439f8da.
The runner was introduced by 187ada565. Existing fleet audit code deliberately
seals both files and directories against writes; run_case assumed that every
successful fixture remained writable for generic shutil.rmtree.

Worker E's read-only metadata capture found retained fixture directories at
0500, UID1002, no foreign-owned entries and no child mounts. The root was0700.
The capture visited3962 directories and found115 symlinks; it did not follow
them or change their targets. Its SHA256 is
213637ce325ef87e6ff059393937f657e427a5e61851efa4f41f9b2371a0c1a0.
Deleting a child requires write permission on its parent, even when the child
is empty. Therefore removal of expected-fresh from its sealed audit parent
fails after all tests and supervised descendants have finished.

The executed private owning regression runs the actual run_case and unchanged
Linux supervisor. The child creates an audit with an empty expected-fresh,
seals both to0500, adds a0444 sibling evidence file and a symlink to outside
read-only evidence. On original c13 code, the unchanged PASS/deletion/outside
integrity assertion fails with the exact PermissionError expected-fresh,
native_exit0 and quiescent=true in0.103s. On the candidate it passes five
consecutive unchanged runs. The whole owning LocalController group plus four
new cleanup controls passes12/12 in5.954s. Commands, outputs and native receipts
are retained under /var/tmp/rca-c13-cleanup.

Archive searches were rmtree Permission denied read-only fixture and temporary
directory cleanup chmod owner symlink. No same-cause entry was identified;
this is a new runner cleanup defect, related to prior immutable-audit and
private-cleanup ownership cases. The foreign-UID guard test injects lstat
metadata; it does not claim privileged creation of another user's files.

## Solution

Private candidate only, pending parent integration and final gate validation.
After the existing native PASS and ECHILD/quiescence checks, open the private
root with O_NOFOLLOW/O_DIRECTORY and verify its original device/inode and UID.
Walk without following symlinks through directory descriptors, reject foreign
UID/device entries, and fchmod only owned directories to restore owner access.
Recheck the root identity before the existing descriptor-safe shutil.rmtree.
Do not chmod files or symlink targets. Failed, cancelled and unverified runs
retain fixtures. Refused or unsuccessful cleanup still produces UNVERIFIED.

The existing LocalController owning suite receives the failing regression and
controls for replaced/symlink roots, foreign-entry refusal and failed read-only
fixture retention. Existing cancellation and injected cleanup-refusal controls
also pass. No test definition, timing budget, concurrency or production audit
sealing rule changes. This is once-per-suite O(entries) teardown outside agent
runtime; it introduces no per-agent hot-path work at10000 agents.

Golden reference: not applicable; no approval-gated harness hunk. No application
source, full gate, provider operation, credentials or Freedom change was made
by this investigator. Parent retains source/deployment ownership. Preserve the
original native row and audit evidence until normal owner retirement.

## Human feedback

The parent required a private narrow proof and exact patch within8minutes,
with ECHILD and root-inode guards, foreign/symlink preservation, failure and
cancellation retention, and no cleanup-refusal-to-PASS conversion. No broader
source or gate work was authorized to this investigator.

## Reusable lesson

Restore only validated owned-directory access after supervised quiescence before removing immutable test fixtures, while preserving every failed or refused cleanup as unverified.
