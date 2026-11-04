---
id: 2026-10-29-validation-oom-stops-shared-appserver-scope
date: 2026-10-29
title: Kernel OOM events stop the shared validation appserver scope
surface: infra
component: deploy-validation-memory
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Kernel global OOM kills a Node process in the shared appserver scope; exact allocating lane and individual signal sender remain unproven
symptoms:
  - Simultaneous validation exit 143
  - global_oom
  - OOMPolicy=stop
  - Missing terminal stage records after appserver loss
tags:
  - oom
  - systemd
  - validation
  - process-lifecycle
sources:
  - PR #1634
repro: none-recorded
status: open
---

## Problem

Independent deployment validation jobs stopped together at 02:39:33 and
03:07:09 UTC on October 29. Several stages recorded exit 143; the second
frontend and backend attempts lost their terminal records. No full-suite pass
is inferred from partial output. The watcher termination file had no new row,
but the kernel journal contained both global OOM events.

## Diagnosis

Kernel diagnostics identify Node victims inside the shared appserver workload
scope at both exact windows. The first scope recorded an OOM result and killed
its remaining appserver processes after a 90-second stop timeout. The replacement
scope exposes `OOMPolicy=stop`, `KillMode=control-group` and the same timeout.
The second scope also recorded an OOM result at the interruption time.

Both snapshots show about 14.5 GiB anonymous memory, including about 5.43 GiB
shared memory, no swap and nearly exhausted reclaimable file cache. Shared
memory is included in the anonymous figure and must not be added twice. The
killed process is not proof of which allocation exhausted memory. The exact
sender of each lane's SIGTERM and per-lane peak attribution remain unrecorded.
Targeted cleanup inspection found no demonstrated sibling-process targeting.

Searches covered literal SIGTERM/143, appserver background termination and
OOMPolicy/cgroup vocabulary. Earlier detached-build parent-exit and ancestor
cleanup cases were read but their different causes were not adopted.

## Solution

No code fix or successful local reproduction is claimed. Serialize heavy
canonical validation lanes and retain their assertions, thresholds and task
timeouts as containment while measuring resource use. Do not modify platform
OOM protection, shared services or protected data. Completion of one serialized
lane would not prove every remaining lane fits.

The read-only investigation, full kernel diagnostics and scope records are
retained in `.context/pr1634-sigterm-rca/`. Its isolated, memory-bounded mechanism
reproduction is a proposal only and was not executed. Keep this case open until
the remaining attribution and safe complete validation are established.

## Human feedback

The user requested completion of deployment and skipped treasury only. They did
not waive coverage, resource failures or other normal gates.

## Reusable lesson

Check kernel and workload-unit evidence after simultaneous process loss, and do
not mistake an empty watchdog log for proof that no OOM occurred.

## November 4 recurrence (PR #1662, attempt 37)

At frozen source `8cdfa46fb82741fc15f3950cfbb44932682225f8`, the kernel
journal records global OOM killing Node PID `2053899` at
`2026-11-04T04:20:43.199095Z` in workload scope
`boxes-workload-fc982f3c184342bc820b7a434d4d6032.scope`. It recorded
15,013,056 KiB active/inactive anonymous memory, 138,604 KiB free and no
swap. The victim's exact argv, allocating lane and per-gate peak remain
unrecorded.

systemd recorded that scope's OOM and a stop timeout at `04:22:12.795063Z`,
then killed surviving appserver processes and recorded result `oom-kill`
with a reported `12.8G` scope peak. Native structural-worker journal metadata
binds its root to the same scope. These records and the live/default
`OOMPolicy=stop`, `KillMode=control-group` support scope-stop fanout; the
historical scope properties and exact initial signal sender for each vanished
coordinator/guardian PID were not retained. Do not invent individual signal
ancestry.

The watchdog separately sent TERM to backend PID `1971104` at
`04:20:46.019Z`. Its implementation signals only that positive PID. The backend
sidecar binds the same PID in `term_sent` and `reaped` with wait status zero;
this process result is not a backend test PASS and does not establish that
its TERM caused the whole cohort interruption. Six unfinished local supervisors
recorded cancellation, native exit `-9` and process quiescence; the controller
also recorded orphaned children. Process closure grants no missing recipe,
teardown or financial assertion credit. Existing PASS/SKIP rows remain, and
interrupted assertions remain UNVERIFIED.

Source introduction remains UNKNOWN comparing
`b9a1f743152e29cb6626ed33fdce88d24a919ba1` with the frozen `8cdfa46f` source:
there is no matched baseline/current aggregate-memory run. The read-only native
packet is retained at `/var/tmp/round37-memory-rca/`; its exact `diagnosis.json`
SHA256 is `16fc9cdc7b83bc4cd30af7752c55c095ac2213e391dae4112d593ad763a04092`.
No reproduction, rerun, repaired-gate success or fresh external call was made
by this investigation.

The user's November 4 correction supersedes the earlier recommendation in
**Solution** to serialize heavy canonical validation lanes: **never globally
serialize independent gates**. Preserve independent parallel execution and
existing assertions, concurrency requirements and timing budgets. Failure
reruns follow the documented deployment schedule. Additional disk and memory
backing is being prepared; it has not been validated as a repair or shown to
fit the full gate cohort. Do not change platform OOM protection or convert
capacity preparation into a PASS or waiver.
