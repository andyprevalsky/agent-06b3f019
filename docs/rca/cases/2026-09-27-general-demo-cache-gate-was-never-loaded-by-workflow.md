---
id: 2026-09-27-general-demo-cache-gate-was-never-loaded-by-workflow
date: 2026-09-27
title: AgentWorkflow never loaded the generalized DEMO cache decision
surface: agents
component: fast-cache
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/workflows/agent_workflow.py AgentWorkflow.run initialized replay through is_oai_demo_mass_agent_task instead of the backend DEMO catalog decision
symptoms:
  - "fast_mode_cache_enabled=false on a benchmark task tagged DEMO with fast_cache:on"
  - "llm.cache.write_only appears but the fundraiser run does not replay responses"
  - "Repeatable cache hit=38.1% despite DEMO cache being declared on the task"
tags:
  - fast-cache
  - demo
  - benchmark
  - world-model
sources:
  - agent 28aaeabe-bdf2-4587-9aab-5bcbb23b4908
  - fleet run 20260927-225511-659576
repro: agents/tests/fast_cache/test_fast_cache.py::test_resolve_fast_cache_context_activity_returns_general_demo_gate
status: open
---

## Problem

The 10-minute `raise-5m-rose-labs-brex` run was tagged `DEMO` and declared
`fast_cache:on`, but the result recorded `fast_mode_cache_enabled=false`. The
worker logs contained `llm.cache.write_only` events instead of replay events.
The provider prompt cache reported 75.7%, while the repeatable response cache
reported only 38.1%; 88 agent LLM calls consumed 663,030 input and 72,865 output
tokens before timeout.

## Diagnosis

The backend's `/api/fast-cache/agent-flag` already resolves any exact catalog
`DEMO` root (and its children) through `demoCacheAllowed`. `AgentWorkflow.run`
did not load that decision. It initialized replay with
`is_oai_demo_mass_agent_task(self)`, a deliberately narrower legacy prompt
classifier, and called `resolve_fast_cache_goal_activity` only when the provider
button or that legacy classifier was already true. Simulate mode correctly
forced the provider-speed button false, so the fundraiser never entered the
resolution branch. The circular precondition made a catalog-eligible DEMO tree
write-through only.

## Solution

`resolve_fast_cache_context_activity` now returns the backend's complete cache
decision. New workflow histories resolve it once during startup and set the
stable child goal, root goal, replay flag, provider-speed flag, and compute-token
affinity independently. A Temporal patch marker preserves histories created by
the prior workflow code. The result reporter now distinguishes declared DEMO
replay from the simulate-disabled provider-speed button. At 10k agents this adds
one memoized backend lookup per agent startup; it does not add a per-LLM-call
lookup.

The owning repro failed with `ImportError: cannot import name
'resolve_fast_cache_context_activity'` before the fix and passed afterward. The
exact benchmark rerun remains approval-gated, so this case stays open until the
unchanged task proves replay and outcome behavior end to end.

## October 6 continuation: obsolete helper-name fixture

The integrated backend contract resolves the full durable cache context without
the older `unpack_fast_cache_goal_resolution` helper or its conditional legacy
branch. Agent coverage passed all 109 blackbox domains, then failed
`test_is_demo_cache_task_reads_restored_fast_cache_goal` while searching source
text for that deleted helper. Archive searches used the literal unit failure
and restored/leftover-root cache vocabulary; this is a related fixture defect,
not a recurrence of the workflow cache decision bug.

The identical focused command failed before the correction with `ValueError:
substring not found` and passed afterward:

```bash
agents/venv/bin/python -m pytest agents/tests/unit/test_demo_cache_policy.py::test_is_demo_cache_task_reads_restored_fast_cache_goal -q
```

The fixture now runs actual workflow startup with a live input goal, a DEMO
continuation goal, and the provider button off. Its checkpoint occurs before
durable activities: it asserts that the restored goal enables cache replay and
determines compute affinity while leaving the provider button off. Adversarial
review identified this startup-order assertion as necessary; a restore-only
policy check would not preserve the old regression protection. The existing
Temporal SDK blackbox still asserts that leftover children resolve their root
and inherit the DEMO decision with the button off. No workflow branch, prompt,
evaluator, or cache eligibility rule was changed for this fixture repair.

Evidence: `.context/wmh-demo-policy-red.log`,
`.context/wmh-demo-policy-green.log`, and the 109-domain result in
`.context/wmh-agents-coverage-verified.log`. The fundraiser outcome remains
unproven until the exact rebuilt-model benchmark finishes.

## Human feedback

The user required the fundraiser to be marked `DEMO`, required both agent and
WHM responses to be cached, and required a bad DEMO trajectory to be cleared
before another run. The bad goal namespace was purged (190 entries); the current
purge API only supports whole-goal deletion, not deletion from one step onward.

## Reusable lesson

Resolve DEMO replay from the authoritative root-goal catalog decision; never make that lookup conditional on an older prompt-specific cache gate.
