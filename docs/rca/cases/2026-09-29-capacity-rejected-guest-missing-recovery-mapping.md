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

The 8 GB Machine remained unstartable on that host. The pool already has seven
other 8 GB Machines and three 4 GB Machines, so its existing shape-aware claim
selection can put the two large tasks on healthy 8 GB hosts without copying a
volume. An attempted replacement was canceled before startup when provisioning
selected an obsolete 40 GB snapshot; its exact volume remains under retained
provider-cleanup ownership until Fly confirms destruction. Ten consecutive
complete slices are still needed before this case can be marked fixed. No task,
model, prompt, evaluator, scoring rule, or benchmark timeout changed.

## 2026-09-30 recurrence: stopped pool volume retained a prior run

Counted candidate `20260929-235637-18520` again reached the same Fly host-local
capacity boundary, this time on `polar-odysseys-82af9358ab6a`. Four provider
starts for pooled Machine `8445e5b279d128` returned `could not start machine
due to lack of capacity`; nine peers produced real results and acknowledged
guest cleanup. The candidate has zero proof credit. The existing recovery mapping
correctly retained the stopped Machine, but the guest-receipt path required a
backend log and exact guest state that could not exist because the guest never
started. This member's original volume still held a **different, previously
completed run**; treating those stale bytes as the current task would be unsafe.

The exact owner was `4986a735e7924cf5b7b8f7de5ad97eae`. After stopping only
its nine acknowledged Machines, an inert 512 MB `sleep` boot on the failed
Machine captured its original 20 GB volume. The 7,551,386-byte capture had a
stopped services manifest, an exited driver, a prior `run.json`, and no current
owner or run ID in any captured file. The original Machine was stopped and its
boot configuration restored. This evidence distinguishes the external placement
failure from both a task verdict and a partially started guest.

The local owning-boundary reproduction is
`python3 scripts/tests/cloudbench-rejected-start-recovery.test.py`: it accepts
the exact four-rejection, stopped-volume case and rejects an accepted start,
three rejections, current-owner bytes on the original volume, and a started
Machine. Before this change, exact stale-owner recovery of the live candidate
failed with `stopped exact Machine has no sealed provider-state proof`, leaving
all ten claims retained. The new zero-credit rejected-start receipt is bound to
the exact owner, Machine, volume, original-capture hashes, and provider rejection
log. The forensic archive verifier independently checks those fields and the
prior-run bytes before it can release resource ownership. The receipt never
creates a benchmark result or changes evaluation.

The live exact-owner recovery completed after a 32,443,679-byte interrupted
archive passed the forensic verifier: ten exact tasks, nine sealed bundles,
one stopped prior-run volume, 93 hashed files, and zero proof credit. The
guest-cleanup and runtime-evidence latches were discharged separately; all ten
pool claims were returned. A later simultaneous inert preflight started all
ten of those same 20 GB pool Machines at 8 GB, stopped them, and restored their
benchmark boot command. This recurrence remains open until the subsequent
ten-slice no-INFRA streak is verified.

## Human feedback

The user requires ten sequential slices of ten real benches, zero INFRA,
at least three successful LLM queries per bench, smoke coverage, correct
evaluation and teardown, a temporary five-minute benchmark timeout and a
30-minute full E2E kill cutoff. Inspect trajectories and total/per-bench
wall time after every valid slice, and implement safe infrastructure savings
above five percent. Do not change the harness to make results pass.

## Reusable lesson

Map provider-rejected pre-proxy starts into exact recovery without treating the mapping as guest cleanup proof.
