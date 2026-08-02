---
id: 2026-07-13-fleet-cleanup-pkill-pattern-matched-its-own-batch-resolver
date: 2026-07-13
title: Fleet cleanup's `pkill agent_link_server.py.*$FLEET_DIR` matched the batch resolver itself, killing the post-run link
surface: harness
component: cloudbench-fleet
classification: our-bug
problem_class: other
first_bad_boundary: run-bench-fleet cleanup — pkill pattern agent_link_server.py.*$FLEET_DIR also matches the batch dashboard whose argv contains --fleet-dir $FLEET_DIR
symptoms:
  - "/open-agent link is dead immediately after the run exits"
  - batch dashboard process gone after cleanup
  - link returns nothing rather than a not-found page
tags:
  - cloudbench-fleet
  - pkill
  - process-cleanup
  - argv-pattern
  - archive-viewer
sources:
  - memory:project_cloudbench_per_bench_fleet_autoscale
repro: agents/benchmarks/agent_link_server_test.py
status: fixed
---

## Problem

The durable post-run `/open-agent` link was dead the moment a fleet run finished:
the batch dashboard that is supposed to persist past run exit was gone.

## Diagnosis

The batch dashboard **is** `agent_link_server --fleet-dir <FLEET_DIR>` — that is
precisely the process that must outlive the run so agents stay resolvable from the
locally saved `cloudbench-run.json` across all benches.

The fleet's cleanup ran `pkill -f 'agent_link_server.py.*$FLEET_DIR'` to reap
per-bench viewers. But the batch resolver's own argv contains
`--fleet-dir $FLEET_DIR`, so the pattern matched the very process cleanup was
supposed to preserve. The pattern was written to describe the children and
accidentally described the parent — a self-inflicted kill by argv collision.

## Solution

Removed that `pkill` from fleet cleanup entirely. Per-bench children already reap
their own viewers via their individual exit traps, so the broad pattern kill was
redundant as well as harmful.

Verified after the fix with the bench box down: `/open-agent` returns 200 serving
the real 92-message transcript, and an unknown agent returns 200 with a not-found
page — never a connection failure (`000`).

## Human feedback

None recorded.

## Reusable lesson

Before adding a `pkill -f` pattern, check whether the supervising process's own
argv matches it — reap children via their own exit traps instead of a broad
pattern kill.
