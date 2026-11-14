---
id: 2026-11-09-github-liveness-quota-wait-starved-result-channel
date: 2026-11-09
title: github liveness quota wait starved result channel
surface: infra
component: deploy-test-github
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: advisory GitHub liveness quota wait blocked authoritative R2 polling
symptoms:
  - worker result identity/inventory mismatch
  - remote run existing gate deadline exhausted
tags:
  - deploy
  - native-evidence
sources:
  - PR #1881
  - commit ac528ddae20f5da7fb9069d4778f024315047bf5
repro: scripts/tests/deploy-test-github.test.py
status: fixed
---

# github liveness quota wait starved result channel

## Problem

PR1881 semantic-stack run 42675972754 completed 61/61 checks with cleanup at 18:59:08Z; the launcher emitted incomplete evidence at its 19:09:35Z deadline after a REST quota wait.

## Diagnosis

The synchronous advisory REST liveness query slept until the quota reset, consuming the remaining gate deadline without polling R2. The captured-boundary regression returned unfinished on old code (exit 1) and channel on the fix (exit 0). Original immutable Actions artifacts, request, source, token, recipe and cleanup were recovered and verified.

## Solution

Advisory liveness requests fail promptly on quota errors while normal REST operations retain bounded waiting. Add typed GitHub cleanup reconciliation bound to original receipts, Actions artifact digest, run/attempt/runner identities and launcher quiescence. It grants no execution credit and only permits fresh execution. Owning regressions cover valid proof and changed identity/evidence rejection. Included in PR #1881; production deployment remains the parent deploy's separate obligation. At 10k agents these coordinator-only changes add no per-agent query, subscription or shared runtime bottleneck.

## Human feedback

None recorded.

## Reusable lesson

Keep authoritative result polling active while an advisory control-plane request is rate limited.
