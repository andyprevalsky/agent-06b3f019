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
