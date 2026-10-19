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
  - commit 55de5e0b9ee5f0bf89b52b3c9c2445fd65f8aac3
  - fleet run original600-1792228733439245508
  - fleet run original600-1792263746104190724
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-unused-reservations.test.py
status: fixed
---

## Problem

Run70 closed with a mixture of claimed and untouched reserved Machines. The
normal next-run preparation rejected the entire request at the first claimed
row. Offering the original archive alongside the new archive also encountered
stale native ownership for IDs that had advanced to the new generation.

A later ordinary admission exposed another propagation gap. Run73's closed
request selected 551 of its original 553 candidates and retained three older
hold scopes. The unused-reservation reader returned all 551 candidates but
lost both omitted rows and every inherited scope when no recovered-admission
context was present. The next archive comparison then failed on superseded
native ownership.

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
untouched rows, and a changed current marker. Actual normal preparation on
`500babc9035912cbbdede1fa63b2d67ce960c7ac` then passed with 370 candidates
from the complete run70 evidence. Its request hash was
`0bf5e3d29b2c815c6331f69ee8cde016d7aa216a18e4b37d57513da69dce9e89`.
This fixes partition and lineage handling; the measured remaining organization
capacity gap is a separate admission requirement.

The ordinary-admission path must preserve the same partition contract as the
recovered path. Its selected and explicitly held IDs must exactly partition
the original candidates. Omitted rows retain their original Machine and
Volume identity and zero credit. Inherited scopes remain bound to their
original archive hashes, with no release or eligibility inferred from their
presence. This restores required exclusions without weakening the native
ownership comparison.

Historical hold scopes can outlive their archive's membership in the current
owner-archive list. The request builder deliberately preserves those liabilities
while rebuilding the current owner list. The ordinary reader must validate and
retain each hash-bound historical scope independently of that list. Run73's
seven-ID historical scope exposed this distinction during next-run preparation;
requiring its origin to remain a current owner archive rejected valid retained
history. The regression preserves that scope and rejects malformed origin
hashes or any claimed reuse credit.

## Human feedback

Keep fixes in the normal CLI. Never manufacture an unused-reservation proof,
clear a prior claim, or edit an archived request to make the next run start.

## Reusable lesson

Partition eligibility without relaxing evidence, and scope a generation's native
comparison to the archive that actually proves that generation.
