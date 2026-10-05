---
id: 2026-09-09-status-proxy-launcher-pid-only-readiness
date: 2026-09-09
title: Status proxy launch accepted PID liveness before the lifecycle service was reachable
surface: harness
component: cloudbench-data-plane-proxy
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-cloud start_data_plane_proxy treated a live status-proxy PID as ready after discarding HTTP 000 from the lifecycle endpoint
symptoms:
  - "bench.log could not be read after 5 bounded retries -- infrastructure failure"
  - "proxy launcher returned ready with lifecycle HTTP 000"
  - "every isolated stack failed before the start barrier"
tags:
  - cloudbench
  - data-plane-proxy
  - readiness
  - driver-lifecycle
  - process-reaping
sources:
  - plan:docs/plans/completed/cloud-bench-per-bench-isolation.md
  - fleet run 20260909-134518-3785902
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_data_plane_proxy_waits_for_accepted_lifecycle_response
status: fixed
---

## Problem

The N=2 infra canary run `20260909-134518-3785902` boot-launched both
isolated machines, then both children exited with `bench.log could not be read
after 5 bounded retries -- infrastructure failure`. The Fleet controller
reported `every isolated stack failed before the start barrier`.

Fly-agent evidence between 13:50:16 and 13:50:30 recorded repeated
`connect tcp [machine-private-ip]:8011: connection was refused` for both exact
machine IPs while each local `flyctl proxy` process remained alive. The
per-task proxy logs contained only `Proxying localhost...`; they did not prove
that the on-box lifecycle service accepted an HTTP request.

The permanent focused reproduction ran
`cd agents && venv/bin/python -m pytest benchmarks/cloudbench_dependency_sync_test.py::test_data_plane_proxy_waits_for_accepted_lifecycle_response -q`.
Before the production fix it exited 1 with `assert 97 == 0` and
`RCA_REPRO: proxy launcher returned ready with lifecycle HTTP 000; bounded
bench.log read gate exhausted`.

## Diagnosis

Critical path: machine start accepted → `flyctl proxy` process launched →
lazy data-plane connection attempted → status-proxy readiness published →
bounded `bench.log` reads → synchronized barrier classification.

What: status-proxy startup published readiness before its status service was
reachable. Where: `scripts/run-bench-cloud` in `start_data_plane_proxy`, at the
post-probe `kill -0` success branch. Why: the launcher discarded the
`/driver-health` result with `|| true`, checked only for a bind collision and
PID survival, and returned 0. A `flyctl proxy` process can remain alive while
the remote port refuses connections, so the caller entered its five-read gate
without a usable status transport. Proof: the live Fly-agent log paired
surviving tunnels with repeated remote `:8011` refusals, and the focused
production-function test deterministically returned lifecycle HTTP `000`,
accepted the live PID, and exhausted the unchanged read gate.

The deepest owned cause is an inconsistent readiness contract: initial startup
used process liveness while later monitoring used accepted lifecycle HTTP
codes. That split allowed the same transport to be "ready" at startup and
immediately "unhealthy" in `ensure_status_proxy`. Going deeper would speculate
about the historical reason for the generic launcher design without evidence.

## Solution

`scripts/run-bench-cloud` now owns one
`status_proxy_lifecycle_response_accepted` predicate for lifecycle HTTP `204`,
`410`, and `425`. Initial status-proxy launch and later transport monitoring
both reuse it. An unaccepted response causes the exact launched PID to be
terminated and waited before another attempt on the still-owned port lease.
Final failure still returns through `start_leased_data_plane_proxy`, which
releases the lease; bind collisions still release and rotate it.

Backend proxies retain their distinct process-survival readiness contract and
probe `/`, never requiring `/driver-health`. The permanent regressions cover a
live first proxy returning HTTP `000`, exact reaping before a second accepted
attempt, and unchanged backend-proxy behavior.

At 10,000 agents, the fix adds one bounded lifecycle request per status-proxy
launch attempt and no per-agent state, poller, query, channel, or shared lock.
Work remains O(1) per isolated benchmark.

## Human feedback

The user required ten consecutive 10-task slices with no INFRA result. Any
INFRA result resets the streak and must be diagnosed and fixed before the
sequence restarts; passing benchmark outcomes are not required.

## Reusable lesson

Define readiness at the service that owns it, share that predicate across launch and monitoring, and reap every rejected process before reusing its leased port.
