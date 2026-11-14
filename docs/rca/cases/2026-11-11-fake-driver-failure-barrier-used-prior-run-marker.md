---
id: 2026-11-11-fake-driver-failure-barrier-used-prior-run-marker
date: 2026-11-11
title: Fake driver failure barrier accepted another invocation's autoscaler marker
surface: harness
component: cloudbench-multi-workstream-fixture
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run_fake_driver searched every retained run for autoscaler.failed without checking its run token
symptoms:
  - prior or foreign autoscaler.failed released the current run
  - cloudbench-multi-workstream.test.sh 0/5 1200s
  - transient destroy-failure CHILDFAIL followed by persistent destroy-failure PASS
tags:
  - fixture
  - isolation
  - autoscaler
  - run-token
sources:
  - PR #1881
  - commit 6ec73775eb17e051cb64c1d0153968596c2a94c9
  - task GitHub Actions 42956070487
repro: scripts/tests/cloudbench-fixture-process-cleanup.test.py
status: open
---

## Problem

The fake driver's destroy-failure barrier can complete immediately when an older run of the same benchmark left autoscaler.failed. The whole fixture intentionally keeps prior run directories between its transient and persistent destroy cases. reset_fake_state resets fake provider state, not workspace run history. A wildcard over all history is therefore not evidence that the current autoscaler failed.

This was found while investigating the assigned whole-unit1200-second failure. The actual6ec run still has0/5 and null exit for that unit; its aggregate is UNVERIFIED,30PASS2FAIL, complete=false, cleanup_complete=true. No claim is made that this separate fixture defect causes the entire timeout or that its correction makes the unit faster.

## Diagnosis

run_fake_driver already has current_task_output(), which resolves a benchmark output by matching runtime-evidence.owner.json run_token against the staged driver's token. Adjacent readiness barriers use it. The destroy-failure barrier instead uses a wildcard over all run directories and proceeds when any autoscaler.failed exists. This also accepts a foreign-token marker in a current-looking directory.

The narrow regression executes the actual extracted driver condition and existing output resolver against real temporary files. A prior marker is present, the current owner's marker is absent, and the unchanged source returns immediately. The assertion `prior or foreign autoscaler.failed released the current run` fails with exit1. The candidate reaches the original real0.1-second wait, then completes only after the test publishes the current token's marker. The test observes and delegates the real sleep rather than advancing time or reducing the original30-second deadline.

Old EAA captured controller logs show a transient destroy-failure CHILDFAIL and a subsequent persistent case PASS, but its finite653-copy manifest has no relevant autoscaler.failed or owner copies. The exact prior-marker state in that native run cannot be recovered from those captures. Its roughly14-second difference is not proven wasted time and cannot support a speedup claim. The local valid-input replay establishes the isolation defect independently.

## Solution

The external candidate replaces only the wildcard lookup with current_task_output() and checks autoscaler.failed in that resolved current output. It reuses the same run-token mechanism as neighboring barriers. The original30-second deadline, real polling delay, failure text, exit-code changes, provider refusal count, demanded capacity, cleanup assertions and all controller behavior remain unchanged.

The final unchanged owning regression fails original source and passes five candidate repetitions. Controls cover a stale prior marker, a foreign current-looking owner, absent current owner metadata, an already-present valid current marker, and an existing failed input status. Real marker publication releases the wait; older evidence remains untouched. The full existing cleanup suite and native f8 sleep ratchet pass. The first candidate harness omitted json from its extracted function globals; its error is preserved separately, and the final test explicitly surfaces thread exceptions instead of mislabeling them as barrier failures.

The patch is external and awaiting independent review/integration. The whole multi-workstream1200/five/eight acceptance remains assigned, UNKNOWN and blocking. This fix can increase legitimate waiting and grants no performance, test-gate, cleanup or financial credit. Code-only golden reference: the exact existing current_task_output resolver and adjacent token-bound readiness barriers.

## Human feedback

The parent required checking captured marker/token provenance first, preserving the capture gap, and then an assertion-first fake-driver correction using only the existing current-token helper. It prohibited timeout, retry, demand and controller changes and required keeping this correctness repair separate from any macro performance claim.

## Reusable lesson

Resolve a terminal fixture marker through the current invocation's existing identity authority, never by an unscoped search across retained history.
