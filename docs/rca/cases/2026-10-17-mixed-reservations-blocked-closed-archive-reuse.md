---
id: 2026-10-17-mixed-reservations-blocked-closed-archive-reuse
date: 2026-10-17
title: One claimed reservation blocked all untouched reservations in a closed run
surface: infra
component: cloudbench-unused-reservations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: unused reservation validation rejected the entire mixed request at its first claimed row
symptoms:
  - reservation was allocated or has unresolved claim intent
  - predecessor superseded by archived successor
tags:
  - cloudbench
  - archived-reuse
  - unused-reservations
sources:
  - commit 1fc5b729ced76dda398f997650b8ba5d08eb522b
  - fleet run original600-1792228733439245508
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-unused-reservations.test.py
status: open
---

## Problem

Run70 closed with a mixture of claimed and untouched reserved Machines. The
normal next-run preparation rejected the entire request at the first claimed
row. Offering the original archive alongside the new archive also encountered
stale native ownership for IDs that had advanced to the new generation.

## Diagnosis

The complete archive already distinguishes candidate IDs with allocation or
claim evidence. Treating a held row as a whole-request error made valid untouched
rows unavailable. Separately, the original archive's full historical evidence
was needed for untouched lineage, but its old native comparison did not describe
Machines now owned by the new closed archive.

## Solution

Keep complete archive and original request validation, then partition rows.
Claimed rows retain explicit zero-credit hold evidence. Every untouched row still
requires the original reservation, wire and native validation; validation failures
are not converted into holds.

The request builder suppresses a held ID's native comparison only in archives
whose exact hash differs from its closed claim archive. The matching archive
must pass ordinary current-native ownership checks independently. Original
archive contents and protection checks, explicit user exclusions, duplicate
resource rejection and exact untouched predecessor equality remain enforced.
No claim, Machine configuration or volume is changed during preparation.

Focused controls reproduce both the whole-request rejection and the stale
original-archive rejection. The fixed controls exercise mixed requests, changed
untouched rows, and a changed current marker. Actual next-run preparation is still
required before this case can be closed.

## Human feedback

Keep fixes in the normal CLI. Never manufacture an unused-reservation proof,
clear a prior claim, or edit an archived request to make the next run start.

## Reusable lesson

Partition eligibility without relaxing evidence, and scope a generation's native
comparison to the archive that actually proves that generation.
