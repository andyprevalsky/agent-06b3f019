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

## Human feedback

The user authorized infrastructure repairs, retained approval gates for new WHM context or policy semantics, rejected the withdrawn global context caps, and required approval before applying the separate R18 schema proposal, which remains unapplied. These component controls do not authorize a new benchmark or prove fundraising success.

## Reusable lesson

Separate in-flight ownership from acknowledged completion and keep all simulated waits on one signed shared clock.
