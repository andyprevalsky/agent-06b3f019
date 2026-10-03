---
id: 2026-09-10-local-worker-port-arithmetic-collides-across-stacks
date: 2026-09-10
title: Secondary worker port arithmetic killed half of an isolated smoke stack
surface: agents
component: local-worker-observability-ports
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/scripts/run_local_worker.sh secondary worker metrics and health port allocation aliases listeners outside the workspace allocation
symptoms:
  - "ValueError: Failed starting Prometheus exporter: Address already in use (os error 48)"
  - workers 1 through 6 exit before readiness while workers 0 and 7 through 11 stay healthy
tags:
  - prometheus
  - worker-startup
  - port-collision
  - isolated-benchmark
sources:
  - PR #1299
  - commit 604618bac83d88b881357d66bbdf0f002299a044
  - plan:.context/acceptance/worker-port-rca/runtime-evidence.json
repro: agents/tests/blackbox/worker.blackbox.py
status: open
---

## Problem

The full local smoke rerun started an isolated stack with backend port 23500
and twelve requested workers. Its worker logs 1 through 6 ended at the
Prometheus exporter bind, without a ready message. The other six workers were
healthy. The separate payment stack at base 32201 had all twelve workers ready.
The smoke's first browser task nevertheless passed in 334 seconds; this case
does not attribute a benchmark timeout, delay, or failed result to the lost
worker capacity.

The runtime capture is under `.context/acceptance/worker-port-rca/`. It records
the manifests, log sizes/readiness counts, listener ports, and exact PID/birth
identities. The occupied ports belonged to the still-running primary stack's
health endpoints, not abandoned workers. No sibling process was killed.

## Diagnosis

Path: isolated stack base port → local worker launcher → per-worker environment
→ SDK runtime exporter bind → Temporal worker readiness. The launcher computed
secondary metrics ports as `(base_metrics % 1000) + 19000 + index` and health
ports as `(base_health % 1000) + 19500 + index`. The primary stack at base 32001
had health listeners 19505–19510; the smoke stack at base 23500 assigned those
same ports to its secondary metrics exporters. `lsof` identified the existing
listeners as PIDs 59959, 59960, 59961, 59962, 59964, and 59967, each born
September 10 at 16:30:24 local time. Smoke workers were started at 17:19:26.

The first bad boundary was port allocation, before any Temporal connection.
The deepest owned gap was treating arithmetic outside a workspace's allocation
as exclusive ownership. The same arithmetic also aliases the same service
across bases separated by 1000. No retry, prompt change, or task timeout change
can establish ownership of those sockets.

Archive searches were `Failed starting Prometheus exporter Address already in
use` and `isolated worker metrics port collision`. The closest relative was
`2026-08-03-backend-coverage-hard-coded-port-collides-sibling-workspace`:
arithmetic escaped a workspace allocation there too, but its owning launcher
and remedy were separate. This is a related case, not a recurrence of that
coverage allocator.

The permanent worker blackbox runs the actual local launcher while a real
sibling socket holds the old derived metrics port. On the buggy revision it
observed `OSError: [Errno 48] Address already in use` and the secondary worker
never became ready. The same assertion passes after the fix, while the sibling
listener and fixed primary ports remain intact. Command:
`agents/venv/bin/python agents/scripts/run_blackbox_tests.py worker`.
The red log is `blackbox-red.log`; the initial green log is
`blackbox-green.log` (9 checks, 1.3 seconds). Subsequent worker and health-server
coverage adds real SDK bind-race replay, IPv4/IPv6 health requests, and actual
main-startup propagation before Temporal connect. The final
`blackbox-green-final.log` records worker 11/11 and health-server 3/3 in 1.7
seconds, including a real occupied fixed health port that prevents any Temporal
connect attempt while preserving the existing listener.

## Solution

The launcher deletes secondary port arithmetic and requests dynamic ports.
Worker zero retains the externally discovered readiness, metrics, and health
ports. The health server binds synchronously through the same Werkzeug server
used by Flask, allowing the kernel to atomically assign port zero; its thread
exposes the actual bound port before startup proceeds.

The Temporal SDK exposes neither a bound-port accessor nor socket adoption.
For a zero-port request, worker startup obtains a free candidate and attempts
the real exporter bind. A competing bind during that handoff is handled only
when the SDK reports the exact exporter address-in-use error, with at most ten
attempts before failure. Fixed ports and other startup errors still fail
immediately. There is no unchecked allocation handoff: the successful SDK bind
establishes ownership, and persistent contention raises the actual error.
Startup retains the actual SDK and health ports for its existing scrapers and
logs both for inspection. No telemetry endpoint is disabled.

The owning blackbox is discovered by the existing agents coverage runner in
`/deploy`. Independent review passed worker 10/10 and health-server 3/3 and
requested bounded fixture allocation and atomic fixture-ready publication;
both were incorporated. Full coverage and a fresh full local smoke rerun are
still pending in the parent deploy loop, so the case remains open until their
live startup evidence confirms every requested worker is present.

A fresh mass-agent stack, `1789086767-20693-21578`, started on the fixed
launcher at `2026-09-11T00:33:03Z`. The parent verified all twelve workers by
exact launcher ancestry and PID/birth, with twenty-four distinct listening
ports. Every health endpoint and SDK metrics endpoint returned HTTP 200;
every health metrics response exposed `activity_slots_available_present 1`,
confirming that self-scrapes use the actual dynamic SDK port. The record is
`.context/acceptance/live-workers-1789086767-20693-21578.json`. Full coverage
and the complete post-fix smoke group remain required before closing this case.

At 10,000 agents there is no additional per-agent state or work: allocation is
once per worker process, binds are kernel-owned, and the unchanged scraper uses
one resolved process-local port. Production's fixed-port single-worker launch
is unchanged. The fix removes the shared modulo namespace without introducing
a global allocator, registry, or lock.

## Human feedback

The user asked to finish without further permission prompts. No task prompt,
evaluator, timeout, cache, or concurrency setting was changed.

## Reusable lesson

Let successful socket binds establish ownership of secondary worker endpoints,
and retain their actual addresses for every existing consumer.
