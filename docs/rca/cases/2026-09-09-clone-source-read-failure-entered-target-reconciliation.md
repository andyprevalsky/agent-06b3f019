---
id: 2026-09-09-clone-source-read-failure-entered-target-reconciliation
date: 2026-09-09
title: A clone source-read rejection entered target-allocation reconciliation and amplified the provider rate limit
surface: infra
component: cloudbench-fleet-clone-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet clone_failure_definitively_unallocated and clone_machine_target collapsed source-read rejection and ambiguous post-allocation failure into the same missing-target-ID path
symptoms:
  - "FAIL: source-machine rate-limit rejection crossed into post-mutation clone-name resolution (1 forced inventory refreshes)"
  - "unresolved clone name 'cloudbench-…'; inspect with: flyctl machines list"
  - "Error: could not get machine 683e47df5094d8: failed to get VM 683e47df5094d8: resource_exhausted: rate limit exceeded"
tags:
  - cloudbench
  - fly-io
  - clone
  - rate-limit
  - ownership
  - preallocation
sources:
  - commit 65cb5c022656ed028d7031bfb57bb8ad12e002ac
  - fleet run 20260909-215629-914100
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

`flyctl machine clone` failed before target allocation because Fly could not read
the source Machine under its organization rate limit. The controller nevertheless
forced a fresh target inventory read and emitted `unresolved clone name`, adding
provider traffic during the exact rate-limit condition it was meant to absorb.

The deterministic pre-fix command was
`CLOUDBENCH_TEST_CLONE_SOURCE_RATE_LIMIT_REPRO=1 bash scripts/tests/cloudbench-multi-workstream.test.sh`.
It exited 1 with `FAIL: source-machine rate-limit rejection crossed into
post-mutation clone-name resolution (1 forced inventory refreshes)`. The trace
recorded clone status `1`, no authoritative target ID, and
`definitivelyUnallocated=0`, followed by `clone-name lookup entered`, a successful
`generation-0` to `generation-1` refresh, and deadline exhaustion. The refresh
therefore did not fail; it correctly found no target because target allocation
had never started.

## Diagnosis

Critical path:

`fly_with_timeout machine clone <source>` → clone output/status capture →
authoritative target-ID parse → pre-allocation classification → target-name
inventory reconciliation → durable name retirement → retry.

The first bad boundary was classification. `clone_failure_definitively_unallocated`
recognized only `failed to create volume:`. It omitted Fly's exact source-read
failure even though a failed source read necessarily precedes every target
resource mutation. `clone_machine_target` then used only an empty parsed target
ID to enter `machine_id_for_clone_name`; it did not use the already available
command status and phase evidence to gate that post-mutation operation.

Deepest-owned-cause ladder:

- Target reconciliation ran because the output had no target ID.
- A missing target ID was ambiguous because source-read, volume-create, target
  launch, timeout, and post-create response failures all shared one empty-string
  representation.
- The ambiguity persisted because pre-allocation disposition was an ad hoc
  late cleanup predicate rather than one source-aware decision made before any
  target reconciliation.

The deepest owned cause is a lifecycle-contract inconsistency: clone failure
phase and ownership certainty were available but were not the source of truth
for selecting pre- versus post-mutation handling.

Archive searches for `source-machine rate-limit rejection post-mutation
clone-name resolution unresolved clone name` and `fleet clone preflight mutation
boundary provider inventory cancellation ownership` found the 2026-07-15
unthrottled/fixed-retry rate-limit cases and the 2026-07-20 name-only reservation
case. This incident is a relative, not a recurrence: retries and durable
reservations worked, but the phase classifier routed a pre-allocation rejection
through target reconciliation.

## Solution

`clone_failure_definitively_unallocated` now derives one fail-closed disposition
from clone status, exact source identity, and the complete transcript. An
ordinary single terminal error is allocation-free when it proves either that the
exact source Machine could not be read or that target volume creation failed.
Timeouts, mixed transcripts, mismatched source identities, and all later target
failures remain ambiguous.

`clone_machine_target` computes that disposition once, before target lookup, and
uses the same value both to skip post-mutation reconciliation and to retire the
prewritten name/audit record. This unifies routing and cleanup instead of adding
a rate-limit-specific retry branch. It also prevents every nested source-read
failure and definite volume-create rejection from spending an unnecessary
Machines inventory refresh.

The unchanged reproduction exits 0. Its post-fix trace records
`definitivelyUnallocated=1` for attempt 1, contains no
`machine_id_for_clone_name` entry, and then records the successful attempt-2
authoritative ID. The contract also runs unconditionally in the permanent
multi-workstream suite, and the dependency-sync blackbox covers mismatched
source IDs, watchdog timeouts, and mixed error transcripts.

At 10,000 agents, the change adds O(1) local transcript parsing per failed clone
attempt and removes up to one provider inventory refresh per pre-allocation
failure. It adds no channel, subscription, lock, poller, row, or shared mutable
state.

## Human feedback

The user required the deepest generalizable fix, the exact unchanged reproduction
to pass, permanent consistently-run coverage, and an RCA case/index. They
prohibited benchmark task, timeout, and concurrency changes; prohibited commits;
and required a read-only inspection of exact campaign ownership/provider residue.

## Reusable lesson

Classify resource-creation failure phase once before reconciliation, and use that same source-aware disposition for both control flow and durable ownership retirement.
