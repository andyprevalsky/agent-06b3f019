---
id: 2026-10-07-stale-owner-recovery-mistook-retired-outputs-for-active-registry
date: 2026-10-07
title: Exact recovery required already retired outputs to remain actively registered
surface: harness
component: run-bench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet fleet_registry_build_guest_recovery_plan required all retained original .cid outputs to belong to remaining active machine_records
symptoms:
  - "ValueError: stale-owner output does not map one-to-one to registry"
  - exact recovery exits before reconnect after forty-nine primaries retire early
  - fifty original task outputs remain but only one clone remains registered
tags:
  - cloudbench
  - exact-owner-recovery
  - early-primary-retirement
  - lifecycle-membership
sources:
  - commit 681481df0425caf0a8d2157b872027b11a8ef8f9
  - fleet run 20261007-020659-75781
  - memory:original-owner-06e8a83b47ac4592a6145d2878773774
  - memory:partial-retirement-recovery-rca.private/actual-original-authority-replay-v2.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_exact_recovery_consumes_runtime_receipt_after_partial_primary_retirement
status: open
---

## Problem

The immutable normal DAILY fifty-task control ended with a genuine startup
failure on gate-source-connect-gmail. Its other forty-nine tasks executed and
retired their primary native resources independently. The original CLI exited
1, and supported exact-owner recovery began at epoch 1791366788. Recovery then
exited 1 inside its local plan builder, before guest reconnect or native reaping,
with `ValueError: stale-owner output does not map one-to-one to registry`.

The remaining registry contains one original Gmail clone, Machine
d89513dc560728. The original directory correctly retains fifty unique .cid
outputs, including all forty-nine completed scopes. The unchanged shared native
audit contains fifty-two allocations: forty-nine retired primaries and two
retired workers have destroyed-provider-retained receipts; the remaining Gmail
primary is owned. Both guest-cleanup-unconfirmed and runtime-evidence-unconfirmed
remain present. The latest retained inventory shows that original Gmail Machine
started, so missing accepted-start/proxy markers cannot imply no guest ran.

The hard image-to-E2E cutoff was epoch 1791366972. The owner remained unclosed
after that cutoff. This original control earns zero qualifying fifty-task
credit. A local planner repair cannot convert its startup failure, source
binding, recovery delay or missing full release into a successful run.

## Diagnosis

Critical path: the collector seals a completed scope → exact native retirement
writes the original terminal audit and removes its active registry entry →
original task artifacts remain → supported dead-owner recovery enumerates only
remaining allocations into machine_records → the planner enumerates every
historical .cid → membership rejection prevents the remaining original guest
from reaching its existing forensic recovery path.

Native audit and registry agree about the forty-nine completed primaries.
The first incorrect boundary is the planner's equality between retained output
membership and current allocation membership, original source lines 6940–6955.
Keeping original evidence and early retirement are deliberate; neither producer
should be changed to restore the old equality. The deepest owned gap is the
consumer's missing distinction between positively retired exact history and
allocations still requiring recovery. Empty historical worker ledgers and
ledgers retaining retired worker IDs expose the same assumption in its second
mapping pass.

The permanent owning fixture invokes the actual extracted plan-building shell
function and embedded Python with fifty original outputs, one current registry
clone, fifty-two original native receipts and a captured private source
manifest. No provider implementation, model, guest or sleep participates.
Two positive cases preserve empty and retained terminal worker ledgers.
Thirteen inverse controls cover missing/linked exact indices, unproven native
disposition, foreign owner/run/app, wrong Machine/intent, duplicate outputs,
Volume aliasing, worker-as-primary, wrong worker source and an active worker
under a retired primary. Rejected cases leave authority unchanged and write no
plan.

The exact unchanged command, from the isolated candidate, is
`python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k
'after_partial_primary_retirement or rejects_unsafe_retired_mapping' -rA`.
Original 681 runtime gave **2 failed, 13 passed in 5.01 seconds**; candidate gave
**15 passed in 3.83 seconds**, with identical test SHA256
6b4c5b6548aaed83e729520ea611031d00f8026662b68f73d4469659f2136ae5.
Sixty-seven existing and new related recovery cases passed in 14.22 seconds.
Fixture planner leaders/groups and pytest leaders were positively joined and
absent. New host supervision uses the existing 600-second host guard and
30-second drain guard; production deadlines and elapsed-time assertions are
unchanged.

A separate read-only replay used the exact original registry, source manifest,
native audit and original outputs. Original planner reproduced the same
exception. Candidate wrote exactly one guest row for gate-source-connect-gmail
/ d89513dc560728, using the existing preferred-port-zero mapping. No worker or
retired-primary rows were emitted. All original registry/audit hashes remained
unchanged. The first replay receipt assumed a different Gmail task label in one
diagnostic Boolean; the preserved v2 receipt corrects it directly from the
original .cid and retains its predecessor hash. Neither replay performed native
or guest actions.

Archive searches were `recovery retired registry output mapping` and `early
primary retirement stale owner planner`. The September 9 removable-registry
case, October 5 exact-worker-reservation case and October 6 sealed-primary
retirement case are relatives. Their solutions and human feedback were read
before reproduction. This is a new historical/current membership join failure;
neither vanished metadata nor unused reservation release is the first bad
boundary here.

## Solution

The isolated candidate joins a .cid absent from the current registry only to
its original regular, bounded by-Machine index, expected-fresh source intent
and exact fresh native terminal receipt. App, owner, run, clone, source,
Machine, Volume and an accepted native terminal disposition must agree.
Unknown, duplicated, mismatched, still-owned or unsafe records still reject
before a plan is written. Volumes cannot alias current or previously joined
historical allocations. Primary source topology prevents retired workers from
masquerading as original primary outputs.

Current allocations retain their complete one-to-one guest/worker mapping.
Historical outputs participate only in ownership/role validation; they never
enter reconnect or reaper plans. A retained terminal worker must have exact
positive native authority whose source is its original primary. An active
worker cannot attach to a retired primary. Unchanged guest recovery, runtime
capture, native retirement, final audit and latch closure remain responsible
for the remaining guest's actual end state. The existing rejected-start
port-zero mapping remains a mapping, never a claim that the started Gmail guest
did not execute. destroyed-provider-retained is native Machine/Volume authority,
not independently a browser/provider-session closure claim.

This fixes retired-primary and retired-worker historical membership at the
same owning boundary. Deleting evidence, reenrolling dead allocations or
bypassing unknown outputs would violate durable ownership. A broad recovery
rewrite would change working legacy/pool semantics. The repair retains those
paths and uses one memoized exact terminal receipt reader for the historical
join.

The new cases use the existing exact_recovery_consumes_runtime_receipt family.
The unchanged normal compact deploy selector discovers all fifteen. All 447
prior function ASTs and prior selector bytes remain identical. The normal
benchmark-live-results blackbox gate owns this run-bench-fleet surface.
At ten thousand outputs, planning remains one bounded local pass with memoized
per-Machine reads, O(N), without provider queries, polling, new queues or
increased native concurrency. Tasks, models, grading, task windows and the
whole E2E cap are unchanged.

Golden references read locally: OpenClaw
src/process/supervisor/supervisor.ts:113 retains owned admission through its
cleanup; Hermes tools/process_registry.py:703 moves positively ended sessions
into finished history and avoids reused PIDs; Claude Code
src/tasks/LocalShellTask/LocalShellTask.tsx:222 cleans up before terminal state.
The repair converges on separating current lifetime authority from retained
terminal history. None implements this cloud-native audit join; analogy does
not replace causal controls. Codex was absent at the known local reference
path; no source fetch occurred.

Status remains open pending independent review, integrated immutable recovery,
actual original guest/resource/evidence closure and fresh qualifying LIVE
controls. The local mechanism is causal. No task outcome, provider migration
cause, cloud speedup or final owner release follows from it.

## Human feedback

Root required a normal planner repair using exact verified terminal ownership,
never ignoring unknown or mismatched outputs or inventing a never-started
guest. The original 681 run and owner/guest receipts must remain unchanged.
Root required permanent compact owning controls, unchanged RED/GREEN
assertions, generous shared host guards, independent root/Tank/runner review
and delivery to the separate reviewed composition. No additional paid work or
provider mutations were authorized for this observer.

## Reusable lesson

Join retained original outputs to exact current or positively retired ownership before planning recovery, and recover only allocations whose lifetime remains open.
