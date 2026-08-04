---
id: 2026-07-18-prod-benchmark-frontend-url-hijacked-to-local-tunnel
date: 2026-07-18
title: "`--prod` benchmark runs got a local ngrok tunnel as their frontend URL instead of roselabs.ai"
surface: harness
component: benchmark-runner
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "run_benchmark.py:_frontend_url_for_benchmark — returned the local rose-<ws>.ngrok.app tunnel even for --prod runs"
symptoms:
  - "prod benchmark run reports a rose-<workspace>.ngrok.app frontend link"
  - the reported FE link is dead when no local stack is running
tags:
  - benchmarks
  - prod
  - ngrok
  - frontend-url
  - link-rot
sources:
  - memory:project_cloudbench_shared_warm_footgun
repro: none-recorded
status: fixed
---

## Problem

Benchmark runs launched with `--prod` reported a frontend URL pointing at the
workspace's local `rose-<ws>.ngrok.app` tunnel rather than `roselabs.ai`. When no
local stack was up — the normal case for a prod run — that tunnel was down, so the
run's FE verification link was dead on arrival.

## Diagnosis

`_frontend_url_for_benchmark` in `agents/benchmarks/run_benchmark.py` derived the
frontend URL from local workspace configuration without consulting the run's
target environment, so the local-tunnel branch hijacked prod runs. The
generalizable defect: a URL was derived from where the runner is executing rather
than from which backend the run actually targets.

## Solution

Fixed on main with the broader rule rather than an allowlist: when the backend
hostname is not in `{localhost, 127.0.0.1}`, use `https://roselabs.ai`. A narrower
allowlist written on the branch was superseded on merge (main's logic kept, the
branch's rationale comment retained).

## Human feedback

None recorded.

## Reusable lesson

Derive a run's frontend URL from the backend it targets, not from the machine it
was launched on — otherwise prod runs advertise links to a dev tunnel that is
usually down.
