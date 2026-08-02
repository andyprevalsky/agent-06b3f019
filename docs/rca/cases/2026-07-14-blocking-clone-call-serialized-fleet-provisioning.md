---
id: 2026-07-14-blocking-clone-call-serialized-fleet-provisioning
date: 2026-07-14
title: Blocking clone inside the launch loop serialized 28 fleet clones into a 30-50 minute window
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: run-bench-fleet launch loop — clone was a blocking call per bench, so 28 clones ran one at a time
symptoms:
  - 28-box fleet bring-up takes 30-50 minutes before any benchmark starts
  - every transient clone/launch failure lands inside that long provisioning window
tags:
  - cloudbench
  - fly-io
  - provisioning
  - parallelism
  - fleet-barrier
sources:
  - commit fd2f6ea0d
  - memory:project_daily_suite_concurrent_iteration
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

A 28-wide cloud-benchmark fleet took 30-50 minutes just to bring machines up,
and that window was where essentially every observed failure landed — clone
races, throttles, and controller-trap aborts all occurred during provisioning
rather than during the benchmarks.

## Diagnosis

`clone` was invoked as a blocking call inside the fleet's launch loop, so the 28
clones were serialized: each bench waited for the previous machine to
materialize. Wall-clock provisioning therefore scaled linearly with fleet width,
and the long serial window both dominated the run and maximized exposure to
transient Fly errors — the longer the window, the more likely at least one clone
hit a race, and a fatal clone aborted the batch. The deeper owned cause is
coupling provisioning to launch in a single sequential pass, with no barrier
separating "all machines exist" from "start work".

## Solution

Provisioning was split into two phases (commit fd2f6ea0d): phase 1 fans out
claim-or-clone in backgrounded subshells with per-bench ledgers
(`primary.ids` / `.names`), then a barrier, then phase 2 launches. Measured
result: 27 parallel `flyctl clone`s and 28/28 machines provisioned in ~90
seconds, down from 30-50 minutes. Shrinking the window also shrank the blast
radius of the transient clone errors handled separately by clone-retry. Cemented
in `agents/benchmarks/cloudbench_dependency_sync_test.py`.

## Human feedback

The human required benchmark reruns and fleet work to be parallel rather than
serial — serial iteration burns the session budget — and required that fixes be
generalizable infra fixes with no prompt or task-definition changes.

## Reusable lesson

Fan out fleet provisioning behind an explicit barrier instead of provisioning
inside the launch loop: a shorter provisioning window is also a smaller target
for transient cloud errors.
