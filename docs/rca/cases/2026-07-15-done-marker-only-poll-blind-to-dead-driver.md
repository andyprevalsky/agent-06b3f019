---
id: 2026-07-15-done-marker-only-poll-blind-to-dead-driver
date: 2026-07-15
title: A DONE-marker-only poll loop was blind to an on-box driver that died at launch, stalling the whole 30-box barrier for an hour
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: run-bench-cloud poll loop — watched only for the DONE marker or the 3600s hard timeout, never driver liveness
symptoms:
  - "only RUNSTAMP in /data/bench.log, no first STEP, no stack.log, no processes"
  - "24/27 ready, barrier blocked, released:0 at t+30min"
  - one flaky launch stalls a 30-box batch for ~1 hour
  - '"see stack log above" points at a truncated log with no cause'
tags:
  - cloudbench
  - fleet
  - liveness
  - barrier
  - observability
sources:
  - commit 2c783b14a
repro: test_launcher_detects_dead_onbox_driver
status: fixed
---

## Problem

At 30-wide, three adjacent boxes' detached on-box driver died at launch. Live box
inspection showed only `RUNSTAMP` in `/data/bench.log`, no first STEP, no
`stack.log`, no processes, and memory fine — so not OOM; the leading suspect is Fly
API rate-limiting during the launch burst. The launcher's poll loop only watched for
the DONE marker or the 3600s hard timeout, so a dead driver spun the FULL run
timeout while the synchronized-start barrier waited on that box. Observed: 24/27
ready, barrier blocked, `released:0` at t+30min — one flaky launch stalling the
whole 30-box batch for ~1 hour.

## Diagnosis

The poll loop's completion model had exactly two terminal states — DONE marker or
global timeout — and no liveness probe, so "driver is gone and will never write
DONE" was indistinguishable from "driver is still working". The barrier then
propagated one box's silent death into a fleet-wide stall. Two aggravating causes:
the Phase-2 driver launches fired as an unstaggered SSH/API burst, which is what
triggered the early death in the first place; and the stack-health FATAL said "see
stack log above" while pointing at a truncated log, so the cause was never
recoverable from the artifacts.

## Solution

Generalizable fixes, no benchmark-definition changes:

- `run-bench-cloud`: the poll loop probes on-box driver liveness after a stall
  (`CLOUDBENCH_DRIVER_STALL_SECONDS=150`) and stops promptly when the driver is gone
  with no DONE marker, so the controller's dead-PID barrier tolerance excludes the
  box fast instead of waiting out the hour.
- `run-bench-fleet`: stagger the Phase-2 driver launches
  (`CLOUDBENCH_LAUNCH_STAGGER_SECONDS=0.5`) to cut the SSH/API burst, mirroring the
  existing clone-launch stagger.
- `cloudbench-run.sh`: the stack-health FATAL records the stack exit code, the last
  40 lines of `stack.log`, and an OOM signature.

Regression test `test_launcher_detects_dead_onbox_driver`; the barrier-plumbing test
was updated for the tolerant-release phrasing.

## Human feedback

None recorded.

## Reusable lesson

Poll for liveness, not only for a completion marker — a worker that dies before it
emits anything must be detectable, or a synchronized barrier turns one silent death
into a fleet-wide stall.
