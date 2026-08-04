---
id: 2026-07-03-parallel-provider-subagent-fanout-stalls-until-timeout
date: 2026-07-03
title: Parallel provider sub-agents finished their grep work but stayed active with outstanding tool results until the benchmark timeout
surface: agents
component: benchmark-tasks
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: the user-data prod benchmark prompt fanned out four provider sub-agents; each completed its grep but never reached a terminal state
symptoms:
  - user-data prod benchmark fails on timeout with no failing tool call
  - four parallel provider sub-agents remain active after their grep work completed
  - sub-agents hold outstanding tool results until the task timeout
tags:
  - benchmarks
  - spawn-agent
  - fanout
  - stall
  - timeout
  - grep
sources:
  - PR #693
repro: agents/tests/blackbox/benchmark.blackbox.py
status: fixed
---

## Problem

The user-data prod benchmark timed out rather than failing on a specific step.
Four provider sub-agents had been spawned in parallel to run provider-filtered
greps. All four completed their grep work, but they stayed active with
outstanding tool results and never terminated, so the parent burned the entire
task budget waiting on children that had nothing left to do.

## Diagnosis

The defect was in the fanout shape, not in grep. The benchmark prompt asked for
one sub-agent per provider, which produced four concurrent children whose only
job was a single tool call each. Completion of the grep did not translate into a
terminal sub-agent state — the outstanding tool results kept each child alive —
so the parent's join never resolved and the run ended at the timeout. The
parallelism bought nothing (four one-call agents) while adding four independent
opportunities to stall.

## Solution

Collapsed the fanout: the benchmark now spawns exactly one provider-audit agent
that performs all four provider-filtered grep calls directly. That preserves the
grep/provider evidence contract the task is meant to assert while removing the
parallel-join stall entirely. The blackbox prompt-shape test in
`agents/tests/blackbox/benchmark.blackbox.py` was updated so the single-agent
shape cannot silently regress back to fanout.

## Human feedback

None recorded.

## Reusable lesson

When a benchmark or agent times out with children that have already finished
their work, suspect the join/terminal-state contract of the fanout rather than
the tool — and prefer one agent making N calls over N agents making one call
each.
