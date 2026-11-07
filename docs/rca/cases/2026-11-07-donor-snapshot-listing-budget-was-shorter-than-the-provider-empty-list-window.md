---
id: 2026-11-07-donor-snapshot-listing-budget-was-shorter-than-the-provider-empty-list-window
date: 2026-11-07
title: A smoke controller exhausted its 45 s donor snapshot read budget inside a provider window that answers a valid empty list, and the campaign infra stop cancelled the other eight
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: scripts/run-bench-fleet read the donor volume's snapshot list at most 6 times over 45 s and treated the last valid but empty list as "No complete snapshot"; Fly's snapshot listing answered an empty list for minutes
symptoms:
  - "No complete snapshot for warm volume vol_vwnym366kn7k8mmv. Create one and wait for it to finish"
  - "INFRA STOP: 1/9 scheduled jobs are confirmed infrastructure failures (>= 5%); breach at r001-j0002 (INFRA_ERROR)"
  - all 9 smoke cases UNVERIFIED with a native cleanup owner the staged cycle could not reconcile
tags:
  - cloudbench
  - smoke
  - fly
  - retry-budget
sources:
  - PR #1744
repro: scripts/tests/cloudbench-env.test.sh runs the extracted list_donor_snapshots against a stubbed provider (5 empty lists then a snapshot, 3 invalid replies then a snapshot, endless empty and endless invalid lists); the provider behaviour itself was reproduced at 07:05Z with the identical flyctl command, 8 of 9 concurrent reads and 3 of 4 sequential reads returning exit 0 and `[]` in about 0.7 s
status: fixed
---

## Problem

During the first staged smoke on this branch, one of nine concurrent controllers (chat-mode) failed before any guest was
forked while eight siblings resolved the same recorded snapshot in the same seconds. The campaign's stop rule (one infra failure of
nine scheduled jobs) then terminated the other eight, leaving every case UNVERIFIED. Gate: NOT_INTRODUCED for the changed
product code; the controller's read budget is the defect.

## Diagnosis

The listing command returned a valid empty list intermittently for a few minutes (never an error), which the controller's existing
guard ("a valid empty list is not proof of no snapshot") retried only six times with 3 to 15 s pauses. After 07:07Z 28 of 28 reads
were healthy again, so a longer budget outlasts the window. Nothing was allocated or leaked on Fly.

## Solution

The read is now `list_donor_snapshots`: up to 12 reads with 5 s steps capped at 30 s plus up to 3 s of jitter (about four
minutes), the same completed-snapshot selector, the same fail-closed messages, and the failure text now states how many reads were
made and how many snapshots the last valid read held. A stubbed-provider regression executes the real function. The refactor also moved the loop out of the block that the
private-source fixture in `cloudbench_dependency_sync_test.py` replays by extraction, so `test_private_fleet_source_keeps_shared_default`
failed with `list_donor_snapshots: command not found` (INTRODUCED by this change, caught by the agents `benchmark` domain); the
fixture now extracts the helper as well.

## Human feedback

The deploy coordinator named the retry-budget gap as the likely cause of a repeat smoke failure under contention.

## Reusable lesson

A retry guard for a provider that can answer "valid but empty" must be sized to the observed length of the degraded window, and a
single-job infra stop makes a short budget a whole-campaign failure.
