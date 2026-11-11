---
id: 2026-11-11-isolated-validation-rejected-stopped-inert-worker
date: 2026-11-11
title: Isolated validation treated an inert stopped worker as a failed primary
surface: infra
component: deploy-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: isolated_execution routes every stopped provider pair through the dependency-failed-primary predicate
symptoms:
  - native cleanup stopped startup owner
  - worker never staged but retained runtime evidence latch blocks new validation
  - native cleanup proof file too large on final rehash
tags:
  - cloudbench
  - worker
  - custody
  - isolated-validation
sources:
  - PR #1919
  - commit e9a1565dc2ed4ba1391484629e23d6d0f4d9aced
repro: python3 -B scripts/tests/deploy-test-cycle.test.py StoppedInertAllocationIsolation
status: mitigated
---

## Problem

The additional payment-fixture failure during PR1919 left thirteen native smoke
outcomes UNVERIFIED. Exact-owner recovery completed for seven fleet owners;
other original failures and missing exports remained quarantined. One retained
owner had a fully exported primary and a fresh worker that never reached staging.
Its native creation config was inert `sleep infinity`. The reviewed operator
verified the exact owner, source, Machine instance, volume, process inventory and
unchanged custody, then stopped that worker while retaining its volume and latches.

The isolated-validation consumer classified every STOPPED provider pair as a
dependency-rejected primary. That predicate correctly required the task's primary
`.cid`, which referred to the other Machine. It therefore refused the inert worker
with `stopped startup owner`. This consumer is unchanged between baseline
`1f1e176a4736b2f948ba2fa5ffb2b119a7edbbc9` and failed source
`e9a1565dc2ed4ba1391484629e23d6d0f4d9aced`: `Gate: NOT_INTRODUCED` by the chat
profile repair. The deploy owner retained this operational repair and original
smoke execution; attribution granted no waiver.

## Diagnosis

Actual native GETs and the allocation, clone and reverse-index records identify
worker `845003f2609078`, primary `895901f65454e8`, and owner
`276dc2d88ddb4f1cabe98ef82f4cadb3`. The worker had no stage, readiness or runtime
owner record. Its source-pinned operator is SHA256
`51f69b6cf96ca6ff4bceabb9c1b3a8b0c3da2ad5a0d5e7aa35368e4ed76685be`.
The operator's literals, sole STOP intent, unchanged before/after observations,
STOPPED confirmation, inert process ACK and retained registry/audit/index all
agree. No historical worker runtime owner was fabricated.

The primary is covered separately by the existing current-OS protocol. Guarded
graceful teardown stopped its dedicated PostgreSQL cluster and exact status
server; the original PostgreSQL acknowledgment failure remains opaque and was
not retried. A subsequent status-only continuation preserved that failure and
obtained complete process/socket observations and actual child/CLI exit zero
before the sole native STOP. Both original volumes and all unconfirmed latches
remain retained. A volume-only row on a successfully retired owner already fits
the existing sealed-native-release path; no new volume or resource-key policy
was needed.

Actual replay exposed a second consumer boundary: the primary's seven sealed
files total 190,977,712 bytes, including a 117,895,297-byte worker log. Its owning
reader explicitly accepted and hashed the file within the existing 512 MiB
manifest budget. The final debt rehash nevertheless reapplied its default 64 MiB
limit. The replay with the first fix alone failed `proof file too large`.

Related inert-at-creation and stale-source-pin archive cases were read. The
current PR1918 repair covers two preboot configured primaries and does not cover
this worker or this post-service primary. No existing published repair for this
precise consumer branch was found.

## Solution

Add one explicit stopped-inert-allocation descriptor inside the existing STOPPED,
fresh-owned, retained-registry branch. It accepts only the reviewed producer's
exact bytes and AST-bound resource/source literals, original STOP intent and
receipt hashes, unchanged native instance/config/image/mount, source-pinned
scanner and nonce/time window, unstaged worker ledgers, current raw provider
observations, complete retained custody and unchanged primary export. Existing
pre-stack, current-OS, native release and volume predicates remain unchanged.
This is execution admission only: cleanup remains false, obligations remain
preserved, and no task or evidence credit is granted.

For the final rehash, remember the actual byte length only after the owning
reader has validated that exact path and digest. Rehash within that previously
accepted size. Unvisited paths retain the default limit; initial-read and
aggregate allowances are unchanged, and altered bytes still fail their hash.

The new tests live in the existing registered deploy-cycle family. The unchanged
positive fixture fails on canonical source at `stopped startup owner`; the
candidate accepts it without changing the original receipt, attempts, failures or
runtime latch. Thirteen altered-input scenarios refuse atomically, including
active/reused resources, coherent config replacement, missing or extra custody,
unknown processes and attempted credit. A large-member regression separately
fails before the rehash correction. The final unchanged suite passes, and a
read-only full replay of the actual fourteen-participant packet validates all
seventeen exact exclusions with credit=false, cleanup=false and obligations=true.

Private source witnesses, operator controls, original refusals, raw observations,
proofs and owning RED/GREEN logs are retained under
`.context/rca-e388d514/cleanup-f1eb/`. The complete actual replay is independent of
the unit fixture's explicitly substituted producer pin. Normal current-source
smoke and production verification remain required; this repair supplies neither
PASS nor historical cleanup completion.

## Human feedback

Preserve unused compute's exact identities and retained data while stopping it
only after current consumer/process guards pass. Do not clear latches, invent
missing runtime owners, weaken test intent or convert unexecuted work to PASS.

Golden reference: not applicable to this artifact-consumer contract. Independent
review GROUNDED the exact source/test patch and actual zero-credit replay.

## Reusable lesson

Distinguish a positively proven inert allocation from a launched primary while
preserving their different evidence obligations. Final verification must retain
an owning reader's already validated per-file allowance without widening first
reads or unrelated paths.
