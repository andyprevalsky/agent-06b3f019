---
id: 2026-10-15-shared-world-clock-wait-and-acknowledgement-diverged
date: 2026-10-15
title: Shared waits and completion bookkeeping diverged from the world clock
surface: agents
component: world-clock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: wait_seconds advanced only a private offset; workflow register/finish keys were completed before a valid shared acknowledgement
symptoms:
  - wait_seconds advances private time without shared wait
  - Historical world offset is clamped to zero
  - Duplicate world-clock caller returns before time_ms acknowledgement
tags:
  - wmh
  - deploy-review
  - regression
sources:
  - commit fb24dd0304de82ece7fe011292c12da38e19732a
  - plan:.context/deploy-rejected-caps-20261015/rca-review-clock/result.private.json
repro: agents/benchmarks/wmh_world_clock_test.py
status: open
---

## Problem

Actual owning offline controls found three related shared-clock bookkeeping defects: wait_seconds bypassed the shared wait, historical offsets were clamped, and duplicate registration/finish calls could be treated as complete before acknowledgement.

## Diagnosis

The wait_seconds manager bypassed wait_for._wait_on_world_clock. simulated_clock_offset_seconds discarded signed historical offsets. Workflow deduplication used completed bookkeeping for an operation still pending or failed. These are shared-clock consistency boundaries; elapsed age alone was not used to diagnose a live stall.

## Solution

The correction reuses the existing shared wait with the same tool-call identity and duration, preserves unavailable-world/local fallback, keeps signed offsets only in simulate mode, and coalesces in-flight calls with an Event. Only strict integer time_ms acknowledgements mark completion; failure or malformed replies remain eligible for later retry. Existing retry counts and wait budgets are unchanged. The combined phone/clock file went 13 FAIL / 13 PASS to 26 PASS with identical assertions; parent reported 40 clock/wire controls passing. Live Temporal replay and continue-as-new/resume behavior remain unproved; no durable-state redesign was applied.

The component correction was applied by the parent during deployment integration. Status stays open pending the required unchanged normal gates on the final source, review and production verification. No provider admission or fundraiser outcome follows from offline mocks.

The supporting private candidate diff SHA256 is `9198a95059cd493480a680d8a639c1cdae965be1ee976e1d1b443bac8157ffae`; the source handoff above binds its exact commands, fixture corrections and limits. This hash identifies the component proposal, not a final deployed commit.

### C4 integration correction

The initial reuse imported `domains.wait_for.handler` from `wait_seconds`, violating the existing domain dependency direction. Three unchanged owning structural callbacks failed before a byte-identical helper extraction into `helpers/wait_on_world_clock.py` and passed afterward. The fourth unchanged migration check also rejected the unrelated cache-startup history patch, which was removed under the existing generation replacement contract. Combined registered clock/transport controls passed 43 cases on the applied source in 1.64 seconds; eight existing real/simulated wait callbacks passed in both private controls. The shared helper's signature/body SHA256 remained `123726f6b046c0041176046ce64b6b2b9f1a76556a3e552045bf431a82d7b9b7`. Existing assertion ASTs are unchanged; fixture bindings follow the helper's actual module. These component checks do not substitute for the full final-source deploy gates.

### 2026-10-18 follow-up: the agent's own clock still ran at wall speed

Evidence (retired native worlds and serve logs of runs 12-18): every v3 commit carried a predicted `elapsed_ms` and the shared WorldClock applied it (run12 shared 48 min, run16 36.2 min over 60 wall minutes, because model thinking takes no world time). Shared waits did run (run13: 193 wait polls, all 200). The remaining defect was the agent side: after registration `simulated_now` was `workflow.now()` plus a fixed offset, so it advanced at wall speed between waits, and `_wait_on_world_clock` kept `max(own, world)`, so it never returned to world time. `wait_for` validated targets against that clock and rejected future world times as past. Separately, run13's 7 simulated days ended with 0 replies because all 31 scheduled-event patches the model proposed were placeholders ("may review; no response is guaranteed"), and the demos given to the model carry no durations; those are WMH protocol/ingest issues outside this fix.

Repro (failed on origin/main `c7fc3b3d2`, `cd agents && python -m pytest -q benchmarks/wmh_world_clock_test.py`): `test_after_a_shared_wait_the_agent_clock_equals_the_acknowledged_world_time` (`agent clock 2026-10-13T00:00:00+00:00 != shared world acknowledgement 2026-10-12T23:15:00+00:00`) and `test_wait_for_a_future_world_timestamp_waits_on_the_shared_clock` (`Timestamp 2026-10-12T23:30:00+00:00 is in the past.`).

Fix (user-approved, simulate mode only): each agent keeps a world-time cursor (`simulated_world_time_ms`) equal to its WorldClock time. Registration sets it (a child starts at its parent's time), a wait sets it to the acknowledged world time exactly (no ratchet), and `_execute_tool` re-reads it from the clock after every tool, so simulated actions advance it by their predicted durations. `simulated_now`/`simulated_timestamp_ms` read the cursor; the planner date reads the same clock. `WorldClock.finish` moves the parent to each child's finish. A simulated agent whose world session never acknowledged registration (three bounded attempts) fails closed before planning instead of using the real date. Real and shadow modes have no cursor and make no clock calls. Both repros pass, plus new cursor/child/parent/fail-closed/non-simulate tests in the same file and a planner-date test in the llm blackbox.

Causality follow-up: a parent acting beside its children is no longer pulled to a child's finish by `WorldClock.finish`. A parent blocked awaiting a child (the shared `finalize_child` wait used by single and for_each spawns) makes explicit `hold` and `release` world-clock calls (idempotent per hold id). While held it is excluded from shared time even if it acted before, so its children's waits can advance world time instead of deadlocking behind it. On release it receives that child's finish time (its cursor moves to it) and resumes acting; leaving the wait without the result (generation handoff or error) releases with no children. The demo for_each timeout recovery wait holds the same way. A parent idle on its children keeps the finish-time resume. In simulate mode the planner receives the agent's last world-time cursor and uses it (with a warning) when a mid-run clock read returns nothing; outside simulate the planner arguments are unchanged.

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Separate in-flight ownership from acknowledged completion and keep all simulated waits on one signed shared clock.
