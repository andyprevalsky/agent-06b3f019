---
id: 2026-10-20-finished-sharded-scorecard-missing-result
date: 2026-10-20
title: Finished recovered sharded runs displayed as running when result was absent
surface: infra
component: cloudbench-scorecard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: load_sharded ignored coordination.finished_at without result.json
symptoms:
  - "runners joined; operator writing result.json"
  - "RUNNING despite finished_at and verified controller exports"
tags:
  - scorecard
  - recovery
sources:
  - commit 390233e91
repro: scripts/tests/cloudbench-scorecard.test.py
status: fixed
---

## Problem

The original read-only shallow CLI on recovered Polar batch1 returned RUNNING
with coordination.finished_at=1792479435.9304206 and two verified controller
exports/releases. No final result.json exists. The existing None-name crash
was already fixed by f7f97b245, present in the integrated branch.

## Diagnosis

load_sharded assigned ended_at only when result.json was also present. The
finished-without-result branch merely changed text and retained RUNNING from
the empty experiment. Reproduced with the original receipts, and with the new
finished-shards regression: before repair RUNNING != INCOMPLETE. The exact
same regression and real CLI pass afterward. No original receipt was edited.

This is a distinct reader contract error: process termination and complete
result publication are separate facts. The existing reader's own lifecycle
and rows-source fields provide the reference; no external runtime pattern is
needed. Archive search for pidfd/missing-native-binding was unrelated; the
existing sharded e2e/host-death cases describe the upstream recovery context,
not this display bug.

## Solution

Always retain the producer finished_at for a finished coordination. Without
result.json mark the run INCOMPLETE, warn that the final result is absent, and
keep available rows exactly as observed. Verified exports/releases remain ok.
The regression asserts unchanged receipt bytes and retained incomplete live
counters, and scripts/test.sh registers the scorecard suite.

The real shallow output is still 10 PASS / 47 AGENT FAIL / 0 INFRA / 2 CANCELLED /
1 UNKNOWN. Those stale counters do not supersede the separately recorded CSV
10 PASS / 47 FAIL / 3 INFRA. Deep export reconciliation remains necessary for
canonical per-job outcomes and job-release audit. No outcome is inferred from
controller release. No paid rerun or agent review was performed. At 10k agents
this adds only constant-time state selection and no new reads or polling.

## Human feedback

Parent supplied the exact recovered-batch1 CLI and required preserving original
producer clocks/outcomes, without inventing or overwriting terminal receipts.
Parent asked to prioritize launch integration and report card observability gaps.

## Reusable lesson

Render a producer's terminal clock independently of result-publication completeness, retaining missing outcomes as explicit gaps.

## Render contract follow-up

Parent's real HTML inspection found KPI tiles led with pass/infra percentages,
not the required logical counts, and numeric launch rate was hidden during
warming. The existing owning scorecard suite reproduced both failures before
repair. The renderer now leads with QUEUED / IN_PROGRESS / COMPLETED and
then PASS / HARNESS FAILURE / INFRA FAILURE; agent failure, cancellation and
unknown counts remain separate. Numeric rate remains visible while warming.
The rate uses actual elapsed seconds instead of a synthetic one-minute floor;
zero elapsed time remains explicitly unmeasured. User instruction and
.claude/shared/report-display-format.md are the authoritative display contract.
Golden text fixtures and HTML-order, count, numeric-rate and zero-time tests
cover the repair. No receipt, outcome or producer timestamp is changed.
