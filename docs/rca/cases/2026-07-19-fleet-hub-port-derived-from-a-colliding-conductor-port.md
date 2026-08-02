---
id: 2026-07-19-fleet-hub-port-derived-from-a-colliding-conductor-port
date: 2026-07-19
title: Two workspaces with the same CONDUCTOR_PORT derived the same fleet hub port, so one silently reused the other's hub and aborted
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "run-bench-fleet — the dashboard hub port is derived as CONDUCTOR_PORT+5764 and any process already listening there is reused without verifying it serves this run"
symptoms:
  - 'run aborts with "not visible in the central hub"'
  - a run's RUN_ID never appears in the hub dashboard
  - two workspaces compute the same hub port (both CONDUCTOR_PORT=55130 → 60894)
tags:
  - cloudbench
  - port-collision
  - multi-workstream
  - hub
  - workspace-isolation
sources:
  - memory:project_ecommerce_slice_compute_token_gate
repro: none-recorded
status: mitigated
---

## Problem

`run-bench-fleet` derives its dashboard hub port from `CONDUCTOR_PORT+5764`.
Workspaces `canberra` and `minsk` both had `CONDUCTOR_PORT=55130`, so both computed
hub port 60894. The fleet blindly reuses ANY process already listening on that
port, so canberra silently attached to minsk's hub, its `RUN_ID` never appeared,
and the run aborted with "not visible in the central hub".

## Diagnosis

Two separate assumptions failed together: that `CONDUCTOR_PORT` is unique per
workspace (it is not — two workspaces had the identical value), and that an open
socket on the derived port belongs to this run. Because the port is _derived_
rather than allocated, collision is silent; and because reuse is unconditional, the
colliding run adopted a hub that would never know about it. The identity of the hub
was never checked against the identity of the run.

## Solution

Workaround in use: launch with `--dash-base <free-port>` (e.g. 61020) or
`CLOUDBENCH_DASH_BASE=<port>`. The real fix, recorded but not built, is to verify
that a reused hub actually serves this run's directories before trusting it —
i.e. validate hub identity instead of assuming port ownership.

## Human feedback

None recorded.

## Reusable lesson

Never trust a port derived from a supposedly-unique local variable — verify the
listener's identity before reusing it, or allocate a free port, because a silent
hub collision looks like "my run vanished".
