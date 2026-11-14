---
id: 2026-10-29-it21-bu083-cancelled-owner-normal-evidence-recovery
date: 2026-10-29
title: Cancelled BU083 owner recovered through existing sealed-evidence path
surface: harness
component: exact-owner-recovery
classification: unresolved
problem_class: other
first_bad_boundary: Cancelled owner retained an incomplete audit and runtime-evidence latch despite an existing sealed normal export; the initial cleanup failure cause remains unproven
symptoms:
  - "runtime evidence is incomplete; failed result retained while disposable resources are retired"
  - "retained-exact-owner-transfer-required"
  - "runtime-evidence-unconfirmed"
tags:
  - polar
  - bu083
  - cancellation
  - cleanup
  - sealed-evidence
sources:
  - commit 47a0e9d6c9a89e2d97933935509343372d565250
  - agent 684f3669-a883-4ff0-beca-1620eb434fa8
  - plan:.context/r85/recovery-result-verification.json
repro: none-recorded
status: open
---

## Problem

It21 BU083r2/r002-j0013 was cancelled and unscored. Its owner
09e6ea57792349539d6c6792262973a3 retained an INCOMPLETE audit, a
runtime-evidence-unconfirmed latch, and a failed original lifecycle. The initial
terminal collection had 16 fleets, 15 verified and this one incomplete. This
case concerns operational recovery, not the separate BU083r1 search failure.

## Diagnosis

Original source was 47a0e9d6c9a89e2d97933935509343372d565250, patch none.
Safe custody archive c88c56d113bc4e79713232be8be8408b773bb8f31b666e2f03cafedeaf301ced
contained 50 hash-verified members; native fence projections were explicitly
separate from original response bodies. The retained audit identified Machine
857614db6d0168 with Volume vol_4oj6xg2ljmgnwoxr, and a separate volume-only
allocation vol_v3gx6kk6w2djqjm4. Both dispositions were
destroyed-provider-retained; neither implies provider absence. Donor
683e47df5094d8 was a source identity, not a cleanup target.

The normal export already existed. Archive
b0f337f080432430028ad79e72ee696589b70ef308892780e0b330445f59b964 and all seven
members independently matched manifest
1f08f045f0f97983e3709a98499e441cfb15e7d72d5191b9276fc74fc6522b22.
Its run SHA was 167feb6246f6c9572fb381cf66816c10a3d33e0830591b4a0cbb540eee8320c8.
The unchanged primary-runtime validator passed on scratch copies; the unchanged
result validator also passed exact task, real mode, and execution-provenance
binding without requiring a successful benchmark. The owner separately
confirmed these exact bytes were already at the canonical runtime-evidence
path and the physical nonsymlink clones directory was empty.

An initial suspected recovery-ordering barrier was corrected before any patch.
The existing guest-plan builder recognizes retired primary outputs absent from
the active clone registry and excludes them from reconnect rows. Its exact
source, run on relocated captured metadata with the confirmed empty directory,
returned an empty plan. The existing runtime confirmation then consumes the
matching pending latch after validating the sealed originals. No new runtime
code, synthetic acknowledgement, manual latch deletion, or evidence restoration
was necessary. The initial interrupted cleanup cause remains unproven.

## Solution

After parent authorization, the owner executed exactly once:

```sh
bash scripts/run-bench-fleet --ref 47a0e9d6c9a89e2d97933935509343372d565250 --recover-stale-owner 09e6ea57792349539d6c6792262973a3
```

Process 2041730/birth19176784 ran from 21:54:57.097548Z to
21:55:10.968210Z on 2026-10-29 and returned zero. Returned bundle
13832f2cb2ec826677448a6f06af901c3647820414c21ed3578a4e8b604f8823 was verified.
The exact canonical audit and source mirror independently reproduced digest
aa0a20e1447fdd919488755fc9a91dc4ec850896147a5c3420321709ae7ebf63 and status
provider-teardown-verified. Parent and owner confirmed registry removal. Both
resource dispositions remained destroyed-provider-retained, not absent.

The original failed lifecycle remained byte-identical at
476e0db51a01bf0ae501f8abc0386f8670d23596dd662336ba3e2a6ba085c3f9.
Parent verified original final summary SHA
74a840f59b5aa55522cb2e06d8f13b44e02bf81062f531e3af27573cc7aa61f7 unchanged.
Original 11 PASS, 4 FAIL, and 5 cancelled outcomes were not regraded. Operational
recovery is verified; this is no task-success credit or explanation of the
original cleanup interruption. Retained shared-Hub ownership is not permission
for an unrelated process kill.

## Human feedback

The coordinator required source-pinned, existing-custody recovery with no new
capture, speculative patch, manual acknowledgement, or premature release claim.
The prepared command was made explicit at the fleet entrypoint. The apparent
ordering defect was withdrawn when the full retired-output branch was traced.

## Reusable lesson

A retained runtime latch does not prove sealed evidence is absent. Validate the
original files and the complete existing recovery plan before designing a fix.
Keep task results, original failed lifecycle, canonical operational recovery,
and provider-retained resource state as separate facts.
