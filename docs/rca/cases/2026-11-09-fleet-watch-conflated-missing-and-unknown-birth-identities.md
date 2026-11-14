---
id: 2026-11-09-fleet-watch-conflated-missing-and-unknown-birth-identities
date: 2026-11-09
title: Fleet child watch accepted uncaptured launch identities and treated unreadable known identities as exited
surface: infra
component: run-bench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet launch_fleet_bench_child accepts empty child_start, and fleet_child_pid_is_ours collapses missing identity to PID membership and unknown later observation to false
symptoms:
  - UNCAPTURED_REUSED_PID_COUNTED
  - PREMATURE_WATCH_EXIT checks=1
  - failed launch identity capture permits LAUNCH_RETURNED
  - unknown later read can prematurely leave infra-stop watch
tags:
  - fleet
  - infra-stop
  - process-identity
  - pid-reuse
sources:
  - PR #1881 review comment 4516619764
  - commit ac528ddae20f5da7fb9069d4778f024315047bf5
  - commit 1c7fe255d7fcb32d8eda884ed4dba209b3edefe2
repro: scripts/tests/campaign-hub-grouping.test.ts focused fleet launch handles, uncaptured identity, and unknown identity observation cases; final-red.log and final-repeat-1.log through final-repeat-5.log
status: fixed
---

## Problem

CodeRabbit comment https://github.com/Rose-Ai-Labs/rose/pull/1881#discussion_r4516619764
identified two remaining observation failures on exact head ac528dd. When launch
capture returns empty, the fallback can count a different live child whose
numeric PID was reused. When a known child's later read is unknown, the watch
can return before a subsequent wait blocks, preventing future infra-stop checks.

## Diagnosis

Critical path: launch supervisor -> read and store child birth -> watch each
unfinished child -> evaluate infra stop -> reap exits. The first bad boundaries
are the accepted empty launch record and the boolean identity match. Neither
jobs-table membership nor parent PID identifies an original process incarnation.
An unreadable observation does not establish absence.

Native focused repro on the exact baseline returned exit 1 with three failed
assertions: failed launch nevertheless printed LAUNCH_RETURNED, an uncaptured
reused controller child printed UNCAPTURED_REUSED_PID_COUNTED, and unknown
observation printed PREMATURE_WATCH_EXIT checks=1. Two neighboring launch controls
passed. No provider or benchmark service was contacted.

Archive searches: `failed capture PID reuse fleet_child_pid_is_ours` and
`unknown identity infra stop run-bench-fleet`. Related cases are
2026-10-02-cloudbench-pid-birth-identity-shifts-after-vm-fork (retain kernel birth
identity and existing observation semantics) and
2026-10-23-campaign-runner-lacked-fixed-total-infra-stop (keep the owning runner
checking the fixed schedule threshold). This is a related new boundary defect;
neither existing case captured these observation-state conflations.

Git blame attributes the fallback to 1c7fe255 and the new boolean recorded-birth
branch to ac528dd, both PR repair commits. Gate: INTRODUCED in PR 1881, not an
external provider exception. Worker changes repair the native baseline failure.

## Solution

After registering the child for existing EXIT cleanup, stop the launch loudly
when capture is empty and the supervisor has not already published completion.
Never accept an empty birth in the watch. Reuse cloudbench_pid_birth_state so live
and unknown remain under observation, and only confirmed absence/replacement
leaves the watch. Normalize legacy expected lstart whitespace to match that
shared helper. No infra threshold, scheduled denominator, benchmark definition,
timeout, concurrency, prompt, cleanup ownership or remote operation changes.

The existing owning command `bash scripts/tests/campaign-hub-grouping.test.sh`
passes 42/42, including the unchanged 1/40 versus 2/40 threshold test. Six new
cases pass five consecutive runs: failed capture, already-finished capture,
successful capture, uncaptured reused PID, legacy whitespace, and unknown later
observation. Shell syntax, diff whitespace, and test-file Prettier checks pass.

The existing shell wrapper is registered by deploy-structural-gates as
benchmark-campaign-grouping; both edited source files select that gate. The
selector's --lanes-for direct TS query only checks registered roots and does not
follow wrappers; its wrapper query passes. No gate was added or removed.

Golden reference: not applicable (no approval-gated hunk). Parent independently
reviewed the fix and requested reuse of the existing tri-state helper, applied
and revalidated. Commit/merge and final review remain the parent deploy's work.
This case is staged outside the checkout to respect the worker's two-file scope.

## Human feedback

None recorded.

## Reusable lesson

Missing capture is an invalid launch contract; an unreadable observation of an
already-recorded birth is unresolved liveness. Preserve those distinct states
instead of substituting numeric PID ownership or boolean mismatch.
