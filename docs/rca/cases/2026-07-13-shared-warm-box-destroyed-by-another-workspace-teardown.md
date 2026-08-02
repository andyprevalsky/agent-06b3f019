---
id: 2026-07-13-shared-warm-box-destroyed-by-another-workspace-teardown
date: 2026-07-13
title: The team-shared `cloudbench-warm` machine and its volume snapshot were destroyed by another workspace's teardown, blocking every fleet dispatch
surface: infra
component: cloudbench-fleet
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: shared Fly app navi-whisper-lux-bench — the single warm source machine/volume is global state any workspace's teardown can destroy
symptoms:
  - "No warm machine 'cloudbench-warm' in navi-whisper-lux-bench"
  - "No complete snapshot for warm volume vol_...; create one: flyctl volume snapshots create <vol>"
  - run-predeploy-cloud clears local checks then fails at dispatch
tags:
  - cloudbench-fleet
  - fly-io
  - shared-state
  - warm-image
  - deploy-gate
sources:
  - memory:project_cloud_smoke_infra_blockers_jul2026
repro: none-recorded
status: mitigated
---

## Problem

Across the 2026-07-13/14 deploy, `run-predeploy-cloud` attempts each cleared the
local regression suite and then failed at dispatch. Attempts 1–2 failed with
`No warm machine 'cloudbench-warm' in navi-whisper-lux-bench`. Attempt 4 found the
machine back (`683e47df5094d8`) but then failed because warm volume
`vol_vwnym366kn7k8mmv` had no complete snapshot.

## Diagnosis

The fleet clones every worker from **one** persistent shared warm box — a Fly
volume + machine + git clone created once via `bash scripts/run-bench-cloud --setup`.
That box lives in the shared `navi-whisper-lux-bench` app and is not owned by any
single workspace, so another workspace's teardown can destroy it, and every other
workspace's dispatch then fails with no warm source to clone from.

Recreating the machine is not sufficient: the fleet clones
`--from-snapshot`, so a _complete_ volume snapshot must also exist (STORED SIZE ≈
VOL SIZE). That snapshot creation is the last step of `--setup`, which is why
attempt 4 got past the missing-machine error only to fail on the missing snapshot.

The underlying defect is architectural: a single non-owned global resource on the
critical path of every workspace's deploy gate, with a heavyweight,
cost-bearing rebuild.

## Solution

Rebuild via `bash scripts/run-bench-cloud --setup`, but because that is a
heavyweight, cost-bearing, team-shared mutation, confirm with the team/user before
running it. A run already in flight will finish the final snapshot step. Use the
non-cloud deterministic suites
(`agents/benchmarks/cloudbench_dependency_sync_test.py`,
`scripts/tests/cloudbench-env.test.sh`) to keep making progress while warm infra
is unavailable.

## Human feedback

The user's standing constraint was respected: rebuilding shared warm infra is an
approval-gated operation, not something to run unilaterally to unblock oneself.

## Reusable lesson

Before blaming branch code for a dispatch failure, verify the shared warm machine
_and_ a complete volume snapshot both still exist — another workspace's teardown
can delete either.
