---
id: 2026-07-15-unthrottled-fleet-clone-burst-exhausted-fly-org-api-limit
date: 2026-07-15
title: The fleet clone step burst Fly's org API rate limiter with no retry, failing machine creation
surface: infra
component: cloudbench-fleet
classification: third-party-failure
problem_class: concurrency-inefficiency
first_bad_boundary: run-bench-fleet clone_machine_target — issued clone calls in a burst with no backoff on rate-limit responses
symptoms:
  - "resource_exhausted: rate limit exceeded"
  - fleet machine clone fails during fan-out
tags:
  - cloudbench
  - fly
  - rate-limit
  - backoff
  - fleet
sources:
  - memory:project_cloudbench_warm_image_dep_sync
  - commit deddde9c2
repro: none-recorded
status: fixed
---

## Problem

During cloud-benchmark fleet startup the machine-clone step failed with Fly's
`resource_exhausted: rate limit exceeded`. The fan-out issues one clone call per
fleet member essentially simultaneously, so the burst exceeded Fly's
organization-level API limit.

## Diagnosis

`clone_machine_target` in `run-bench-fleet` treated the Fly clone call as a
single-shot operation: a rate-limit rejection was a terminal failure rather than
a retryable one. Because the limiter is org-scoped, the failure probability rises
with fleet size and with any sibling workspace also calling the API, so the step
was structurally unreliable at the fleet sizes actually used.

## Solution

Added exponential-backoff retry to `clone_machine_target` (commit `deddde9c2`),
so a rate-limited clone waits and re-issues instead of failing the fleet. This is
the same treatment applied to other transient Fly clone failures — the general
rule for an org-scoped third-party limiter is that every burst call site needs
backoff, not just the one that happened to fail.

## Human feedback

None recorded.

## Reusable lesson

Any fan-out that hits an org-scoped third-party API must treat rate-limit
responses as retryable with exponential backoff — burst size grows with fleet
size and with sibling workspaces sharing the same quota.
