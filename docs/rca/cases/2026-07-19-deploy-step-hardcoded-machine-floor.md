---
id: 2026-07-19-deploy-step-hardcoded-machine-floor
date: 2026-07-19
title: Post-deploy "stop excess machines" step hardcoded MIN=2, dipping the live worker fleet after every deploy
surface: infra
component: deploy-agents-workflow
classification: configuration-error
problem_class: other
first_bad_boundary: ".github/workflows/deploy-agents.yml — the post-deploy stop-excess-machines step used a literal MIN=2 instead of deriving the floor from agents/fly.toml"
symptoms:
  - worker fleet drops to 2 machines immediately after every agents deploy
  - capacity trough until the adaptive autoscaler climbs back to the configured floor
  - deployed MIN_MACHINES in fly.toml disagrees with the machine count CI leaves running
tags:
  - fly-io
  - deploy
  - autoscaler
  - worker-pool
  - config-drift
sources:
  - PR #810
repro: none-recorded
status: fixed
---

## Problem

After every `deploy-agents.yml` run, the live worker fleet was reduced to 2
machines by the post-deploy "stop excess machines" step, even though the configured
always-on floor was much higher (15 at the time, lowered to 8 in this change). The
adaptive autoscaler then had to climb back to the real floor, leaving a needless
capacity trough on every deploy.

## Diagnosis

The CI step hardcoded `MIN=2` rather than reading the floor from the deployed
`agents/fly.toml`. The value was therefore a second, independent source of truth
for fleet capacity that no one updated when `MIN_MACHINES` changed — so the deploy
pipeline actively contradicted the deployed configuration. Because the autoscaler
eventually recovers, the symptom is a transient cold-start latency hit rather than
an outage, which is why the drift survived unnoticed.

## Solution

`deploy-agents.yml` now derives `MIN` from the deployed `fly.toml`, so CI tracks
the floor automatically and cannot drift again when the floor changes. Shipped in
the same change that lowered `MIN_MACHINES` for `navi-whisper-lux` from 15 to 8
(saving roughly $220/mo of `performance-1x` warm standby); the adaptive autoscaler
in `agents/worker.py` still bursts to `MAX_MACHINES=40` on Temporal backlog,
workflow-slot occupancy, and memory/CPU pressure.

## Human feedback

None recorded.

## Reusable lesson

Never hardcode a capacity or scaling number in a deploy step — derive it from the
deployed config, or CI will silently enforce a stale floor every time you deploy.
