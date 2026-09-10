---
id: 2026-09-09-campaign-synthesized-unregistered-hub-parent
date: 2026-09-09
title: Campaign scheduler synthesized an unregistered in-app Hub parent
surface: infra
component: benchmark-campaign-controller
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py main injected the local campaign ID as BENCHMARK_HUB_PARENT_RUN_ID without registering that ID in the in-app Hub
symptoms:
  - "HubVisibilityError: benchmark Hub visibility check failed: HTTP Error 404: Not Found"
  - all 10 campaign children failed before provider provisioning
  - campaign child inherited a parent Hub run that the campaign never registered
tags:
  - cloudbench
  - campaign
  - benchmark-hub
  - parent-run
  - pre-provision
sources:
  - commit b00fcbd787e8f323184031b188b46b580c9bf2a8
  - fleet run polar-streak-final-20260909
repro: scripts/tests/descend-command.test.sh
status: fixed
---

## Problem

A ten-task Polar campaign launched ten independent fleet controllers, but every
controller exited before provider provisioning. Each child first registered its
distinct local run successfully, then `hub_upload.py --verify-visible` returned
HTTP 404 for the shared campaign ID. The campaign summary recorded 10/10
failures in 2.7–3.1 seconds.

The checked-in offline repro failed before the fix with
`AssertionError: campaign child inherited a parent Hub run that the campaign
never registered`. Instrumentation showed an empty inbound parent at campaign
entry and `parent_run_id=repeat-short` for all four launched children.

## Diagnosis

Critical path: `scripts/run-bench -k/--concurrency` → campaign scheduler →
per-job environment → child `scripts/run-bench` → `scripts/run-bench-fleet` →
`require_in_app_hub_visibility` → inherited-parent verify-only branch → in-app
Hub GET.

The first bad value appeared when the scheduler set
`BENCHMARK_HUB_PARENT_RUN_ID` to its filesystem campaign ID. The scheduler never
creates an in-app Hub run, so presence of that variable falsely asserted both
ownership and prior visibility. The fleet controller correctly treats a real
inherited parent as already registered and therefore verified the nonexistent
campaign ID instead of registering its own `RUN_ID`.

The deepest owned cause was a lifecycle-contract inconsistency: a scheduling
identifier was promoted to Hub resource ownership without the create operation
that makes that ownership valid. The offline before/after log comparison rejects
ambient environment inheritance: campaign entry had no parent before either
run; only the buggy scheduler synthesized one. Archive searches for
`hub_upload verify-visible HTTP 404 BENCHMARK_HUB_PARENT_RUN_ID` and `campaign
inherited parent visible aggregate local hub registration` found related Hub
visibility cases but no recurrence of this campaign boundary.

## Solution

The campaign scheduler no longer manufactures
`BENCHMARK_HUB_PARENT_RUN_ID`. Every independent fleet child now enters the
existing self-managed branch, uploads and verifies its own aggregate before
provider provisioning, then exports that verified run ID to its per-machine
benchmark children. A genuine visible parent supplied by an outer controller is
still preserved, so ordinary fleet aggregation is unchanged.

The always-run Descend Command offline e2e captures each fake fleet child's
parent environment and requires it to be empty for a scheduler-owned campaign.
This also prevents repeated campaigns and named-slice campaigns from skipping
their own registration. At 10,000 agents, the change adds no polling, shared
state, or per-agent work; it creates one existing Hub aggregate per fleet
controller, bounded by campaign concurrency.

## Human feedback

The user required preserving ordinary fleet aggregation, making concurrent
campaign children register valid visible Hub runs before provisioning, adding
the regression to the existing always-run Descend Command test, and avoiding
the paid Polar campaign.

## Reusable lesson

Never encode parent-resource ownership with an identifier unless the corresponding parent resource was created and verified.
