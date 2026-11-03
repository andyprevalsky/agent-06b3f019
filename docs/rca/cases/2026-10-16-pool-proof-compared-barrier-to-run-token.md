---
id: 2026-10-16-pool-proof-compared-barrier-to-run-token
date: 2026-10-16
title: Normal pool proof compared run identity with the barrier credential
surface: harness
component: cloudbench-primary-pool
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: pool_native_reuse_proof compared CLOUDBENCH_BARRIER_TOKEN with the owner-derived task token instead of CLOUDBENCH_RUN_TOKEN
symptoms:
  - An authentic normal primary fails the pool native identity assertion
  - A correct run token and independent barrier credential are rejected
  - A matching barrier could mask an incorrect run token at this assertion
tags:
  - cloudbench
  - pool
  - ownership
sources:
  - plan:.context/pr1525-continuation/current-org-capacity-read/navi-whisper-lux-bench.machines.1792129417.private.json
  - plan:.context/pr1525-continuation/root-delta/ownership/v30-inert-ledger-prepared/once-2ff9e37909b72c787f139362b258eeba/ledger-receipt.private.json
  - commit b6cc4704b261e80bc25020dd9ca31c513c09491e
repro: python3 scripts/tests/cloudbench-pool-run-token.test.py
status: open
---

## Problem

The normal pool native proof rejected the correct task identity because it
compared the owner/ordinal token against an independently generated barrier
credential. This blocks the newly wired live primary return before admission;
no live return success is claimed from the local regression.

## Diagnosis

The producer path is fleet owner plus task ordinal, passed as
CLOUDBENCH_FLEET_RUN_TOKEN to run-bench-cloud, then RUN_LOG_TOKEN, then the guest
CLOUDBENCH_RUN_TOKEN. The synchronized-start barrier follows a separate path
from BARRIER_RELEASE_TOKEN to CLOUDBENCH_BARRIER_TOKEN. The immutable task
matrix supplies the ordinal; the owning registry supplies the owner.

Saved native Machine 897915b6626e18 and its V30 owner ledger bind owner
64b71bd37fb64850ad5bfb6846e2bd11, run 20261015-085227-1717. The native run token
matches owner ordinal zero, while the native barrier differs. Evidence
hashes and comparison booleans are retained in the private
run-token-proof/actual-evidence.safe.json. No credential value is included in
this case or the test fixture.

The local reproduction executes the actual pool_native_reuse_proof function
with a sanitized saved identity, REF and shape, and fixture native reads. The
stopped state is a test premise, not a claim that the saved inventory proved
this Machine stopped. A fixture provenance loader supplies the owner/matrix
boundary inputs; this is not an end-to-end runtime or provenance qualification.
The old function produced three failures among four cases: correct run identity
was rejected and an incorrect run identity with a matching barrier was accepted.
The independent changed-native-pair refusal already passed.

Archive searches were `pool_native_reuse_proof CLOUDBENCH_BARRIER_TOKEN` (no
match) and `run token barrier identity pool reuse`. The latter found the October
4 child-shutdown-token case. This is a related identity-contract failure in a
different consumer, not evidence of recurrence at that earlier fixed boundary.

## Solution

Change only the normal native proof assertion to compare
CLOUDBENCH_RUN_TOKEN against the exact registry owner and immutable task ordinal.
Keep the native pair, image, Volume, REF, shape and all cold/import guards
unchanged. A barrier credential cannot substitute for the run identity.

The registered four-case regression passed five consecutive unchanged runs
(20 case passes). It covers the saved identity with a distinct sanitized
barrier, changing only the barrier, a wrong run token even with a matching
barrier, and a changed native pair. Bash syntax and diff checks passed. The
regression is registered in scripts/test.sh and the structural gate registry.
Full benchmark and native return verification remain with the root operator;
this case stays open for that outcome evidence. No provider calls or further
runtime changes were made while recording this case.

## Human feedback

Prioritize the actual normal-return blocker before introducing a new idle
origin. Preserve the distinction between run identity and barrier credentials,
use actual saved native/owner evidence, and do not claim live pool admission
from offline tests. Preserve all originals and do not print secrets.

## Reusable lesson

Validate each identity against its owning producer. A synchronization
credential and a task ownership token are independent even when both appear
in the same guest environment.
