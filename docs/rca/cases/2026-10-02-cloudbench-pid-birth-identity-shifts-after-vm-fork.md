---
id: 2026-10-02-cloudbench-pid-birth-identity-shifts-after-vm-fork
date: 2026-10-02
title: Cloudbench PID birth identities came from Linux ps lstart, which every live process changes after a VM snapshot fork steps the wall clock
surface: infra
component: cloudbench-fleet-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench_pid_start_time / script_snapshot_current_pid_start / agent_link_server._pid_start_time / cloudbench-port-lease.py / cloudbench-script-snapshot.py mint and verify process birth identities with `ps -o lstart=`, which Linux procps renders from the kernel's current boot-time estimate rather than a value fixed at fork
symptoms:
  - "❌ script snapshot owner birth drifted from sealed identity"
  - "FAIL: mandatory autoscaler attach budget must not run while its primary is intentionally stopped behind the boot-config barrier"
  - "⚠️  central hub on :40192 has no exact owner proof; leaving it untouched"
  - "cloudbench-multi-workstream.test.sh blocked in wait(1) on a live test Hub after the failure"
  - "Could not capture the process table for owned tree teardown (first fix, failed controllers only)"
tags:
  - cloudbench
  - process-identity
  - vm-fork
  - deploy-gate
sources:
  - PR #1341
repro: scripts/tests/cloudbench-pid-identity.test.sh replays a +143s wall-clock step with a ps shim; the pre-fix tree fails 4 checks (live owner, Hub owner record, script-snapshot owner, and a live port lease reaped as stale) and the fixed tree passes all
status: fixed
---

## Problem

During `/deploy` run `20261002-213707-2123940`, the 4cb lane's
`cloudbench-multi-workstream` scenario 2b2 printed `1/1 passed`, but the
controller then exited nonzero with `script snapshot owner birth drifted from
sealed identity`. The test's EXIT cleanup then blocked in `wait` for more than
10 minutes on a live test Hub, and the lane had to be terminated by PID.

## Diagnosis

### Evidence

- `dmesg` shows `random: crng reseeded due to virtual machine fork` at 22:10
  (the Cloud Agent VM was snapshotted mid-run).
- The live test Hub 2235458 had `pid_start=Fri Oct 2 22:03:07 2026` in its
  owner file. After the fork, `ps -p 2235458 -o lstart=` reported
  `Fri Oct  2 22:05:30 2026` for the same live PID, a shift of +143s.
  `/proc/2235458/stat` start tick 8938378 is unchanged and gives
  `btime + 89383s`, which is the new value.
- procps renders lstart as the current boot-time estimate plus the start tick.
  A wall-clock step after a pause moves that estimate, so every live process's
  lstart moves with it.
- The test hub teardown checks `cloudbench_pid_matches_start` before sending
  TERM. The check failed, so TERM was skipped, and the following `wait` on
  the still-running child never returned.
- The same mismatch makes `registry_owner_alive` report a live fleet as dead,
  `cloudbench-port-lease.py` reap a live lease, and the capacity-reservation
  sweep delete a live reservation.

### Root cause

PID birth identity is meant to be fixed for one process incarnation. Linux
`ps -o lstart` is derived from the wall clock, so it is not stable. On macOS
lstart is recorded once at fork and is stable, which is why the scheme worked
on developer Macs.

## Solution

On Linux, every cloudbench producer now mints
`proc-start:<boot_id>:<start tick>` from `/proc/<pid>/stat`. The producers are
`cloudbench_pid_start_time`, the detached session leader, run-bench-fleet's
pre-library script-snapshot identity and `fleet_pid_start_time`, the Hub owner
record, and the port lease. The teardown process table and observations read
the same `/proc` record. Verifiers dispatch on the recorded format, so `lstart`
records written by an older controller keep their original meaning. Fleet
registry records keep the edge-trimmed `lstart` spelling on macOS so that
live owners from older controllers stay alive in the shared registry.

`scripts/tests/cloudbench-pid-identity.test.sh`, called from
`cloudbench-env.test.sh` (deploy lane 4cb), replays a +143s step with a ps
shim. It requires every producer to emit the same identity, every verifier to
keep matching live owners across the step, a live port lease to survive a
neighbor's reap, and exited owners to stop matching.

### Follow-up: identity helpers inside EXIT traps

The first version of the fix ended `cloudbench_process_birth_table`,
`fleet_pid_start_time`, and `fleet_pid_matches_start` with a bare `return`.
Fleet teardown calls them from the controller's EXIT trap, and there a bare
`return` reports the status from before the trap, which is the controller's own
exit code. Every fail-closed autoscaler controller in the multi-workstream
test, plus scenario 16's provisioning runs, logged
`Could not capture the process table for owned tree teardown`
and orphaned its snapshot and aggregator loops to init: 11 leaked loops in one
run. After a successful run (pending status 0), a dead `proc-start` owner would
read as alive. Those tests only asserted the nonzero exit, so they passed.

Each helper now ends with the scanner or matcher as its last command. The
identity test runs teardown and matching from an EXIT trap with pending status
0 and 3. On the first fix it reports `fleet-dead=match` at status 0 and
`table=failed teardown=failed loop=alive` at status 3. With the fix every
check passes. `cloudbench-multi-workstream.test.sh` now fails if any controller
log reports a teardown survivor, or if any controller process outlives its run.

`scripts/setup-db.sh` still uses lstart. There, descendant identities are
captured and re-verified within one bounded teardown, so the exposure is a
fork inside that teardown window rather than across a run.

## Human feedback

None recorded.

## Reusable lesson

A process birth identity must come from a value the kernel fixes at fork. On
Linux that is the `/proc/<pid>/stat` start tick. `ps -o lstart` is a rendering
of the wall clock, and it changes for every live process whenever a VM pause
or NTP step moves that clock.

A shell helper that teardown can reach from a trap must not end in a bare
`return`. Make the command whose status matters the last command.
