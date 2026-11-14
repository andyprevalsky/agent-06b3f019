---
id: 2026-10-30-r98-it24-exact-owner-cleanup
date: 2026-10-30
title: It24 four retained owners recovered through canonical guest and runtime checks
surface: infra
component: cloudbench-exact-owner-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Four original cleanup lifecycles retained guest and runtime latches after campaign stop
symptoms:
  - guest-cleanup-unconfirmed
  - runtime-evidence-unconfirmed
  - FAILED lifecycle with retained ownership
tags:
  - r98
  - it24
  - cleanup
sources:
  - commit 8136eb6bb1d32d98553a70ca5f98278b590bee81
repro: none-recorded; original custody and authorized canonical recovery receipts
status: open
---

## Problem

It24 retained four cleanup owners with both guest and runtime latches and no
sealed normal manifests. Original9PASS/3FAIL/8CANCELLED and13verified/4FAILED
lifecycle records are historical outcomes, not rewritten by later recovery.
The causes of the original interrupted cleanup remain separate and OPEN.

## Diagnosis

The exact source was8136eb6bb1d32d98553a70ca5f98278b590bee81. Plan SHA256
97b2c2956ce7516f032ca29d7d9fa79e39e4196b71211a802cbd9c65e985619e
and custody archive44a303f2ffda98bad23fe754a17dc93cdd6d13c03ab7f989e01075a28f1e91de
bound four packets. All172 listed files, registry/port bindings and before-pins
hashes were independently verified. The four critical helper hashes and the
planner's source-helper dependency matched the executed git source.

Each original had one owned fresh primary, no pool record, donor683e47df5094d8,
and neither confirmed guest shutdown nor native-stop receipt. Extracted actual
planner code returned rc0 with one nonempty guest entry per relocated scratch
copy. No empty-plan or already-retired shortcut was inferred from R89 or R94;
their Solution and Human feedback were read. The mapping test proved no live
native state, guest reachability or runtime completion.

## Solution

No source patch or manual latch/ACK change. The coordinator authorized each
canonical command sequentially, with fresh identity checks and unchanged bounds:
`bash scripts/run-bench-fleet --ref 8136eb6bb1d32d98553a70ca5f98278b590bee81 --recover-stale-owner <exact owner>`.
The launch owner executed them. All four returned rc0 through the existing
quarantined guest-cleanup, runtime-verification and owned-teardown route.
This investigator performed no native operation.

| Job | Exact owner | Canonical/mirror SHA256 |
|---|---|---|
| r001-j0003 | e45cca34616e456bb24a3569795a7f3d | 2d539d9fc0ca4f4a820acdc0dfcfef1f3a4ea2b54a6fb796ed6c24bbe1870f8f |
| r001-j0006 | 707fc9b1ae1a482f9ac1f0f7eeeb6d8d | b42913fe55f15927915dbf4dba2ff9f911d6e6c510894e9319e8532c9b177a59 |
| r002-j0012 | 2aa159787e074e97b9c62f87957d1fa8 | 9ce2e4f1ab60a38071c8b0725796ec963b47455670dad0cc9bd5b3ebd45cc1ec |
| r002-j0013 | e31b8e173403485e95b461a2a61250af | 9d325bbeb00781b8f95834b5912fb1763c9a8f83cb432819a703b6645b4f6f48 |

## Verification

All four full20-file canonical trees and mirrors were independently reopened
here and their digests matched the table and accepted aggregate. Each original
FAILED lifecycle file still matched its before-pins hash. The parent separately
verified all four source bindings and the prior13 complete trees.

Aggregate17 at1793327251.585924 has SHA256
1899e2e92c8f3aa74016b8fc0f73268a6ab6c05ad0bac38274c79c39fc13e2bf.
All17 expected canonical/mirror/source bindings match; current registry absence
is owner-local attestation. All original lifecycle hashes remain13verified and
4FAILED. Summary5f57176d772ee46417b757c77a1c7eaa896c78fa11ba439867291a1db8fa3ebc
and9PASS/3FAIL/8CANCELLED are unchanged. This establishes scoped post-recovery
operational release, not release at original finish, task credit or an underlying
root-cause fix. Provider-retained terminal state is not universal object absence.

## Human feedback

The coordinator required actual per-owner planning before operation, each
preceding result verified before the next recovery, and all four results plus
the accepted aggregate before final documentation. No broad cleanup, new
benchmark, model replay, manual ACK or source change was performed here.
Tokens UNMETERED.

## Reusable lesson

Prove each retained owner's current obligations and keep later operational
release distinct from original task grades and failed lifecycle history.
