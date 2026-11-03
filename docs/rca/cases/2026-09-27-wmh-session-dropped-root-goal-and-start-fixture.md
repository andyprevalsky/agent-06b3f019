---
id: 2026-09-27-wmh-session-dropped-root-goal-and-start-fixture
date: 2026-09-27
title: Specialized WMH calls created an unconditioned session
surface: harness
component: world-model-runtime
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: agents/domains/spawn_agent/handler.py _spawn_world_model_specialized omitted root_goal and WorldModelToolExecutionAdapter.execute created the session without seed_state
symptoms:
  - "WMH predicted Rose Labs was a circular biosafety textiles and smart protective gear company"
  - "WMH predicted a $425,000 Brex balance with no historical source IDs"
  - "world model session seed_state is null"
tags:
  - world-model
  - seed-state
  - retrieval
  - benchmark
sources:
  - agent 28aaeabe-bdf2-4587-9aab-5bcbb23b4908
  - fleet run 20260927-225511-659576
repro: agents/tests/blackbox/world_model_harness.blackbox.py::test_runtime_world_model_session_prioritizes_root_and_delegated_goals
status: open
---

## Problem

During the first fundraiser simulation, the whole `spawn_explore_agent` call
returned a company profile unrelated to prior fundraiser trajectories, and the
whole `spawn_browser_agent` call returned an unsupported $425,000 Brex balance
with a future timestamp. A historical passing fundraiser trajectory described
Rose Labs as an AI workflow platform and ended at $6,064,569.77 after four
settled wires; a historical failing trajectory had no Brex deposit evidence.
The current prediction matched neither history and exposed no retrieved source
IDs.

## Diagnosis

The specialized-agent handler intentionally simulated explore, browser, and
code at one tool-call boundary, but copied only the delegated tool arguments.
It did not attach the workflow's root goal. Consequently
`_world_model_task_for_tool` saw only the narrow delegation, the WHM provider
could not recognize the fundraiser's DEMO root for response caching, and
retrieval lost its strongest task discriminator. The adapter also called
`ensure_session` without `seed_state`, although the benchmark had archived a
start fixture for the same root. Retrieval therefore began from an empty state
rather than the run's root identity, objective, row counts, and fixture refs.

## Solution

Every specialized WHM request now carries the resolved tree root goal. The
adapter seeds new sessions with the root id and root objective, and the served
WMH merges that compact state with the root's public archived start-fixture
state before the first retrieval. General-purpose agent loops remain real, and
browser simulation remains at the single `spawn_browser_agent` boundary rather
than browser sub-actions. Root-scoped session reuse means hydration happens once
per root, so 10k agents do not repeatedly download the same fixture per tool
call.

The owning repro previously observed no `seed_state`; after the fix it observes
`rose.runtime_initial_state.v1` with the exact root id and goal. The served-WMH
regression separately proves archived user and row-count fields are merged. The
exact benchmark rerun remains approval-gated, so prediction quality is not yet
claimed fixed.

## Human feedback

The user explicitly required browser simulation at the whole tool-call boundary,
not at browser sub-actions, and asked that prediction accuracy be judged against
historical runs for similar queries.

## Reusable lesson

Seed every live WHM session from the run's own archived start state and preserve the root objective across delegated simulation boundaries.
