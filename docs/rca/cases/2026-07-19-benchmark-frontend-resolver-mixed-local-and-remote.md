---
id: 2026-07-19-benchmark-frontend-resolver-mixed-local-and-remote
date: 2026-07-19
title: Benchmark frontend resolver mixed local and remote URL sources, so a prod run browsed a stopped workspace's ngrok URL
surface: harness
component: benchmark-frontend-resolver
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the frontend URL resolver consulted the workspace-local manifest, PUBLIC_BASE_URL, and CONDUCTOR_PORT in the same precedence chain as remote/production runs
symptoms:
  - production AgentCard gate browses a stale ngrok URL from a stopped workspace manifest
  - browser agent lands on the ngrok-offline page and loops until its bounded timeout
  - remote benchmark run behaves as if it were a local staging run
tags:
  - benchmarks
  - cloudbench
  - ngrok
  - url-resolution
  - agentcard
sources:
  - PR #796
repro: none-recorded
status: fixed
---

## Problem

A production AgentCard benchmark gate failed because its browser goal resolved to a
_stopped_ workspace's ngrok URL taken from the local manifest. The browser reached
the ngrok-offline page and then looped there until the task's bounded timeout — the
run consumed its full budget without ever touching the production frontend.

## Diagnosis

The frontend resolver put local and remote URL sources into a single precedence
chain: the workspace-local manifest, `PUBLIC_BASE_URL`, and `CONDUCTOR_PORT` were
consulted alongside the production URL. A remote run therefore inherited whatever
local state happened to be on the machine, including a manifest left behind by a
workspace that was no longer running. The failure mode is not "wrong URL once" but
"remote runs are contaminated by local state by design" — any stale local artifact
can silently redirect a production gate.

## Solution

The resolver now partitions remote runs **before** any local manifest,
`PUBLIC_BASE_URL`, or `CONDUCTOR_PORT` lookup: remote benchmark browser goals
resolve to the production frontend, while explicit frontend overrides remain
available for intentional staging runs. The stale stopped-manifest reproduction is
cemented in the agents blackbox deploy gate (red: exited 1 on the old resolver;
green: exited 0 after the fix), and the failed production attempt was recorded in
the benchmark attempts ledger. No prompt, task definition, or timeout was changed.

## Human feedback

None recorded.

## Reusable lesson

Resolve remote/production targets in a precedence chain that never reads
workspace-local state — one shared chain lets a stale local manifest silently
redirect a production run to an offline tunnel.
