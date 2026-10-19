---
id: 2026-10-18-campaign-member-hub-identity-reused-cross-host-pid
date: 2026-10-18
title: Sharded campaign copies on different controllers shared one PID-derived Hub run ID
surface: infra
component: run-bench-fleet-hub-identity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "scripts/run-bench-fleet::require_in_app_hub_visibility published RUN_ID=<local second>-<pid> as the Hub run_id; identical disposable controllers reuse PID+second across hosts"
symptoms:
  - "Benchmark Hub group membership changed"
  - "Error in request ... at applyQueuedPut (benchmarkHubStore.js) path /api/benchmarks/runs POST"
  - "Staged Benchmark Hub upload cycle uploads 64 rejected 11-23"
  - "two campaign members with the same fleet run_id on different shard controllers"
tags:
  - benchmark-hub
  - identity
  - pid-reuse
  - sharded-controllers
  - campaign-group
sources:
  - hub run original600-1792319287448456235
  - fleet run 20261018-103918-16718
repro: agents/benchmarks/hub_upload_test.py::test_hub_transport_campaign_member_identity_survives_cross_host_pid_reuse
status: fixed
---

## Problem

From 10:40Z in run600c, every Hub catalog cycle rejected 11-23 of its 64 uploads
with `Benchmark Hub group membership changed` (HTTP 500). Of the 600 campaign
jobs, 531 had fleet run IDs; 24 IDs were each shared by two jobs on different
shard controllers. Examples: `20261018-103918-16718` was used by shard-01
`r001-j0002` and shard-05 `r001-j0006`, and `20261018-103918-16729` by shard-01
`r001-j0062` (PASSED) and shard-14 `r001-j0035`. 48 copies were affected. The
second member of each pair could never publish its own Hub record, live or
terminal, so its FE row and terminal publication were wrong whatever the Hub's
capacity.

## Diagnosis

`scripts/run-bench-fleet` sets `RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"`, and a
self-managed fleet published that ID as its Hub `run_id`. The 20 disposable
controllers boot the same image and start their 30 one-task controllers in
the same seconds, so their PID sequences overlap. The backend stores one record
per `run_id`. Once the first member's group fields exist,
`applyQueuedPut` rejects any upload whose `group_member_id` differs. The error
is `membership changed`, not `schedule changed`, and shard campaigns skip group
publication when `BENCHMARK_HUB_GROUP_RUN_ID` is set. That rules out the
operator/shard group-publication interplay.

The RUN_ID format itself (`[0-9]{8}-[0-9]{6}-[0-9]+`, ending in `-<pid>`) is
parsed by ownership, orphan-drain and archive tools, so the local run identity
cannot change safely.

## Solution

Campaign members publish under a membership-bound Hub identity,
`<RUN_ID>-m<sha256(group, member, attempt, RUN_ID)[:12]>`, produced by
`hub_upload.py --print-run-id`. It is persisted to `_batch/hub-run-id`, so
exact-owner recovery republishes the same record. Standalone fleets keep
`RUN_ID`. The local run directory, ownership tokens and parsers are unchanged.
The guest outcome packet already uses `BENCHMARK_HUB_PARENT_RUN_ID`, so it
follows the new identity.

At 10k agents the cost is one hash per controller and no extra Hub write.
Identity is unique per (group, member, attempt), independent of host or PID.

## Human feedback

None recorded.

## Reusable lesson

Never publish a host-local PID/time identity as a cross-host key; bind shared
records to their scheduled membership (group, member, attempt) instead.
