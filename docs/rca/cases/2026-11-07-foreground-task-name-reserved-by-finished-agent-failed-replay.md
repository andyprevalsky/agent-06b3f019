---
id: 2026-11-07-foreground-task-name-reserved-by-finished-agent-failed-replay
date: 2026-11-07
title: A finished foreground explore/browser/code agent kept its task_name reserved, so re-running a task under the same name failed with "task_name ... is already used" (and failed every DEMO-cache replay of a recorded repeat)
surface: agents
component: background-agents
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/background_agents.py _begin_foreground_spawn rejected any task_name held by a record, and _evict_finished_overflow retired every evicted name, so a FINISHED foreground agent (which cannot be woken through its path) blocked its name for the life of the workflow
symptoms:
  - "task_name 'research_ethan_mollick_s_substa_5c9a76d1' is already used by another agent you spawned; choose a different task_name."
  - Declared evaluator t10-no-tool-failures failed
  - Observed tool failure spawn_agent status=ERROR
  - test-mass-agent-run-0 failed in the pre-deploy smoke
tags:
  - background-agents
  - foreground-spawn
  - task-name
  - demo-cache
  - smoke
sources:
  - agent 6efe1927-86d5-4cbb-8084-20af7d97db55
  - agent 030c4a79-c37d-4bf7-a55d-477f9d11bd6c
  - PR #1744
repro: agents/tests/blackbox/background_agents.blackbox.py test_a_foreground_task_name_is_reusable_once_its_agent_finished_and_refused_while_it_runs and test_demo_cache_replay_accepts_a_recorded_foreground_spawn_that_repeats_its_task_name
status: fixed
---

## Problem

The pre-deploy smoke `test-mass-agent-run-0` (DEMO-cache replay) failed its declared evaluator
`t10-no-tool-failures`: `030c4a79:spawn_agent toolu_01WDeLVcbPCgNkQ9gDWDCE3u status=ERROR`, text
`task_name 'research_ethan_mollick_s_substa_5c9a76d1' is already used by another agent you spawned;
choose a different task_name.` The recorded July trajectory has 19 explore agents that each issue
the same spawn (same goal, same `task_name`) twice, one after the other. On `main` both ran.

Gate: INTRODUCED. The branch's change that made foreground spawns addressable
(`_begin_foreground_spawn`, RCA 2026-11-06-foreground-spawn-promised-an-address-it-never-registered)
applied the background spawn's uniqueness rule to a foreground spawn.

## Diagnosis

DEMO replay runs every spawn in the foreground (`_spawn_runs_in_background` returns False under
`fast_mode_cache_enabled`), so the repeated spawn reached `_begin_foreground_spawn`. It refused the name
because the first agent's record sat in `_background_finished` (and, past the finished-record bound,
`_evict_finished_overflow` retired its name for good). Nothing can be addressed through a finished
foreground agent (its result is the spawn call's result; a send names its state), so the reservation
protected nothing. Address lookup also returns the oldest matching finished record first, so simply
allowing the repeat would have resolved the path to the older agent.

Local repro (red before, green after, unchanged): `cd agents && python scripts/run_blackbox_tests.py
background-agents`. Pre-fix, the second spawn returned
`{'error': True, 'message': "task_name 'find_repo' is already used by another agent you spawned; ..."}`
in 6 s, the exact production text. The full recorded task passes in the deploy's smoke gate.

## Solution

A finished foreground record never blocks its name: the new spawn supersedes it, so the path resolves to the
newest agent, and eviction no longer retires a foreground name. A still-running holder, a background-owned
name (running or finished; it can still be woken through its path) and a retired background name are refused
with the unchanged existing text (identical to the background-spawn refusal on `main`, so no new LLM-visible
text). DEMO-cache replay additionally keeps no foreground record at all: it reproduces a recorded trajectory
and nothing in a replay addresses these agents, so it must not fail a recorded repeat on bookkeeping (some
recorded repeats may overlap in time, which the running-holder rule would still refuse).

10k agents: per-agent workflow state only (one dict entry per spawn, bounded by the existing finished-record
cap); no shared state, polling or fan-in.

## Human feedback

Deploy coordinator (2026-11-07): a repeated task_name is legitimate for foreground spawns; a finished earlier
record must not block the new spawn, only a still-running duplicate may be refused, and the fix must be the
root cause, not a replay-only guard.

## Reusable lesson

When a new bookkeeping record reserves a name, release it when the thing it protects (an address that can still
receive a message) is gone, and check that cached or replayed trajectories recorded before the rule existed
still satisfy it.
