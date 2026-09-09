---
id: 2026-09-09-planner-memory-route-contract-omitted-stateful-verification
date: 2026-09-09
title: Retrieved browser routes did not state where live verification belonged
surface: agents
component: planner-memory-injection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/planner_memory/inject.py memory result contract
symptoms:
  - "imax-single-session on=1/3"
  - "no_tools: spawn_explore_agent present"
  - "planner split discovery from live browser verification"
tags:
  - planner-memory
  - planner-routing
  - stateful-browser
  - trajectory-contract
sources:
  - plan:agents/benchmarks/runs/memory-scenarios-20260909T191757Z.json
  - plan:agents/benchmarks/runs/memory-scenarios-20260909T192424Z.json
repro: agents/benchmarks/run_memory_scenarios.py
status: fixed
---

## Problem

The held-out `imax-single-session` scenario retrieved a successful one-browser
trajectory but passed memory-on only 1/3: two plans added an explore task to
recheck current showtimes. Memory-off was 0/3. The exact one-scenario run is
preserved as `memory-scenarios-20260909T191757Z.json`, with the unchanged
assertion `no_tools: spawn_explore_agent`.

The critical path was `retrieved CriticalPath -> rendered get_memories result ->
planner LLM -> task graph -> scenario assertion`. The record and URL were
correct before rendering; the planner split the task after consuming a contract
that explained how to reuse a known URL but not how stateful live verification
relates to that browser task. Archive searches for `imax-single-session`,
`spawn_explore_agent stateful browser`, and `known start URL verification`
found no prior cause; this was novel.

## Diagnosis

The injected contract said a known route made separate discovery unnecessary,
but left current-state verification ambiguous. Because browser state and live
page evidence belong to the same execution dependency, the planner could
reasonably recreate an independent research branch even when the retrieved
successful path showed one browser. The deepest owned cause was omitting the
dependency semantics while presenting trajectory shape as reusable guidance.

## Solution

The result contract now states the general rule: when a successful memory uses
one browser with a known start URL, navigation and live/current-state
verification remain in that same stateful browser task unless the current goal
explicitly requires an independent research artifact. It does not name AMC,
IMAX, showtimes, or the evaluated task.

The same frozen scenario, prompt, fixture, tool assertions, three trials per arm,
and model entrypoint then produced memory-off 0/3 and memory-on 3/3 in
`memory-scenarios-20260909T192424Z.json`. The broader isolated suite later
passed 33/33 in `memory-scenarios-20260909T200122Z.json`, covering 17 fit, 16
held-out, six strict-improvement, and two control scenarios. This is prompt-visible
behavior and therefore remains behind explicit deployment approval.

## Human feedback

None recorded.

## Reusable lesson

When retrieved trajectories prescribe a stateful execution shape, state the dependency semantics that make that shape reusable.
