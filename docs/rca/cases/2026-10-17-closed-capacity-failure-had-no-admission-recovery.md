---
id: 2026-10-17-closed-capacity-failure-had-no-admission-recovery
date: 2026-10-17
title: Closed capacity failure could not use the existing admission recovery path
surface: infra
component: original600-reservation-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the incomplete admission reader accepts its historical ENOSPC case but not a fully joined capacity-shortfall admission with closed reservation and observation records
symptoms:
  - fresh capacity after reserved native readback is insufficient
  - no controller or task launched
tags:
  - cloudbench
  - admission
  - recovery
sources:
  - commit 49b792dcc2ea983325c6a25801da6c982f29c206
  - fleet run original600-1792271666901142356
repro: python3 scripts/tests/cloudbench-incomplete-reservations.test.py
status: open
---

## Problem

Original74 completed its initial reservation pass with 501 confirmed and 50 held rows. The existing positive-ACK observer recovered 27 more, yielding 528 confirmed and 23 held. The fresh organization snapshot allowed 51 new objects but the original600 request required 73. The capacity guard correctly refused to create a controller. The public recovery path accepted an earlier unclosed ENOSPC journal shape and could not consume this closed capacity-shortfall shape.

## Diagnosis

The retained 533-member packet is SHA256 7fd4d2d31601c0e74499cfabf48e0c47cc704bc95d51a239ecd7d39ac369e410. All 530 mapped original files were verified. Eleven failures happened during the first leased GET: no config POST or config-dispatch artifact exists. Twelve have one uncertain config request, eleven recorded HTTP499 responses and one missing response. Their saved native versions/configurations match the prior state. None of those facts alone grants current capacity credit or proves the uncertain requests had no effect.

The provider/network causes of the read failures and uncertain responses remain unproven. This change addresses the missing recovery state, not those upstream causes. Original errors, old requests, old observation records, and the 90-minute admission clock must remain unchanged.

## Solution

Extend the existing incomplete-admission mechanism with an exact closed-capacity-failure proof. Carry the 528 confirmed rows unchanged. Classify only the 23 held IDs. Any new configuration attempt uses a new private journal and a fresh lease, verifies the exact prior native version/configuration, and performs a version-fenced update. A competing late old update must make the new attempt fail or remain held. No old configuration request is replayed with its old nonce, and no uncertain old response is relabeled as an ACK.

The normal fresh capacity check and controller launch remain after verified recovery. The original task set, concurrency, deadlines, exclusions and protected resources remain unchanged. Seven incomplete-admission controls, five recovered-reader controls, and the focused public-CLI continuation control pass. The same valid capacity-failure fixture is rejected by the old public planner and accepted by the new planner. Controls also reject altered carried rows and late old-CAS winners, and validate the full recovered archive and dependency bindings. These are local controls; the live continuation has not run yet.

## Human feedback

The user asked to simplify startup and explain the repeated failure to reach full parallel execution. Preserve all 600 tasks and original timing limits while making this recovery an explicit state of the existing admission path.

## Reusable lesson

A closed partial admission needs an explicit state transition into the same recovery mechanism. Preserve the old operation history while obtaining fresh proof for any newly credited state.
