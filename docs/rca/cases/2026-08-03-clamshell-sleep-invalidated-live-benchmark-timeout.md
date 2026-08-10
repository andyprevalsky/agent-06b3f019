---
id: 2026-08-03-clamshell-sleep-invalidated-live-benchmark-timeout
date: 2026-08-03
title: Mac clamshell sleep suspended the local live benchmark and inflated a 900-second timeout to 1759 seconds
surface: harness
component: local-benchmark-runner
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: benchmark execution environment — a live irreversible task ran on a laptop allowed to enter clamshell sleep
symptoms:
  - benchmark reports Timeout after 1759s with dynamic cap 900s
  - every local worker log has the same fifteen-minute gap
  - pmset records Clamshell Sleep during the benchmark interval
tags:
  - benchmark
  - clamshell-sleep
  - ecommerce
  - local-runner
  - timeout
sources:
  - agent 43ffeb05-a5e4-4073-9293-0c1c2870ee77
repro: macOS pmset sleep log aligned with the benchmark and all twelve local worker logs
status: mitigated
---

## Problem

The live DoorDash rerun reported a timeout after 1759 seconds even though its
dynamic cap was 900 seconds. During the run, all twelve local worker logs stopped
for the same fifteen-minute interval. macOS `pmset` recorded entry into
Clamshell Sleep at the start of that gap and wake at its end.

## Diagnosis

The benchmark did not consume 1759 seconds of active agent time. Closing the
laptop suspended the local controller and worker processes, including monotonic
timeout progress and Temporal heartbeats. On wake, the elapsed wall clock had
crossed the harness cap and the worker reported heartbeat fallout. This differs
from the archived CDP-freeze incident: there, a renderer blocked an active
worker; here, the entire host stopped running.

## Solution

The affected run is classified as invalid timeout evidence rather than repaired
by increasing the benchmark timeout. A second live rerun was prohibited because
the first run had already placed a real $35.55 order, so repeating it could
duplicate an irreversible purchase. Future local live benchmark runs must keep
the host awake and open or use a non-sleeping execution host; `caffeinate` alone
is not treated as reliable protection from clamshell sleep.

## Human feedback

None recorded.

## Reusable lesson

Do not interpret elapsed wall time across whole-host suspension as active benchmark latency, and never rerun an irreversible task merely to replace invalid timing evidence.
