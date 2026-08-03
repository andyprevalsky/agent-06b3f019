---
id: 2026-07-14-fleet-controller-dies-with-launcher-process-group
date: 2026-07-14
title: Fleet controller shared the launcher's process group, so ending the session tore down 28 machines
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: run-bench-fleet ran in the launching agent session's process group instead of its own session
symptoms:
  - 28-machine fleet torn down the moment the launching agent session exited
  - controller process disappears with no cleanup log of its own
tags:
  - cloudbench
  - process-group
  - setsid
  - teardown
  - fly-io
sources:
  - commit 87ddfd3b9
  - memory:project_daily_suite_concurrent_iteration
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

A running 28-machine cloud-benchmark fleet was destroyed not by any failure in
the run but by the launching agent session ending: the controller died with the
launcher's process group and the whole fleet was torn down mid-iteration.

## Diagnosis

`run-bench-fleet` inherited the launcher's process group, so any signal
delivered to that group (as happens when the launching session terminates) also
hit the long-lived controller. The controller was expected to outlive its
launcher — it owns paid machines for the length of a multi-minute-to-hour run —
but nothing detached it. macOS has no `setsid(1)`, so the usual shell trick was
unavailable and the detachment had never been implemented.

## Solution

Added `--detach` to `run-bench-fleet`, which re-execs via
`cloudbench_detach_reexec` (fork → `setsid` → exec, implemented in-process
because macOS lacks the `setsid` binary) _before_ taking args or locks, so the
controller runs in its own session; `launch-iter.sh` uses it (commit 87ddfd3b9).
Cemented in `agents/benchmarks/cloudbench_dependency_sync_test.py`. Ordering
matters: detaching before locks means the surviving process is the lock holder.

## Human feedback

None recorded.

## Reusable lesson

Any controller that owns paid remote resources across a long run must re-exec
into its own session before acquiring locks, so its lifetime is independent of
whatever shell or agent session launched it.
