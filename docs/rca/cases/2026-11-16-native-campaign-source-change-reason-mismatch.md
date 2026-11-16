---
id: 2026-11-16-native-campaign-source-change-reason-mismatch
date: 2026-11-16
title: Native cleanup rejected the source-change reason emitted by its producer
surface: harness
component: staged-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: campaign-v1 root binding accepted an obsolete source-change reason but rejected the current producer reason
symptoms:
  - "native cleanup: campaign root binding"
  - "cloud command ran while the source changed"
tags:
  - deploy
  - campaign
  - cleanup
  - source-change
sources:
  - PR #2282
  - commit 60f72992887bab99109105cfc702054dae516df2
repro: scripts/tests/deploy-test-cycle.test.py
status: fixed
---

## Problem

Original504 smoke completed eight task grades and released resources after checkout advanced. Its adapter correctly withheld credit, recording `cloud command ran while the source changed`. Cleanup rejected that original reason. Token `f0c2474d4bed466597549807c9c60d2f` remains at `.context/deploy-pipeline/attempts/2/initial/smoke/`; all eight original outcomes remain UNVERIFIED.

## Diagnosis

The campaign-v1 missing-directory fallback accepted only the older reason `cloud command interrupted or source changed`. The current producer emits a different exact string, so root binding fails before native audits are read. This is a producer/consumer contract mismatch, distinct from the related November3 campaign-recovery case. Archive search occurred after repair, recorded in `/tmp/b82-preservation/stale-archive-search.txt`; no earlier search is claimed.

## Solution

PR #2282 accepts both known emitted reasons while rejecting unknown errors. The existing regression tests both values and proves original attempts/outcomes remain unchanged. Original code fails; repaired code passes in0.436s and five concurrent unchanged repetitions. The actual449-file proof passes all remaining guards for nine participants with credit false. Evidence: `/tmp/b82-preservation/stale-reason-packet.md` and `stale-reason-actual.txt`. Supported cleanup reconciliation subsequently recorded ownership retirement; the fix merged in PR #2282 as888b6e40bde0. The subsequent full current-source gates passed, including all eight smoke tasks with native cleanup. No historical outcome was promoted to PASS. OpenClaw broker/subreaper references preserve failed execution separately from retirement, but have no Rose-specific reason protocol.

## Human feedback

None recorded.

## Reusable lesson

Test the exact failure values emitted by each producer against the cleanup consumer without rewriting historical outcomes.
