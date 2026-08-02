---
id: 2026-07-25-port-collision-check-counted-a-skipped-wmh-port
date: 2026-07-25
title: The strict port-collision check counted `WMH_PORT` even when WMH was skipped, aborting local stack startup
surface: harness
component: run-sh
classification: our-bug
problem_class: other
first_bad_boundary: scripts/run.sh strict-port collision check included WMH_PORT unconditionally, even under BENCHMARK_SKIP_WMH_BUILD=1
symptoms:
  - "Port range occupied" aborts local stack startup
  - a sibling workspace holding base+6 blocks a stack that never serves that port
tags:
  - run-sh
  - ports
  - local-stack
  - conductor-workspaces
sources:
  - PR #860
  - memory:project_worldmodelmode_prod_migration_drift
repro: none-recorded
status: fixed
---

## Problem

Local stack startup aborted with "Port range occupied" because a sibling
workspace (Spotify) held base+6 — port 55056 — even though the starting stack had
`BENCHMARK_SKIP_WMH_BUILD=1` and would never bind that port.

## Diagnosis

`scripts/run.sh`'s strict port-collision check enumerated the whole per-workspace
port range including `WMH_PORT`, without consulting whether the world-model
harness would actually be served in this invocation. A skipped service therefore
still contributed a hard precondition, so an unrelated workspace's use of that one
port was enough to block startup. The deeper owned cause: the preflight check's
notion of "ports we need" was static instead of derived from the same predicate
that decides which services run.

## Solution

`WMH_PORT` is now excluded from the collision check unless
`should_serve_world_model` would actually serve it — the check derives its port set
from the same predicate that starts the service, so skipped services stop
contributing preconditions. Shipped as a side fix in PR #860.

## Human feedback

None recorded.

## Reusable lesson

Derive a preflight's required-resource set from the same predicate that decides
which services start — a check that reserves ports for skipped services turns
harmless neighbor activity into a hard failure.
