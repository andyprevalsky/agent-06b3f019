---
id: 2026-10-17-closed-parked-claims-needed-new-admission-proof
date: 2026-10-17
title: Closed parked claims required a distinct proof for new admission
surface: infra
component: cloudbench-parked-reservations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: closed claim attempts had no eligible archived ownership or unused-reservation path
symptoms:
  - 370 eligible retained Machines
  - 52 available organization slots
  - 179 additional retained Machines required
tags:
  - cloudbench
  - parked-claims
  - admission
sources:
  - commit 500babc9035912cbbdede1fa63b2d67ce960c7ac
  - fleet run original600-1792228733439245508
  - agent 01a137e6-c4c8-7691-a3dd-52540286a46c
repro: scripts/tests/cloudbench-parked-reservations.test.py
status: open
---

## Problem

After run70 closed, the normal preparation verified 370 reusable Machines.
The canonical organization read counted 948 of 1000 available objects, leaving
52 creation slots. A 600-task controller needs 601 total slots, so the next run
required another 179 reusable Machines. Unpublished claim attempts remained
excluded even when their Machines were stopped and their complete history was
available. The original exclusions correctly avoided assuming a missing
publication meant that no native write occurred.

## Diagnosis

A claim can stop before a config update or after its successful native
acknowledgment but before local publication. These are distinct from an unknown
config write and from a completed archived task owner. The original late
observation and timeout outcomes must remain failures. A later closed-run
admission needs its own explicit ownership and current-state proof.

## Solution

Add an explicit parked-reservation input mode. Preserve original request,
reservation, source-exclusion and complete archive evidence. Recompute the
original task and generation binding and qualify only supported parked states.
Unknown writes and conflicting later ownership stay held. Every candidate
retains its prior liabilities and receives no reservation credit from this
read-only preparation. The existing fresh native lease and version-checked
reservation must grant new capacity for the new run.

This case remains open until the actual saved archive passes the new proof
validator and normal fresh admission succeeds.

## Human feedback

Keep recovery in the published CLI, preserve the original clocks and data,
and never clear an unknown intent or infer old task success to meet capacity.

## Reusable lesson

Prove eligibility for a new generation without changing the historical outcome
or replaying an old effect.
