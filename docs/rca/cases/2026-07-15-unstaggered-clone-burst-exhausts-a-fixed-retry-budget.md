---
id: 2026-07-15-unstaggered-clone-burst-exhausts-a-fixed-retry-budget
date: 2026-07-15
title: 30 simultaneous machine clones tripped Fly's rate limit and a fixed 8s/3-attempt retry dropped boxes from the batch
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "run-bench-fleet clone_machine_target + provision loop — 30 concurrent flyctl machine clone calls with a fixed 8s, 3-attempt retry"
symptoms:
  - "resource_exhausted: rate limit exceeded on flyctl machine clone"
  - rate limit exceeded on create-volume during fleet provisioning
  - 3 clones exhaust their retries and drop out of a 30-box batch
tags:
  - cloudbench
  - fly-io
  - rate-limit
  - retry-backoff
  - fleet-provisioning
sources:
  - commit 2c783b14a
  - memory:project_daily_fleet_barrier_driver_death
repro: test_clone_burst_is_rate_limit_resilient
status: fixed
---

## Problem

Provisioning the 30-task daily fleet fired 30 simultaneous `flyctl machine clone`
calls. Fly returned `resource_exhausted: rate limit exceeded` on clone and on
create-volume; the retry policy was a fixed 8-second wait with 3 attempts, which
three clones exhausted, so those boxes silently dropped out of the batch before
the run even started.

## Diagnosis

The provisioning loop treated cloning as embarrassingly parallel and the retry as
a formality. Two properties made it fragile: the launch burst was unthrottled, so
the fleet created its own rate-limit condition; and the retry was constant-delay
with a small fixed attempt count, so every retrying clone retried in lockstep at
the same instant the limit was still saturated. A constant-delay retry against a
rate limit you yourself caused cannot converge.

## Solution

Stagger the launches (`CLOUDBENCH_CLONE_LAUNCH_STAGGER_SECONDS=0.4`) so the burst
is spread, and replace the fixed wait with exponential backoff plus jitter over 5
attempts. Regression test `test_clone_burst_is_rate_limit_resilient`. The same
change set also staggered Phase-2 driver launches, since both bursts draw on the
same Machines-API budget.

## Human feedback

None recorded.

## Reusable lesson

Against a provider rate limit, stagger the fan-out and use jittered exponential
backoff — a fixed-delay, low-attempt retry makes every throttled caller retry in
lockstep and quietly drops work from the batch.
