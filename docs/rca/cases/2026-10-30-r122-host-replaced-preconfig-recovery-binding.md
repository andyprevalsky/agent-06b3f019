---
id: 2026-10-30-r122-host-replaced-preconfig-recovery-binding
date: 2026-10-30
title: Exact recovery omitted the retained preconfiguration primary after host replacement
surface: infra
component: cloudbench-exact-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The recovery planner scanned direct task outputs while host replacement retained the old primary under a nested output
symptoms:
  - incomplete stale-owner hierarchical output mapping
  - exact stale-owner guest recovery mapping is unsafe
  - boot-config-host-replaced
  - runtime-evidence-unconfirmed
tags:
  - r122
  - it28
  - recovery
  - host-replacement
  - preconfiguration
sources:
  - commit d0663f361a1118ce6776d1ab8aaa0987dcf252a5
  - fleet run campaign-20261030-183518-1679503
  - agent ph7eq6ca0cp3vnxvh8qh26c4ts8h5bmt
repro: scripts/tests/cloudbench-replaced-preconfig.test.py
status: fixed
---

## Problem

Five of It28's twelve retained owners could not enter canonical recovery.
The exact baseline planner returned `incomplete stale-owner hierarchical
output mapping`. Seven single-primary owners passed the planner; that was
mapping proof only, not operational readiness. Original It28 results remain
**1 PASS, 1 FAIL, 18 CANCELLED**. This case fixes a recovery boundary, not the
original benchmark failures or the initiating provider fault.

| Job | Retained old primary | Current primary |
| --- | --- | --- |
| r001-j0006 | e826322ad17048 | d8d2e4db40dd18 |
| r001-j0008 | 844925ce312928 | 812d66a95e33d8 |
| r001-j0009 | 8ed952dc493008 | 854d0dc4140098 |
| r002-j0014 | 080022da779328 | 801650b6234568 |
| r002-j0015 | 185514da977148 | d8d0797c332338 |

## Diagnosis

The host-replacement producer preserved each old `.cid` and runtime ownership
under `<task>/host-replaced-<old-id>/`, while retaining both Machines and volumes
in the same owner registry. The recovery planner visited only immediate run
children, mapped the current primary, then correctly refused the unmatched
registered old primary. Each original old output has exit 125, matching
`boot-config-unapplied` and `boot-config-host-unresponsive` markers, and retained
runtime pending ownership. No old status-proxy port or accepted-start marker
was recorded. These local observations do **not** prove that a timed-out update
never applied; current native inert-state proof remains mandatory.

Original control archive SHA256
`ba3cca9ba6d3e79dda3ccc718852c50e5cff04053bc7cdba26b4442fa80c0d74`
was checked against its index: 1,858 regular members and all twelve before-pin
sets matched. The four critical helper hashes matched the supplied execution
source, including fleet helper `f7888e22e75b8079040e790e1c38f7112bd10104e3714b0642a7d235d69b1098`.
The original five layouts reproduced the refusal in scratch with filesystem
prefixes relocated only; neither original files nor native resources changed.

Two archive searches covered `host-replaced`/the exact planner error and
`preconfig`/nested recovery outputs. The October 26 host-replacement case
explains the producer; the September 29 missing-proxy case explains a related
mapping constraint. Neither establishes this mixed old/current recovery proof.

## Solution

Qualified patch SHA256
`343c9a62bab85cb3017d1c79ee5d8ffcbc17512aa64e463e8db3d4751bc71f4f`
on the recorded base adds a typed old-member phase. It binds the logical task,
ordinal, old/current IDs, parent replacement marker, source, volume, audit
indexes and runtime ownership. It rejects contradictory worker allocation and
noncanonical paths. Existing preconfiguration archive/native verification
requires matching before/after reads of the original inert configuration and
mounted volume. Only then can a durable phase anchor precede consumption of
that old member's pending marker. No old ACK or proxy port is manufactured.

The current primary still follows normal guest ACK and normal-seven evidence
validation. An already-ACKed current guest cannot skip an unproved old phase.
Whole mapping/member proof is rechecked before aggregate latch closure and
both present/absent native reaper branches. Native mutation retains its existing
identity, volume and ownership guards. Receipts remain zero-credit, with
`runtime_evidence_complete: false` and `native_release_verified: false`.

Independent review rejected V1 for imposing failed-owner proof on ordinary
successful replacement cleanup and accepting a nonempty nested old worker
ledger. V2 scopes ordinary-path checks to an entered phase (anchor or surviving
receipt), preserves normal-success behavior, and rejects the old ledger both
live and in archived replay. Those are technical review findings, not human
feedback. Reviewer `ph7f5w33myqa0z3227h3e4yz1h8h397f` returned **GROUNDED** for the
exact V2 snapshot; receipt SHA256 is
`bfa7f5b3c4f817e768b7d605512571ac588a8e031ac6401ae4f0fe06e3d8ee3b`.

The suite is registered in `scripts/test.sh`. Its bounded registered invocation
passed 21 tests; existing direct-preconfiguration 12, lifecycle 17 and recovery
8 controls passed. The five original layouts changed from baseline refusal to
candidate reconnect/phase success using explicitly **mocked** native inert
reads and current ACKs. A separate synthetic FAILED normal-seven fixture passed
the real manifest/result validators and closed runtime only after both phases;
missing evidence, changed native identity and conflicting allocations refused.
No full system test run or live recovery result is claimed by those controls.

The code boundary is fixed and independently qualified. Actual recovery still
requires separately authorized execution with fresh source/pin, dead-owner,
lock, deadline and native-state checks. R123 touches the same fleet file. Both patch application orders produced
identical runtime bytes (fleet SHA256
`b7229a4699287b894fcfd7c3c98c8ed63e2bd2e51f13c391c627c19f91fcb67c`).
The composed checkout passed 21 owning, 6 deadline and 17 lifecycle tests.
The deadline fixture now loads the new production helper dependencies and
ordinary registry metadata; its assertions are unchanged. Independent review
also qualified that fixture-only composition adjustment. Historical grades and original
cleanup failures are preserved; no provider absence or release is inferred.

## Human feedback

None recorded specifically for this recovery repair.

## Reusable lesson

Carry every retained producer output through a typed, independently verified recovery phase before allowing whole-owner cleanup to discard its obligations.
