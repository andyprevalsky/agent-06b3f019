---
id: 2026-10-06-merged-admission-wait-overrides-left-retry-assertion-stale
date: 2026-10-06
title: Two independent admission-wait bounds merged into one command and left the retry assertion stale
surface: harness
component: cloudbench-multi-workstream
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/tests/cloudbench-multi-workstream.test.sh scenario 4 set CLOUDBENCH_CAPACITY_ADMISSION_WAIT_SECONDS twice after a clean auto-merge; the later 10 won while the assertion expected 1s"
symptoms:
  - "FAIL: a governor denial is retryable and must exhaust the admission wait before failing"
  - "capacity is reserved by live work; retrying provider admission in 1s"
tags:
  - cloudbench
  - merge
  - capacity-governor
  - deploy-gate
sources:
  - PR #1416
  - commit eaaa6d28f
  - commit 795cb6773
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

During the PR #1416 Test Loop rerun after merging `origin/main`, Step 4cb's
`cloudbench-multi-workstream.test.sh` failed scenario 4. The controller
rejected the over-ceiling burst with the expected unit counts, but the retry
assertion could not find `capacity admission remained blocked for 1s`.

## Diagnosis

Both branches had bounded the same scenario's 300-second default wait
independently. The PR's `eaaa6d28f` added a 1-second wait and retry plus an
assertion on the 1-second exhaustion message. Main's `795cb6773` added a
10-second wait with a 1-second retry. The edits sat on neighboring lines, so
Git merged them without a conflict. The command then assigned the wait
variable twice; shell assignment order made the later value of 10 effective.
The controller printed `remained blocked for 10s`, which the PR's assertion
did not match. The fleet controller itself behaved correctly.

## Solution

The scenario keeps main's single 10-second wait and 1-second retry. The
duplicate assignment is gone, and the retry-path assertion now checks the
effective 10-second exhaustion message. The gate stays in Step 4cb.

## Human feedback

None; this was found while rerunning the `/deploy` Test Loop for PR #1416.

## Reusable lesson

After a clean auto-merge, inspect files both sides changed for duplicate
assignments; a conflict-free merge can still combine two fixes inconsistently.
