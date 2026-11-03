---
id: 2026-10-28-private-fixture-inherited-umask
date: 2026-10-28
title: Private structural fixture inherited the invoking service umask
surface: infra
component: cloudbench-controller-orphan-drain
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/tests/cloudbench-controller-orphan-drain.test.py:737 at 7c4ff6fe4 creates old_path with Path.write_bytes, inheriting umask instead of guaranteeing private mode"
symptoms:
  - "ValueError: private current-owner file required"
  - "ERROR: test_saved_positive_plan_parser_binds_old_raw_and_source"
  - "FAILED (errors=1) under umask 0022; OK under umask 0077"
tags:
  - cloudbench
  - file-permissions
  - umask
  - test-hermeticity
  - deploy-gates
sources:
  - PR #1627
  - commit 7c4ff6fe4
repro: scripts/tests/cloudbench-controller-orphan-drain.test.py NormalAgent.test_saved_positive_plan_parser_binds_old_raw_and_source
status: fixed
---

## Problem

The deploy-command-structural lane's cloudbench-controller-orphan-drain gate
failed its saved-positive-plan parser test with the private-file exception.
The transient service used UMask 0022; interactive shells used 0077. The
original lane stack is at .context/deploy-pipeline/logs/deploy-command-structural.log
around line 2604. This was a structural test failure, not a benchmark outcome.

## Diagnosis

Step 0: read the original lane stack and reproduced the failure locally.
Step 0.5 archive searches were `private current-owner file required` and
`fixture umask permissions structural`. The related case
2026-10-26-resume-export-read-checked-in-collector-as-private-input was read.
This is a relative rather than a recurrence: that case corrected a production
source-reader contract, while this source is deliberately a private copied
fixture artifact.

Critical path: service/shell umask -> fixture Path.write_bytes(old_source) ->
saved_positive_plan source pin -> original600-runner.read -> private stat
invariant -> unittest error -> structural gate failure. Other private receipt
writes already call chmod(0600). The old producer source was the first bad
boundary: write_bytes requests 0666, reduced to 0644 by 0022, while read()
requires mode & 0077 == 0. The reader's security contract is intentional and
remains unchanged.

Classification: test-bug. What: parser fixture errors under 0022. Where:
old_path creation at original fixture line 737. Why: ambient process state is
mistaken for the private artifact's invariant. Proof: saved original source
from commit 7c4ff6fe4 was run under 0022 and raised the same exception. Problem:
fixture-environment-data-mismatch. The next owned cause was the gate runner's
implicit inheritance of the invoker's umask; its child boundary is now explicit.
The deliberate private-reader policy is the ownership floor.

No shared checkout was reverted. The saved-source wrapper preserves the real
fixture __file__, ROOT and production reader path, while selecting the saved
original versus fixed source in orphan-subject.py. Exact identical command:

    (umask 022; /usr/bin/python3 /var/tmp/deploy-1627/rca/structural-umask-verification/repro.py NormalAgent.test_saved_positive_plan_parser_binds_old_raw_and_source)

Before: `ValueError: private current-owner file required`,
`Ran 1 test in 0.259s`, `FAILED (errors=1)`.
After: `Ran 1 test in 0.446s`, `OK`.
Evidence: before.log, after.log and orphan-before.py alongside the wrapper.

## Solution

The fixture creates old_path through os.open with O_CREAT|O_EXCL and mode
0600, then fchmods the owned descriptor to 0600 before writing. A module setup
forces every orphan fixture through 0022 and restores the inherited mask at
module teardown. The structural runner passes documented GATE_UMASK=0022 to
Popen. Its registered regression checks actual child umask and file modes from
callers using 0077 and 0000. No production reader, assertion, timeout, retry,
prompt, task or systemd service configuration changed.

The existing cloudbench-controller-orphan-drain gate and deploy-structural-runner
gate execute the tests through scripts/run-deploy-structural-gates.py, already
listed in deploy.md. On the final patch the orphan file passes 14 tests under
both 0022 and 0077. The runner umask test plus both registry/documentation tests
pass three tests under each mask. The selected actual registry gate also runs
all 14 tests and reports `All 1 deploy structural gates passed.` Focused original600
RunnerSelfTest, private status binding and inventory-reader cases each pass
under both masks. No full runner suite or full deploy was claimed.

The sibling audit inspected 13 direct original600/private-reader fixture files:
other private writer helpers already chmod(0600). Prior worker receipts at
/var/tmp/deploy-1627/rca/umask-audit/summary.txt record 19 additional cloudbench
gates passing under 0022. The original lane's independent portable-operator
failure is not claimed fixed here. No additional same-pattern defect was found.

Step 6a: keep one explicit creation path; no new fallback or error suppression.
Golden reference: not applicable (no approval-gated hunk).
10k-agent effect: no agent runtime path or per-agent cost changes.
Step 7: independent adversarial review passed, with before/after command and
observed timing corrected in the handoff. No backend/worker/stack restart.

## Human feedback

The coordinator required explicit fixture/gate umask behavior and an executed
0022 regression; relying on the systemd service UMask was forbidden. Existing
uncommitted work was preserved. This draft is outside the source checkout
because docs/rca is outside this worker's assigned ownership; the coordinator
must install it and reindex the shared archive.

## Reusable lesson

Create private fixture artifacts with explicit owner-only permissions and test their gate under a documented umask instead of inheriting the invoker's ambient state.
