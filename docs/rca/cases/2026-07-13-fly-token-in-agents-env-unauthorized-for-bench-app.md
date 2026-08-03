---
id: 2026-07-13-fly-token-in-agents-env-unauthorized-for-bench-app
date: 2026-07-13
title: `FLY_API_TOKEN` in agents/.env was unauthorized for machine/volume ops on the bench app while the CLI's own config token worked
surface: infra
component: cloudbench-fleet
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/.env FLY_API_TOKEN (prefix FlyV1 fm2_lJ...) — unauthorized for machines/volume-snapshot ops on navi-whisper-lux-bench
symptoms:
  - "flyctl machines list returns unauthorized"
  - "flyctl volume snapshots list/create returns unauthorized on navi-whisper-lux-bench"
  - cannot inspect Fly state or create the warm volume snapshot to unblock dispatch
tags:
  - fly-io
  - credentials
  - token-scope
  - cloudbench-fleet
sources:
  - memory:project_cloud_smoke_infra_blockers_jul2026
repro: none-recorded
status: fixed
---

## Problem

While trying to unblock the cloud smoke gate, every diagnostic Fly call failed:
`flyctl machines list` and `flyctl volume snapshots list` / `create` on
`navi-whisper-lux-bench` all returned `unauthorized` when using the
`FLY_API_TOKEN` from `agents/.env` (prefix `FlyV1 fm2_lJ...`). This made the
warm-infra state unverifiable and the missing warm volume snapshot
uncreatable — it looked like a hard credential escalation.

## Diagnosis

The token in `agents/.env` is scoped such that the fleet's clone path works but
machine-listing and volume-snapshot operations on the bench app do not. A
different, working token already existed on the machine: the `access_token` in
`~/.fly/config.yml` (account `andyprevalsky@yahoo.com`).

`run-bench-fleet`'s `resolve_fly_token` already prefers `~/.fly/config.yml` over
`agents/.env`, which is why the fleet could clone while the ad-hoc CLI calls —
which picked up the env var — could not. The failure was therefore a token-
resolution mismatch between the harness and the operator's shell, not a missing
credential.

## Solution

Pin the token explicitly rather than relying on resolution order: set
`FLY_BENCH_API_TOKEN=<the ~/.fly/config.yml access_token>` (priority 1 in
`resolve_fly_token`). With it, machines, volumes, and snapshots list correctly and
the snapshot selector picks `vs_yN5ma3O2VJGh1g42evpm`.

## Human feedback

None recorded.

## Reusable lesson

Before escalating a Fly `unauthorized` as a missing credential, try the CLI's own
`~/.fly/config.yml` `access_token` and pin it via `FLY_BENCH_API_TOKEN` — the env
token may be scoped for cloning only.
