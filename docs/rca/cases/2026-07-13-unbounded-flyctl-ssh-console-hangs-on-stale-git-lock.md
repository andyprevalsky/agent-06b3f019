---
id: 2026-07-13-unbounded-flyctl-ssh-console-hangs-on-stale-git-lock
date: 2026-07-13
title: Unbounded `flyctl ssh console` calls hung forever on a reused machine holding a stale `.git/*.lock`
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: run-bench-fleet — every flyctl ssh console invocation ran with no timeout, so one blocked command stalled the whole fleet
symptoms:
  - fleet hangs at "clearing stale driver" on a reused machine
  - no progress and no error; run never advances to QUEUE→START
  - stale .git/*.lock present on the box from a previous killed run
tags:
  - cloudbench-fleet
  - fly-io
  - ssh
  - timeout
  - git-lock
sources:
  - memory:project_cloudbench_per_bench_fleet_autoscale
repro: none-recorded
status: fixed
---

## Problem

Fleet runs against a **reused** machine hung indefinitely at "clearing stale
driver": no output, no error, and no advance to the start phase. Fresh machines
were fine; only boxes that had hosted a previously killed run stalled.

## Diagnosis

Two compounding causes.

The proximate cause is on the box: a previously killed run left a stale
`.git/*.lock`, so the git command issued over SSH blocked waiting for a lock whose
owner no longer existed.

The amplifier is the harness: every `flyctl ssh console` invocation was issued with
**no timeout at all**, so a single blocked remote command translated directly into an
unbounded fleet hang with no diagnostic. (macOS has no `timeout` binary, which is
why none had been applied.)

## Solution

Bounded every `flyctl ssh console` call through a `_with_timeout` helper implemented
with perl's `alarm` (the portable substitute for the missing macOS `timeout`), and
added an explicit step to clear `.git/*.lock` on the box before use. Together these
turn an unbounded hang into either a fast success or a bounded, reported failure.

Measured effect on the fleet critical path: QUEUE→START dropped to about **80s**,
versus roughly 540s for a fresh clone and about 158s previously.

## Human feedback

None recorded.

## Reusable lesson

Bound every remote-shell invocation with an explicit timeout (perl `alarm` on macOS)
and clear stale VCS locks on reused boxes — an unbounded blocked SSH command hangs
the whole orchestration with no error.
