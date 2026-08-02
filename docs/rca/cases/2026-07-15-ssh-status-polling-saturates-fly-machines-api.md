---
id: 2026-07-15-ssh-status-polling-saturates-fly-machines-api
date: 2026-07-15
title: Per-box `flyctl ssh` status polling saturated the Fly Machines API and froze a 30-box fleet
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: run-bench-fleet status poll — every box ssh_read'd /data/bench.log every 10-20s, and each `flyctl ssh console` costs 2-4 Machines-API calls
symptoms:
  - 30-box daily fleet run froze at 7/30 barrier-ready with zero progress over 60s
  - "flyctl machines list throttled ~1/3 of calls during a live 30-box run"
  - 16 of 30 boxes idle at RUNSTAMP with zero benchmark processes
tags:
  - cloudbench
  - fly-io
  - rate-limit
  - ssh
  - fleet-barrier
sources:
  - commit 9748fa00c
  - memory:project_cloudbench_dataplane_status_poll
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: fixed
---

## Problem

The 30-box daily cloud-benchmark fleet froze. Only 7 of 30 boxes reached the
synchronized-start barrier and the count did not move (Δ0 over 60s). 16 of 30
boxes sat idle at RUNSTAMP with zero benchmark processes running. Running
`flyctl machines list` by hand during the live run was throttled on roughly 1
call in 3, which is the evidence that pinned the cause.

## Diagnosis

The fleet's status design was SSH-pull: every box was polled by
`flyctl ssh console`-reading `/data/bench.log` every 10-20 seconds, and each
`flyctl ssh console` invocation costs 2-4 Fly Machines-API calls. Steady state
was ~200-500 API calls/min, and 500-1000/min during launch bursts. That
saturated the Machines API rate limit, which produced a two-stage cascade:
throttled ssh calls made driver-launch die on some boxes, and the death-probe
that should have excluded dead boxes was itself defeated — a failed `ssh_read`
did not return the literal `DEAD`, so the box was never excluded and the
barrier waited forever on machines that were never coming.

The deeper owned cause: control-plane API calls were used as the transport for
a high-frequency, per-box data read, so the cost of observing the fleet grew
linearly with fleet size and consumed the same budget the fleet needed for
launch and repair.

## Solution

Status is now polled over the Fly **data plane** instead of the control plane
(commit 9748fa00c): each box runs `python3 -m http.server --directory /data`
to serve `bench.log`, the controller opens one `flyctl proxy` per box over
WireGuard, and polls `curl http://127.0.0.1:$LOCAL_STATUS_PORT/bench.log`.
Traffic never touches the Machines API. SSH remains a fallback only when the
proxy path is down; the rare stall/liveness `pgrep` probe still uses ssh. The
independent on-box status server also removed the DONE-read race, since it
survives driver exit. Validated on a 3-box smoke: proxies up, HTTP streaming
works, barrier-ready detected over HTTP, tolerant barrier released, benchmarks
ran, DONE read over HTTP, and Fly list-API throttling went from 1/3 to 0/5.
A residual, separately-tracked infra failure remained: some boxes start with an
empty DB, run first-run prod-sync, and the stack segfaults (`rc=139`).

## Human feedback

The human's standing rule constrained teardown: TERM only the fleet controller
PID (the child launchers' modal PPID) and let its traps reap machines — never
kill children directly, and never blanket-destroy machines on the shared bench
app because sibling workspaces run there.

## Reusable lesson

Never poll fleet state through a provider's control-plane API — move
high-frequency per-box reads onto the data plane, and make liveness probes
treat "probe failed" as unknown-not-alive so a throttled probe cannot hang a
barrier.
