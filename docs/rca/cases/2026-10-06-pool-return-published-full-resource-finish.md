---
id: 2026-10-06-pool-return-published-full-resource-finish
date: 2026-10-06
title: Pool primary return published the full-resource finish clock before owned workers closed
surface: harness
component: cloudbench-fleet-release-clock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet pool claim return wrote bench-e2e.finished-epoch before the complete worker and claim audit
symptoms:
  - pool primary return stopped full-owned-resource accounting
  - missing actual full-audit producer clock
  - provider-teardown-verified status persisted after clock-write failure
tags:
  - cloudbench-fleet
  - resource-ownership
  - release-clock
  - atomicity
sources:
  - commit 5233c125258139b2c71a7d35a8a39d7f30d02984
  - agent /root/fresh_claude_grouped50_cli
  - plan:.context/fresh-claude-grouped50-20261006/full-release-clock-packet/independent-rerun.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

The supported operator clock was inconsistent across fresh and pooled copies.
Exact pool-primary return wrote `bench-e2e.finished-epoch` before owned worker
teardown and the global audit. The later full-audit fallback preserved that
marker. A monitor could stop the independent allocation cutoff too early.
This is a locally reproduced CLI accounting defect; no historical fleet failure
or 1414.4-second startup baseline is attributed to it.

## Diagnosis

Allocation → primary return → worker/claim teardown → immutable provider audit
→ final release marker is the critical path. The primary-return write was the
first bad boundary: one scalar represented both an individual primary return
and complete resource release. The immutable audit had no producer clock, so
observer time could overstate full release. General cause: terminal bookkeeping
published a stronger lifetime claim than the resources it had verified.

Archive searches were `bench-e2e.finished-epoch pool` and `owned worker release
clock cutoff`. Pool-claim orphaning and already-reaped-worker identity cases are
relatives with different first-bad boundaries, not proven recurrences.

Unchanged owning controls execute extracted native pool-return, full audit and
finish code. Original source: 2 failed, 1 passed. Private candidate: 3 passed.
Adversarial root review found a second write-order defect: verified meta could
commit before epoch write, causing later verification to skip a missing clock.
Injected exact clock-write failure reproduced that candidate defect: 1 failed,
3 passed. Revised candidate: 4 passed. Root independently reran the frozen four
controls: 4 passed in 2.141 seconds outer / 1.79 seconds pytest.

## Solution

Private candidate separates `pool-primary.returned-epoch`, prepares the full
producer epoch after all native verification and before publishing verified
status, and binds it through the existing immutable audit tree digest. Every
new fresh/pooled finish marker uses that full clock. Failed clock preparation
leaves incomplete status and can retry. Sealed valid clocks and legacy verified
clockless audits stay untouched; the latter retain an explicit post-verification
fallback. Allocation, task result bytes and execution budgets stay unchanged.

Delete/unify evaluation: separate the weaker pool-return observation and unify
all full-release clocks at the existing audit producer. No consumer-specific
reset rule or extra task acceptance criterion is introduced.

The frozen private command, environment and hashes are in
`independent-rerun.safe.json`; RED/GREEN logs and safe scalar receipts are in the
same packet. The existing compact owning gate selects the added tests through
its current `fleet_retained_resources_do_not_claim_release` filter. Integration,
checked-in archive indexing and deploy verification remain root-owned and
pending, so status stays open. This repair earns no native performance or
benchmark credit; the actual fifty-copy diagnostic remains held.

## Human feedback

None recorded for this accounting repair. Root technical review required
failure/reverification coverage and preservation of exact producer time,
legacy immutability, original allocation, results and budgets.

## Reusable lesson

Publish a full-resource release clock only at the owner boundary that has verified every owned primary, worker and claim, and prepare its durable clock before committing verified status.
