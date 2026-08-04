---
id: 2026-07-13-hub-poller-died-under-set-e-on-backend-outage
date: 2026-07-13
title: A backend death mid-run killed the hub poller under `set -e`, stranding dispatched benchmark requests as `running`
surface: harness
component: benchmark-hub
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-hub-poller — an upload/completion call against a dead hub exits non-zero under set -e, terminating the poller
symptoms:
  - dispatched benchmark runs stay stuck in status 'running' forever
  - hub poller process is gone after a backend restart
  - in-app Benchmark Hub dispatches never execute ("stuck queued")
tags:
  - benchmark-hub
  - poller
  - set-e
  - resilience
  - dispatch-queue
sources:
  - commit 2a6aabd3
  - memory:project_cloudbench_per_bench_fleet_autoscale
repro: back-end/src/tests/blackbox/benchmarks-hub-pipeline.blackbox.ts
status: fixed
---

## Problem

In-app Benchmark Hub dispatches stopped executing — the "stuck queued" incident.
Requests that had been claimed were left in status `running` indefinitely, and the
`run-bench-hub-poller` process was simply absent.

## Diagnosis

The poller uploads run completions to the hub over HTTP. When the backend died
mid-run, that upload failed, and because the poller runs under `set -e` the non-zero
exit **killed the poller itself**. Two consequences compounded: the in-flight
request was never transitioned out of `running` (it looked permanently in progress),
and no subsequent dispatch could be claimed because nothing was polling.

So a transient dependency outage was converted into permanent queue death, and the
stranded `running` rows made the failure look like a hung benchmark rather than a
dead poller.

A second, related fragility: unscoped claims let the poller and tests race for the
same `BenchmarkRunRequest` rows.

## Solution

Hardened the dispatch pipeline:

- **Hub-outage resilience:** completions now spool to `.context/hub-upload-spool/`
  and flush on each tick, so the poller survives a hub outage and reconciles later
  instead of dying.
- **Claim scoping:** added `BenchmarkRunRequest.scope` + `HUB_CLAIM_SCOPE` —
  unscoped means user dispatches, and tests use private scopes, which removes the
  poller/test race.
- **Managed service:** `run.sh` runs `hub-poller` as a managed service (skipped in
  benchmark mode) so app dispatches execute on any dev stack.
- **Core-infra e2e:** `benchmarks-hub-pipeline.blackbox.ts` drives the real poller
  binary with a `RUN_BENCH_BIN` stub producing the real artifact layout, under hard
  per-stage deadlines, across 4 legs (happy path, failure honesty, late poller, hub
  outage spool). It caught 2 real bugs before commit.

Environment gotchas recorded alongside: Conductor stops all `victoria-db-*`
containers in ~4-minute waves for workspaces it considers stopped, so ad-hoc
standalone stacks die mid-test — run under a live workspace stack. And Postgres
`jsonb` loses key order at every depth, so the poller's `tasks.json` export uses a
recursive order-preserving merge (dicts included inside lists) keyed to the file's
order.

## Human feedback

None recorded.

## Reusable lesson

A worker that mutates a queue must not die on a dependency's HTTP failure under
`set -e` — spool the write and retry, or the queue strands rows in a non-terminal
state.
