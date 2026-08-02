---
id: 2026-07-19-boot-fast-mode-schema-ensure-had-no-pooler-retry
date: 2026-07-19
title: The one boot DB call without a retry (Fast Mode cache-schema ensure) killed bench boxes when the shared prod pooler saturated
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: 'scripts/run.sh boot step "Ensuring Fast Mode cache schema" — connects to the shared prod Supabase pooler with no retry, under set -e'
symptoms:
  - "Timed out fetching a new connection (pool timeout: 10)"
  - bench box dies during boot before reaching the start barrier
  - failure appears only when a concurrent neighbour fleet is running
tags:
  - cloudbench
  - prisma
  - connection-pool
  - retry
  - fast-mode-cache
sources:
  - commit fb6b889dc
  - memory:project_ecommerce_slice_compute_token_gate
repro: none-recorded
status: fixed
---

## Problem

Bench boxes died during boot with Prisma
`Timed out fetching a new connection (pool timeout: 10)`. The failing step was
`run.sh`'s `Ensuring Fast Mode cache schema`, which connects to the SHARED prod
Supabase pooler (`FAST_MODE_CACHE_DATABASE_URL`, default = prod). Under a
concurrent fleet (8 own boxes plus a ~50-machine neighbour) the pooler saturates,
the connection acquisition times out, and `set -e` kills the box before it can
reach the synchronized-start barrier.

## Diagnosis

Every other boot-time DB call (seed sync, credential sync) already retried 3×;
this was the ONLY boot DB call without a retry, so it was the single point where
transient pooler contention became a fatal box death. The underlying design issue
is that a per-box boot step reaches into a shared production pooler at all, so its
failure probability scales with total concurrent bench width across all
workspaces, not with this run.

## Solution

Added a 5× backoff retry around the boot Fast Mode cache-schema ensure
(commit fb6b889dc), matching the retry posture of the neighbouring sync steps.
The designed decoupling already exists — `FAST_MODE_CACHE_USE_LOCAL=1` keeps the
cache schema off the shared pooler — but it is not wired for cloud bench, which
remains the durable fix. A related observation from the same session: the human's
own premature relaunch during a prior run's teardown was what tipped the pooler,
so overlapping your own runs is a contention source independent of neighbour size.

## Human feedback

The human's rule-27 discipline held throughout: the ~42–50-machine neighbour fleet
on the shared bench app was never killed or collided with, and a rerun proving 8/8
at neighbour=42 was used to establish that neighbour SIZE was not the blocker.
The operating rule taken away: always wait for your own controller PID to exit
before relaunching.

## Reusable lesson

Any boot-time call to a shared pooler needs the same retry/backoff as its
neighbours — one unretried DB call is enough to convert transient contention into
a dead box, and a single missing retry is the first thing to look for when only
concurrent runs fail.
