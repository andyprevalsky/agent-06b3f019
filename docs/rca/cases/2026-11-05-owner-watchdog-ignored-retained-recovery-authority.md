---
id: 2026-11-05-owner-watchdog-ignored-retained-recovery-authority
date: 2026-11-05
title: Stack owner watchdog destroyed explicit retained recovery authority after normal controller exit
surface: harness
component: local-benchmark-stack-owner
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run.sh start_stack_owner_watch treated controller death as unconditional teardown despite local.py recording failed_retained for the same isolated stack
symptoms:
  - "Owned cleanup is unverified; retaining services and database"
  - "Stack owner PID 3271837 exited without stopping this stack"
  - "local-stack-cleanup.status state=clean while benchmark-cleanup state=failed"
  - "victoria_bench_1793847959_3271837_98930 absent after retention"
tags:
  - retained-stack
  - owner-watchdog
  - isolated-benchmarks
  - recovery-authority
sources:
  - commit ce2742ae023ceab86a34d39bde2754a356f1cc4e
  - commit 712043718a2f3becebacb47aeb835e4254a8bf0e
  - commit 08b172b249867c633cb2480e821e845794c4038f
  - benchmark run 1793847959-3271837-98930
  - agent 01a1a32a-56ed-7043-b8dd-68349792e0b8 isolated evidence /home/boxes/cli-nov05-retention-repair/.context/retention-rca/
repro: scripts/tests/local-stack-retention.test.py
status: open
---

## Problem

The original AgentCard lifecycle worker ran ce2742ae0. Its native benchmark
cleanup receipt ended failed after payment recovery did not settle. local.py
atomically recorded failed_retained and printed the retention decision.
The stack services.log subsequently recorded its exact controller PID exiting,
then normal service teardown. Its stack cleanup receipt is clean, despite the
benchmark cleanup remaining failed. The parent observed the new backend port
and run database absent, and separately saved a 31 MB forensic dump beforehand.
No financial operation was performed by this investigation. The old protected
stack and database were outside this repair's scope.

## Diagnosis

The controller intentionally leaves its isolated stack in a separate session
when cleanup is unverified. The owner watchdog introduced in 712043718, moved
to a background watcher by 08b172b24, did not read that retention authority. It
therefore interpreted a deliberate controller exit like an accidental orphan
and sent TERM through run.sh's normal teardown, which includes dropping its
owned system database. This historical watchdog change conflicts with the preexisting
failed_retained protocol. Gate: NOT_INTRODUCED for the current deploy:
origin/main 3874a699d2c21e677c8e88fc8a06b863235fa754, frozen ce2742ae0 and
the repair base 7965e9e12 have identical owning runtime bytes. Historical
introduction in 712043718 does not mean this deploy introduced the defect.

The original worker result reports neither timeout nor cancellation and has
no native supervisor receipt. The ordinary staged run_command path starts its
child in a new session and signals its group only on cancellation/timeout;
local.py starts run.sh in another session. The observed watchdog notice plus
its source establishes an independently sufficient shutdown path. No historical
kernel signal trace exists here; this report does not invent an exclusive
historical sender or exclude an unobserved external signal.

The synthetic regression sources actual run.sh in source-only mode, runs its
real watcher against a disposable controller and stack, and stubs dropdb with
a local journal. It fails on the frozen code because the retained stack exits;
with the repair, the stack and stub DB survive controller exit, then changing
retention to cleanup_verified causes normal teardown. The actual local.py
record method is executed in isolation to verify producer identity fields.

Archive searches used both the literal owner-exit/retention messages and
failed_retained watchdog. The October 7 retained-stack latency and shared-sweep
cases are relatives: they protect different consumers, not this later watchdog.
Deleting the watchdog would regress strict orphan cleanup. Instead the watcher
consumes the existing producer journal with exact new controller-incarnation
bindings, rather than adding a separate retention flag or second state machine.

## Solution

The local benchmark owner journal records controller_pid and controller_start
from the same process that exports RUN_SH_OWNER_PID and RUN_SH_OWNER_START to
the isolated stack. The watchdog exempts only an explicitly failed_retained
record matching that nonempty controller incarnation, run ID, canonical context,
receipt/token scope, and this live stack's PID and cleanup token. Malformed,
missing, mismatched, ordinary and empty-incarnation records grant no exemption.
The predicate is rechecked on every original one-second watch iteration; once
retention is revoked, orphan teardown resumes. Exact-owner explicit stop remains
available through the existing teardown path.

An absent cleanup receipt does not revoke a valid explicit producer retention
decision: missing cleanup evidence is one reason recovery authority is needed.
No clean receipt, payment pass or test credit is synthesized. The new registered
regression also checks ordinary orphans, changed controller/run/stack/receipt
bindings, empty/missing controller incarnation, and the actual producer method.
The existing run-process-cleanup suite retains its SIGKILL, zombie and normal
stop controls. No timeout or assertion from that suite changed.

Parent integration exposed the structural documentation guard: the newly
registered retention test was absent from deploy Step 4s. The unchanged guard
failed with the exact missing command. Adding that command to the canonical
list makes the same guard pass; registration and assertions remain unchanged.

Nonempty /proc start ticks are currently produced only on Linux. An empty
incarnation on another platform grants no new retention exemption; this patch
does not claim exact-incarnation recovery support there. Native identity tests
exercise the Linux boundary. Status remains OPEN pending parent integration and
native gate validation; the lost original running reconciler is not recreated
by passing a synthetic regression or by restoring a forensic database dump.

## Human feedback

The user required synthetic local process/database commands, no financial or
provider calls, no edits to original worker/retained services, and strict ordinary
orphan teardown. The parent specifically required a nonempty controller start
identity and confirmation that the producer PID is local.py, not an outer shell.
The parent's forensic snapshot restoration must not be described as current
settlement or restoration of a live recovery reconciler.

## Reusable lesson

Make every orphan-cleanup consumer honor explicit recovery authority bound to the exact controller incarnation and retained stack.
