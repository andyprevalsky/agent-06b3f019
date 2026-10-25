---
id: 2026-10-25-runner-spun-forever-on-stopped-controller-after-suspend
date: 2026-10-25
title: Shard runner probed a stopped controller forever after a host suspension lost the export download
surface: infra
component: cloudbench-original600-runner
classification: our-bug
problem_class: unbounded-wait-on-unreachable-owner
first_bad_boundary: scripts/cloudbench-original600-runner.py:run (joined gate + unverified export + failing probes had no native-state exit)
symptoms:
  - "failed suite #1: could not copy /tmp/gate/step-1.log"
  - GATE_EXPORT_PENDING machine=<id>; host retained, no release credit
  - "gate.pending.json PENDING_EXTERNAL_OWNER_LIVE export_verified false"
  - "supervisor-read-pending-*.json {\"error\": \"CaptureFailure\", \"no_gate_signal\": true} every 5 s"
  - controller Machine stopped (restart policy no)
tags:
  - cloudbench
  - controller-export
  - sharded-original600
  - devbox-suspend
sources:
  - /descend descend-full69-20261023, run original600-1792892410529043326 shard-00 (machine 839523a7d47528, volume vol_4oj6l226e0gzg39r, source 016fca859)
repro: scripts/tests/original600-portable-operator.test.py (Portable.test_stopped_controller_with_unverified_export_publishes_recovery_then_releases, test_stopped_controller_without_recovered_export_stays_owner_and_never_releases, test_started_or_replaced_controller_never_counts_as_stopped)
status: fixed
---

## Problem

The shard-00 campaign finished at 02:25Z and the on-host collector finished
`controller-host-custody/originals.tar.gz` at 02:27Z. The devbox was suspended
from 00:17Z to 04:36Z, so the gate's export download never completed. The gate
returned export-pending, its keep-alive ended and the controller stopped at
03:56:50Z. Every later supervisor probe failed with an exec error. The runner
handled only JOINED and NOT_PUBLISHED probe states, so it wrote a pending-read
receipt every five seconds indefinitely and never pointed to a recovery path.

## Fix

Once the gate has joined and probes have failed for `STOPPED_PROBE_GRACE_S`
(60 s), the runner reads the exact native Machine. If the same instance is
`stopped` or `destroyed`, it writes `export-recovery-required.json`
(`EXPORT_RECOVERY_REQUIRED_CONTROLLER_STOPPED`) with a link to the operator
procedure, and it stays alive as the cleanup owner. A stopped instance runs no
writer, so the runner treats it as settled. After the recovery publishes the
canonical verified export, the runner reads the Machine again and calls its
own `cleanup` once. It ends with `CONTROLLER_STOPPED_RELEASE_VERIFIED`. A
started or replaced instance is never treated as stopped.

Recovery is documented in `docs/original600-operator-cli.md` ("Recover a stopped
controller's retained export"). Fork the volume, mount the fork on an inert
scratch Machine, download the collector's originals, then run the helper's
`export-ready`. Do not start the controller: its init reruns gate.sh against
the evidence volume.

## Verification

The new tests fail on 016fca859 ("runner spun on a stopped controller") and
pass with the fix. The full `original600-portable-operator` structural gate
passed 5 consecutive runs. The live shard-00 evidence was recovered this way:
6,242 of 6,242 manifest members verified, then the controller was destroyed
and the volume reached pending_destroy.

## 10k-agent behavior

This adds one native GET at most every 30 s per stuck controller, and only
after the gate joins. Healthy runs make no extra provider calls.
