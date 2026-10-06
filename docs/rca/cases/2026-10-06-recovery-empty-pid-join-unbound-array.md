---
id: 2026-10-06-recovery-empty-pid-join-unbound-array
date: 2026-10-06
title: Exact-owner recovery's empty PID join aborted before audit closure
surface: infra
component: cloudbench-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the final cleanup join expanded an empty local PID array under nounset
symptoms:
  - exact native canary Machines and Volumes were absent before the allocation deadline
  - documented recovery exited with reap_pids array unbound
  - the original canary claim and incomplete audit remained
tags:
  - cloudbench
  - exact-owner
  - recovery
  - bash
  - empty-array
sources:
  - commit e845150de788c572a935b6e7bba34038eb7a519b
  - fleet run 20261006-025437-62250
  - plan:.context/benchmarks/campaigns/campaign-20261006-095345-47794/cli-validator-native-release-observation.json
  - plan:.context/recovery-empty-pid-join-20261006/permanent-original-red.safe.json
repro: agents/benchmarks/cloudbench_dependency_sync_test.py::test_fleet_lifecycle_receipt_requires_final_registry_retirement_empty_pid_join
status: fixed
---

## Problem

After the failed e845 task-free canary, the normal exact-owner recovery command
exited with `reap_pids[@]: unbound variable`. Native inventory independently
verified both exact Machines and Volumes absent at 10:14:40 UTC, before their
1,200-second cutoffs. That proves resource release, not successful recovery:
the canary ownership record, recovery lock and incomplete audit remained.

All fifty task-copy controllers and claims had retired without task execution.
The original failed run, recovery log and absent finish epochs remain preserved.
Its shared Hub predates the campaign and is protected; a stale audit does not
authorize killing an unrelated or borrowed process.

## Diagnosis

Path: exact dead-owner proof → owned registry reaper → no pending asynchronous
cleanup children → final local PID-array expansion → nounset exit → incomplete
audit/ownership closure.

The error names the array used by the final join. The retained source's shell
line attribution points at the nested reaper declaration, not an independent
failing provider request. Serial cleanup, an initially empty registry, or a full
parallel batch can legitimately leave this array empty. A partial final batch
contains real children and provides an inverse.

An actual extracted-reaper permanent owner executes these states with the same
strict shell options and owning cleanup/audit callbacks. On unchanged source it
produces four real empty-array nounset failures and one passing partial-batch
inverse under system Bash 3.2.57. Each also passes under Homebrew Bash 5.3.15.
The ended native recovery receipt omitted interpreter identity; a preflight
Bash version cannot retrospectively prove the failed process's binding. The
portability mechanism is reproduced, while that attribution remains qualified.
The ordinary full benchmark controller's modern-Bash requirement is unchanged.

Archive search covers empty PID joins, nounset, exact stale recovery and registry
retirement. Earlier stale-owner cases establish unused-reservation retirement,
exact dead-owner proof and final audit sealing; none owns this final empty join.

## Solution

Use a zero-element-preserving array expansion for the final join. Real pending
children still wait once, and their failures still retain unresolved ownership.
An empty array performs zero waits. Nounset, provider identity checks, unsafe
cohort rejection and audit finalization are preserved.

The unchanged permanent owner is green on the candidate. Twelve focused controls
cover its five states plus bounded parallel waits, failed cleanup retention,
unsafe ownership and accepted terminal dispositions. The existing normal
`fleet_lifecycle_receipt_requires_final_registry_retirement` registration selects
the new owner. Independent review replayed the original four failures and the
passing inverse, then the final twelve controls. No new provider operation or
deadline is introduced.

Actual documented recovery on reviewed source hash `c79bcd50` used captured
Homebrew Bash 5.3.15 and exited successfully in 1.671 seconds. At 10:23:26 UTC
the exact claim and recovery lock were absent and the audit recorded provider
teardown verified. No ownership files were removed by hand. The pre-existing
shared Hub was preserved under the existing transfer-required disposition; that
separate handoff obligation is retained rather than reported as full Hub closure.
The original failed campaign retains zero acceptance credit.

At 10,000 agents this changes only an empty shell expansion after existing exact
cleanup. Parallelism, native operations, task execution, model calls and results
remain unchanged.

## Human feedback

The user requested compact permanent verification and fewer unnecessary resets.
Repair and rerun the exact recovery path rather than starting another benchmark
campaign or forcing ownership records away.

## Reusable lesson

An empty asynchronous join is a valid cleanup state. Verify it through the real
strict-shell owner and keep resource release separate from audit closure.
