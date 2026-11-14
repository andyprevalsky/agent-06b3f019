---
id: 2026-10-28-wide-operator-selected-historical-donor
date: 2026-10-28
title: Ordinary wide launches selected the historical original600 donor
surface: harness
component: cloudbench-wide-donor-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: ordinary task-ref discovery used the historical runner donor constants
symptoms:
  - canonical 40-copy check selected cloudbench-warm-t10-ord-85a7e2c instead of the activated ordinary donor
  - check accepted a pinned image receipt without comparing it to the selected native source image
  - refresh command targeted the old ORD donor
tags:
  - donor-identity
  - sharded-controller
  - image-proof
sources:
  - commit 4277a2d9e3b997c2a002d859d9a8fecac0585342
  - agent ph78kfk10r8j8fpxxcp5tc43xd8h2x6q I26 check receipt
repro: scripts/tests/original600-portable-operator.test.py OrdinaryDonorBinding
status: open
---

## Problem

The parent-provided canonical 40-copy dry-run at 4277a2d9e returned
CHECKED_NOT_LAUNCHED. Its discovery selected historical Machine
8ed16dc75ee958, name cloudbench-warm-t10-ord-85a7e2c, region ord, and image
c9e5, whereas the qualified ordinary campaign donor was Machine
683e47df5094d8, cloudbench-warm in iad, image9961. No campaign launched.
The original check receipt is preserved in .context/polar-i26 and the parent
thread. The old donor identity came from the runner constants, not a provider
misread. The optional image receipt was only checked for byte hash/schema on
this path; a refresh decision returned before the fresh-image semantic check.

The native source tuple must follow the ordinary producer selection all the
way through the remote runner. Changing only discovery would leave the remote
fixed environment pointed at the historical donor. Changing only those fixed
values would leave discovery, staged proof names and admission authority bound
to a different source. The default ordinary producer additionally stores its
proof at cloudbench-warm-deps.fp, without a machine-name suffix.

## Diagnosis

The permanent offline controls execute native selection, real operator.prepare,
runner.run through the launch-handoff boundary, discovery and the existing I19
image receipt consumer. Original prepare drops the selected native tuple;
original runner retains historical fixed values. Candidate carries the selected
native tuple in hash-bound facts, admission and configuration, fixes that tuple
in the remote environment, and refuses changed native IDs/volume/region before
source mutation. Discovery validates the selected image against the same I19
receipt and current fingerprints before returning a successful check.

Historical absent-task-ref constants remain unchanged. Native name/region and
volume name/attachment must uniquely agree. Snapshot status, size, retention,
source ref and fingerprint checks remain. Existing private-source validation
is unchanged. No task definitions, grades, timing limits or denominator change.

## Solution

Two archive searches covered donor selection and snapshot identity. The
October 5 snapshot-proof-owned-by-controller-checkout case supplies the closest
existing receipt-to-selected-source mechanism. The October 6 REAL-image clone
case distinguishes baked image dependencies from snapshot dependencies; this
repair retains the current operator's snapshot contract rather than claiming
that it is unnecessary for all routes. Existing I20 transport supplies bounded
private metadata staging, hashes and immutable admission. Existing I19 helper
supplies the exact native image/publication/fingerprint predicates.

A name alone is insufficient after a provider replacement. The final native
fleet check therefore compares the expected ID, mounted volume and region
before any shared source park. This is not an atomic provider freeze; normal
later native checks still apply. No old captured inventory substitutes for a
post-write completion check.

## Limits and next proof

All evidence and tests here are local or already captured. No provider API,
image build/activation, resource mutation, benchmark or deploy was performed.
The parent must integrate the reviewed bytes and run the same canonical
40-copy check, then its authorized unchanged-task cohort. That live outcome is
unproven. Original task failures and all resources, including Freedom, remain
unchanged.

## Human feedback

The parent requested the existing ordinary donor configuration, no new image
activation or paid probe, and exact independent review before runtime edits.

## Reusable lesson

A wide adapter must preserve the ordinary launcher's selected execution source
through discovery, admission, transport and the final native consumer. A
well-formed receipt for another source does not qualify the selected source.
