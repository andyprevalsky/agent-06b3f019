---
id: 2026-07-16-per-box-launch-ssh-sequence-killed-drivers-at-launch
date: 2026-07-16
title: The ~7-ssh-per-box launch sequence saturated Fly's Machines API at 30-wide and killed drivers at launch
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: "run-bench-cloud launch path — start + ssh-ready + clear-stale + stage + launch + confirm was ~7 ssh calls per box, all through the Machines API"
symptoms:
  - detached on-box driver dies at launch at 30-wide fleet width
  - Fly Machines-API throttling during the launch burst
  - "boxes never emit a first STEP after RUNSTAMP"
tags:
  - cloudbench
  - fly-io
  - rate-limit
  - boot-launch
  - fleet
sources:
  - memory:project_cloudbench_boot_launch
repro: none-recorded
status: fixed
---

## Problem

At 30-box fleet width the per-box launch sequence (start, wait for ssh-ready,
clear stale locks, stage the run script, launch, confirm) cost roughly 7 ssh
calls per box. That burst saturated Fly's Machines API and killed drivers at
launch — boxes came up, wrote `RUNSTAMP`, and never emitted a first STEP.

## Diagnosis

Every step of launch was implemented as a control-plane round trip, so the
API cost of starting the fleet scaled linearly with fleet width and collided
with the same rate limit the fleet needed for its own repair calls. Once
throttled, the launch handshake failed silently and the box simply never ran the
driver; the controller had no cheaper channel to start work with.

## Solution

Boot-launch: the launch payload is attached to the machine itself instead of
being pushed over ssh —
`flyctl machine update --env <per-run params> --file-local /cloudbench-boot.sh=scripts/cloudbench-boot.sh --command "bash /cloudbench-boot.sh"`
then `start`. The box auto-runs the driver on boot with ZERO launch ssh, and
progress is read over the data-plane status proxy (`flyctl proxy` → on-box
`python3 -m http.server /data`). Gated by `CLOUDBENCH_BOOT_LAUNCH` (fleet default
1; 0 restores the legacy ssh path). Validated end-to-end on a single real box:
the boot script clears stale git locks, fetches the ref via
`CLOUDBENCH_GITHUB_TOKEN_B64` → `http.extraheader`, reaches `verified checkout`,
and the driver proceeds git_sync → env_decode → dep_sync. Supporting fixes in the
same change: hoist `LIVE_BACKEND_PORT` and `CLOUDBENCH_API_KEY` before the launch
branch (`set -u` crash otherwise), and have the boot script clear
`.git/index.lock` and `cloudbench-fetch.lock` — skipping that clear makes
checkout HANG at fleet width. Teardown was also parallelized
(`xargs -P 12 flyctl machine destroy`, ~10min serial → ~30s).

## Human feedback

The human's fleet rules constrained the work: never kill a controller's children
directly (TERM only the controller PID and let its traps reap clones), and never
touch a shared bench machine another workspace may own.

## Reusable lesson

Do not implement fleet launch as a per-box control-plane ssh handshake — attach
the boot payload to the machine and let it self-start, so launch cost does not
grow with fleet width and cannot exhaust the provider's API budget.
