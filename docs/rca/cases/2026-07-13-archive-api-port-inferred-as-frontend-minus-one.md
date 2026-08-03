---
id: 2026-07-13-archive-api-port-inferred-as-frontend-minus-one
date: 2026-07-13
title: The archive API port was inferred as frontend−1 even though both ports are independently free-port-picked
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: _archive_api_url in agent_link_server.py — assumed api_port == frontend_port - 1 instead of reading the archive metadata
symptoms:
  - loading page hangs on "waiting for agent to come online"
  - loading page polls a dead port (8967) while the API listens on 8968
  - frontend and API ports come out non-adjacent (8966/8968)
tags:
  - cloudbench-fleet
  - port-allocation
  - archive-viewer
  - heuristic
sources:
  - memory:project_cloudbench_per_bench_fleet_autoscale
repro: agents/benchmarks/agent_link_server_test.py
status: fixed
---

## Problem

Clicking through to a benchmark agent hung indefinitely on the viewer's
"waiting for agent to come online" loading page. The loading page was polling port
8967 while the archive API was actually listening on 8968 (frontend was on 8966) —
so it polled a dead port forever.

## Diagnosis

`_archive_api_url` derived the API port from the frontend port with the heuristic
`api = frontend - 1`. That assumption never held: the two ports are **independently
free-port-picked**, so any port taken between them shifts the pair out of
adjacency — as happened here, producing 8966/8968 and leaving the heuristic
pointing at an unbound 8967.

This was a latent bug: the heuristic happens to be right whenever the free-port
picker returns adjacent ports, so it survived until an intervening port was busy.

## Solution

`_archive_api_url` now reads the real `api_url` from the archive metadata
(`_api_url_from_meta`), keeping the arithmetic heuristic only as a fallback.
Covered by `agent_link_server_test.py` (12 tests).

## Human feedback

None recorded.

## Reusable lesson

Never infer one service's port from another's by arithmetic when both are
free-port-picked — read the actual bound address from metadata.
