---
id: 2026-10-04-inert-worker-update-consumed-replacement-slot
date: 2026-10-04
title: Redundant inert worker update consumed an unavailable replacement slot
surface: harness
component: cloud-fleet-worker-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Worker staging updated an already inert native clone
symptoms:
  - Completed task retained fleet claims after worker staging failed
  - Missing not-yet-staged runtime helper blocked exact worker retirement
tags:
  - cloud-fleet
  - ownership
  - teardown
  - capacity
sources:
  - PR #1410
  - fleet run 20261004-201108-11163
repro: scripts/tests/benchmark-live-results.test.py
status: mitigated
---

## Problem

All fifty tasks reached evaluation, but one additional worker failed forty native
updates at the organization Machine limit. Its creation CMD was already inert.
The helper had never been uploaded or run; optional capture failed before exact
reaping, then retained all primary claims. The run earns zero credit.

## Diagnosis

Native configuration and owned staging records prove the first boundary. Archive
searches covered worker evidence, neutralization, cloning and Machine limits.
An unchanged actual-helper six-control reproduction was RED on the original
functions and GREEN after repair. Independent review additionally reproduced
starts/uploads after completion during inventory, missing prelaunch coverage for
a late clone, and a fresh create retry after task completion. These owning
controls retain their original failure evidence; no provider/model calls were
added. Actual native endpoints put all fifty tasks beyond the allocation cutoff.

## Solution

Verify the inert creation CMD instead of updating it. Clear BOOT in the explicit
wrapper. Preserve exact prelaunch owner/staging evidence before a late clone can
be reaped; launched or uncertain workers still require runtime capture. Fence
allocation retries and every staging command at task completion, reconcile any
already issued ambiguous create, and retain uncertain ownership. Completed tasks
stop future capacity demand; admitted resources still drain and release exactly.

The compact automatic deploy gate now covers cancellation, real capture failures,
missing volume ownership, failed reaping, native exec/entrypoint overrides and
safe versus ambiguous clone cancellation. Independent scoped review is clean;
fresh production fleet proof remains pending.

## Human feedback

The user accepts genuine task failure, wants warnings separated from resource
failures, and requires compact regression tests cemented in deploy.

## Reusable lesson

Do not let missing evidence from code that never launched prevent exact resource
release. Preserve concrete prelaunch ownership and stop new allocation when its
task has ended.
