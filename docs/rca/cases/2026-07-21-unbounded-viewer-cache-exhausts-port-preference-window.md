---
id: 2026-07-21-unbounded-viewer-cache-exhausts-port-preference-window
date: 2026-07-21
title: An unbounded per-source archive viewer cache plus a fixed 100-port preference window exhausted ports, so /open-agent returned an empty response
surface: harness
component: benchmark-hub
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: agents/benchmarks/agent_link_server.py — viewer allocation searched only a fixed 100-port preference window while the per-source viewer cache had no bound
symptoms:
  - "/open-agent returns an empty response"
  - Benchmark Hub accumulates duplicate archive viewer processes
  - port allocation fails after the preferred window is exhausted
tags:
  - benchmark-hub
  - archive-viewer
  - port-exhaustion
  - process-leak
  - lru
  - pid-ownership
sources:
  - PR #844
repro: agents/tests/blackbox/agent_link_server.blackbox.py
status: fixed
---

## Problem

`/open-agent` on a long-lived Benchmark Hub eventually returned an empty
response: no archive viewer could be started for the requested run.

## Diagnosis

Long-lived hub processes retained an unbounded per-source viewer cache, while
port allocation only searched a fixed 100-port preference window — so viewer
count grew without limit against a constant supply of ports and allocation
eventually failed outright. Two ownership defects made the growth worse than a
slow leak: supervisors recorded with legacy _relative_ context paths were not
recognized as owners of an existing viewer, and PID metadata could be
overwritten, so duplicate viewers for the same source survived reaping. The
deepest owned cause is that viewer identity/ownership was inferred from mutable
on-disk metadata rather than verified, and nothing capped the cache.

## Solution

Each Benchmark Hub archive viewer cache is now bounded to 16 supervisor units
with safe least-recently-used eviction, and port allocation falls back across the
full valid local range once the preferred window is exhausted. Ownership
discovery now resolves absolute _and_ legacy relative viewer owners exactly, fails
closed on incomplete process inventories, quarantines malformed metadata, and
reaps dedicated frontend process groups on every exit path. 12 blackbox
regressions in `agents/tests/blackbox/agent_link_server.blackbox.py` cover port
exhaustion, duplicate/relative ownership, fail-closed discovery, LRU convergence,
and process-group cleanup. Scale statement from the PR: a single hub converges to
at most 16 verified viewer supervisor units in steady state; source resolution
still scales with retained run history, total machine viewer count scales with
concurrently running hubs, and the first legacy-convergence scan is proportional
to the pre-existing viewer process count.

## Human feedback

None recorded.

## Reusable lesson

Any cache of OS-level resources needs an explicit bound and verified ownership —
an unbounded cache against a fixed port window fails as an unrelated-looking
empty response, not as an out-of-resources error.
