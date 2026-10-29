---
id: 2026-10-20-preterminal-infra-failure-waited-runtime-evidence-backstop
date: 2026-10-20
title: Declared bench.log read failure waited the 7200 s runtime-evidence backstop, keeping the job running for 2 h
surface: infra
component: run-bench-cloud
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud post-loop block called cloudbench_collect_runtime_evidence with the BENCHMARK_WALL_CLOCK_BACKSTOP_SECONDS (7200) budget after the poll loop had already declared a pre-terminal infrastructure failure, without first requesting the authenticated guest shutdown that is the only thing that seals the evidence
symptoms:
  - "❌ bench.log could not be read after 5 bounded retries -- infrastructure failure"
  - "❌ guest cleanup unconfirmed: status proxy is not running"
  - job stays running for ~2 h after a declared infrastructure failure until the campaign deadline TERM
  - "err context deadline exceeded" in the controller Fly agent log for one guest's 6PN address
tags:
  - cloudbench
  - fleet
  - runtime-evidence
  - data-plane
  - hang
  - wall-clock-backstop
sources:
  - fleet run 20261020-043620-26484
repro: scripts/tests/cloudbench-preterminal-infra-release.test.py
status: fixed
---

## Problem

Polar batch 1 job r002-j0026 (polar-odysseys-b21a86441ddc) logged
`bench.log could not be read after 5 bounded retries -- infrastructure failure`
at 05:02:32Z, then stayed `running` until the campaign deadline TERM at
06:56:31Z; only then did the child print `Terminated`,
`guest cleanup unconfirmed: status proxy is not running` and
`Original exit code: 125`. Evidence (archived in
`/home/boxes/polar-600-resume/batch1-monitor/j0026-evidence/`):
`remote-logs/bench-log-read-failures.json` (five curl_exit=1 reads,
05:00:18–05:02:32), `benchmark-child.finished`=143 written 06:56:41,
`guest-native-stop.json` (stop requested 06:56:32, verified stopped 06:56:39),
and the guest event log (started 04:37:36, no exit until the 06:56:33 stop).

## Diagnosis

1. Data plane: the controller's Fly agent log shows every connect to guest
   `[fdaa:…:e099:2]:8011` returning `ok` until 04:59:36, then
   `err context deadline exceeded` until 05:21:31, after which port 3003 was
   `connection was refused`. Ten other guests through the same agent and
   WireGuard peer (`interactive-08001dea711098-…`, distinct from the devbox's
   `interactive-boxes-…` peer) stayed `ok` throughout, so the boxes.dev devbox
   restart at ~04:58Z was coincidental: nothing on the controller data path
   depended on it. The guest VM itself stopped answering on 6PN without any
   Fly-visible exit (Fly guest log shows only children reaped with SIGTERM at
   05:18:38). Why the guest stalled is not reproduced (observability gap: no
   in-guest kernel/memory log was captured before destroy).
2. The poll loop correctly declared infrastructure failure after five bounded
   reads (`cloudbench_log_read_gate` → 20) and broke with `DRIVER_DIED=1`.
3. First bad boundary: the post-loop block only requested the authenticated
   guest shutdown for `TIMED_OUT=1`. For a pre-terminal infra failure it went
   straight to `cloudbench_collect_runtime_evidence` with a 7200 s budget. That
   collector retries transport errors and HTTP 409 until the guest seals, and
   only a delivered shutdown (or a natural driver exit) seals it. With the data
   plane black-holed it looped until 05:02:32 + 7200 s; TERM arrived at 06:56:31
   first. The same hang applies to a live driver with a healthy data plane
   (e.g. a local progress-state failure) and to "Fly machine is explicitly no
   longer running".

## Solution

`scripts/run-bench-cloud` now marks every poll-loop infrastructure break that
can happen while the driver may still be running
(`PRETERMINAL_INFRA_FAILURE=1`: progress-state failures, backlog failures,
bench.log read-gate failures, Machine no longer running). The post-loop block
handles those like a timeout: it requests the bounded authenticated shutdown
first; if that is not confirmed it exits 70 immediately (the EXIT trap reuses
`GUEST_SHUTDOWN_RESULT`, reports 125 and the fleet natively stops the exact
guest); if it is confirmed, the guest seals and the existing collector runs.
The verdict remains infrastructure failure either way. Regression:
`scripts/tests/cloudbench-preterminal-infra-release.test.py` (registered in
`scripts/test.sh`) runs the real read-failure branch and the real post-loop
block against a black-holed data plane and a live driver; both waited for the
backstop on main and exit 70 in about 3 s and 0.1 s after the fix. 10k-agent
behavior: one bounded POST plus at most `CLOUDBENCH_CHILD_TERM_SECONDS` of
polling per failed child, no new shared state.

## Human feedback

None recorded.

## Reusable lesson

When a poll loop declares infrastructure failure before the guest is terminal, request the bounded shutdown that seals its evidence before waiting for that seal, and never spend the wall-clock backstop waiting for a seal nobody requested.
