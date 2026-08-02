---
id: 2026-07-07-tree-cost-accrues-after-kill-and-monitor-reads-low
date: 2026-07-07
title: Tree cost kept accruing after a run was cost-capped or killed while the monitor's cost field lagged low, overshooting the budget
surface: harness
component: benchmark-cost-monitor
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: mass-monitor cost field — reports a lagging value, and in-flight children keep incrementing treeCostCents after the parent is capped or killed
symptoms:
  - "~$54.17 spent against a $50 grant"
  - monitor cost field reads lower than the DB treeCostCents
  - cost continues rising after a run is killed or hits its cost cap
tags:
  - cost
  - observability
  - benchmark
  - budget
  - agent-tree
sources:
  - memory:project_mass_agent_run_false_miss_rootcause
repro: none-recorded
status: open
---

## Problem

A budgeted experiment overshot: ~$54.17 spent against a $50 grant, across four
runs (fa9af92d $4.79, PRIME-1 $20.43, VERIFY-1 $17.66, FINAL $11.29). The
overshoot was not a single runaway run — each was watched — but the stopping
signal was wrong.

## Diagnosis

Two compounding observability defects:

1. `treeCostCents` keeps accruing **after** a run cost-caps or is killed, because
   in-flight children continue to completion. So "stop at the cap" is not the same
   as "spend stops at the cap".
2. The mass-monitor's cost field lags **low**, so the operator's live number
   understates actual spend at exactly the moment a stop decision is being made.

Together they mean the human stops based on a number that is both stale and
missing the tail — and the true total only becomes visible in the DB afterwards.

## Solution

Not fixed in code within the recorded session. The recorded discipline: cap or
kill at `BUDGET − expected overshoot` rather than at the budget, and read
`treeCostCents` directly from the DB rather than trusting the monitor's field.
Related diagnostic tooling lives in
`back-end/scripts/{prod-q,mass-score-prod,mass-monitor,mass-cull-stuck,llm-cache-depth}.ts`
(note `prod-q` OOMs on large result sets — select few columns). Full record:
`.context/mass-agent-run-100pct-changelog.md`.

## Human feedback

The user granted a $50 budget for the experiment, which is what made the
overshoot a real finding rather than a curiosity; the runs were repeatedly killed
early specifically to protect that budget (which in turn left cache priming
incomplete).

## Reusable lesson

Treat an agent tree's cost cap as a lower bound on final spend — stop early by the
expected in-flight tail and read `treeCostCents` from the database, never from a
lagging monitor field.
