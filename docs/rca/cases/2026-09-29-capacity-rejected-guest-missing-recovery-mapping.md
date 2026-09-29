---
id: 2026-09-29-capacity-rejected-guest-missing-recovery-mapping
date: 2026-09-29
title: A capacity-rejected pool guest had no status proxy mapping for exact recovery
surface: infra
component: cloudbench-fleet-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet fleet_registry_build_guest_recovery_plan required status-proxy.port after a provider-rejected post-config start
symptoms:
  - "could not start machine due to lack of capacity"
  - "boot-launch: provider did not accept the required post-config start"
  - "ValueError: missing stale-owner status proxy mapping"
  - "exact stale-owner guest recovery mapping is unsafe"
tags:
  - cloudbench
  - fleet
  - capacity
  - recovery
  - ownership
sources:
  - PR #1299
  - fleet run 20260929-191143-20488
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

A ten-benchmark smoke-inclusive cloud slice allocated all ten pool Machines, but
Fly rejected the post-config start of `agent-payment-abandonment` with host
capacity errors on all four bounded attempts. The requested 8 GB/shared-CPU-4x
shape was unchanged. The other nine Machines started; the failed Machine stayed
stopped, never published a status proxy, and produced no benchmark run record.
This is INFRA and the slice has zero acceptance credit. The proof cancellation
then reached `--recover-stale-owner`, whose mapping rejected the missing proxy
before it could recover any of the nine started guests.

## Diagnosis

The path was capacity admission → pool claim → boot-config update → Fly start
rejection → no status-proxy publication → exact-owner recovery plan. App-wide
CPU and Machine-count admission succeeded, but the attached volume's host could
not reserve the requested 8 GB Machine. Fly still rejected that Machine after
the other nine were stopped, while a 4 GB recovery boot succeeded. Host-local
capacity is an external placement constraint, not a benchmark or evaluator
failure. The owned bug was at the recovery-plan boundary: it assumed that an
allocated primary always had `status-proxy.port`, although the child publishes
that file only after a successful start. The same omission would strand any
provider-rejected boot before proxy attach.

The archive searches were `could not start machine due to lack of capacity
post-config start status proxy` and `stopped pooled guest never published proxy
recovery exact provider cleanup`. The September 9 capacity-reservation case is
a relative, but its app-wide reservation arithmetic was correct here; this
failure occurred at a volume host. The September 11 failed-proof ownership
case is also a relative: its supervisor preserved this exact owner, while the
guest mapping rejected a valid failed-start state.

The unchanged local owning-boundary test
`agents/venv/bin/python3 -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py::test_capacity_rejected_guest_without_proxy_remains_mapped_for_exact_recovery`
failed against the prior fleet script with
`ValueError: missing stale-owner status proxy mapping` (one failed, three
negative controls passed). It passes on the fix (four passed). The test also
rejects a claimed accepted start, a worker clone, and an unrelated boot error.

## Solution

The recovery planner admits a zero preferred local port only for a bounded,
regular failed-start log with no accepted-start marker, run record,
guest ACK, worker runtime evidence, or worker clone. This only preserves the
Machine/output mapping; it does not publish a guest cleanup receipt or release
any ownership latch. Port allocation prefers the other guests' real published
ports. Live recovery then authenticated all nine started guests. The rejected
Machine was booted solely for recovery at 4 GB after the others stopped,
produced an exact zero-provider manifest and guest ACK, and stopped. All ten
original volumes were directly captured, and the 108,815-byte zero-credit
archive passed exact-owner, file-hash, stopped-Machine, and attached-volume
verification before the owner and pool claims were released.

After syncing with `main`, the new `CLAUDE.md` rule 25b also ruled out
classifying provider failures by error-string matching. The final planner
uses only the structured start/receipt state and a bounded failed-start log;
an unrelated provider start failure remains mapped for exact cleanup and
still cannot release a guest latch without independent proof.

The 8 GB Machine remained unstartable on that host; pool replacement is being
performed once from the existing snapshot. The replacement and ten consecutive
complete slices are still needed before this case can be marked fixed. No task,
model, prompt, evaluator, scoring rule, or benchmark timeout changed.

## Human feedback

The user requires ten sequential slices of ten real benches, zero INFRA,
at least three successful LLM queries per bench, smoke coverage, correct
evaluation and teardown, a temporary five-minute benchmark timeout and a
30-minute full E2E kill cutoff. Inspect trajectories and total/per-bench
wall time after every valid slice, and implement safe infrastructure savings
above five percent. Do not change the harness to make results pass.

## Reusable lesson

Map provider-rejected pre-proxy starts into exact recovery without treating the mapping as guest cleanup proof.
