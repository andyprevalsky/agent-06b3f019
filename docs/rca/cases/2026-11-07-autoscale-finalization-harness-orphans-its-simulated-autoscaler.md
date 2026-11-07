---
id: 2026-11-07-autoscale-finalization-harness-orphans-its-simulated-autoscaler
date: 2026-11-07
title: Autoscale finalization harness exited while its simulated autoscaler still ran, leaving an orphan that made the cloudbench gate UNVERIFIED
surface: infra
component: scripts/tests/cloudbench-acceptance-autoscale.test.sh finalization harness
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "scripts/tests/cloudbench-acceptance-autoscale.test.sh finalization harness — backgrounds `( sleep 1.5; : > marker; sleep 0.5 ) &` and exits without waiting for it"
symptoms:
  - "GATE_STEP autoscale status=UNVERIFIED exit=0"
  - "\"orphaned_children\": true"
tags:
  - cloudbench
  - deploy
  - fixture
  - orphan
  - load
sources:
  - PR #1749 staged deploy, final sweep on b51156833, gate cloudbench-controller (autoscale supervisor TERMed pid 3007456)
repro: scripts/tests/cloudbench-acceptance-autoscale.test.sh (finalization harness run in its own session under CPU contention)
status: fixed
---

## Problem

In PR #1749's final deploy sweep, `cloudbench-controller` failed although every
suite printed PASS. The `autoscale` step exited 0, but its supervisor reported
`orphaned_children: true` and TERMed one leftover child, so the gate recorded
UNVERIFIED. The same source passed this step in the initial sweep.

## Diagnosis

The finalization harness simulates an autoscaler with
`( sleep 1.5; : > "$out/autoscaler.completed-after-child"; sleep 0.5 ) &`. Its
wait returns as soon as the marker appears (polling every 0.2 s). The second
phase takes about 0.3 s more, so the harness can exit before the subshell's
trailing `sleep 0.5`, which then reparents to the gate supervisor. Under CPU
contention (24 busy loops on the 8-core box), the unchanged harness left a
live child at exit in 2 of 22 runs (1/10 and 1/12). Idle, it left none in 20
runs. The PR diff touched nothing under `scripts/`.

## Solution

The harness ends with `wait`, reaping its simulated autoscalers. The
assertions and timings are unchanged. Under the same contention the fixed
harness left no child in 12 of 12 runs, and the full test passed 3 of 3.

## Human feedback

None: found and fixed inside PR #1749's deploy.

## Reusable lesson

A test harness that backgrounds a fake process must reap it before exiting.
The deploy supervisor counts any surviving descendant as an unverified run.
