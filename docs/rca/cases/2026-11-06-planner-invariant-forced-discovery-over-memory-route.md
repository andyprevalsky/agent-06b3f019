---
id: 2026-11-06-planner-invariant-forced-discovery-over-memory-route
date: 2026-11-06
title: The planner's MANDATORY explore-before-browser invariant overrode an injected memory route and planned a discovery task the memory made unnecessary
surface: agents
component: planner-system-prompt
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/prompts.py build_planner_system_prompt — MANDATORY DECOMPOSITION INVARIANTS forbid spawn_browser_agent from owning route discovery with no exception for a route a get_memories result already shows
symptoms:
  - "Plan shape: no_tools: spawn_explore_agent present in"
  - "planner-memory-blue-bottle-on-plan-shape failed"
  - "Treat this as a route hint, not proof of current availability"
tags:
  - planner
  - planner-memory
  - prompt-contract
  - explore
  - browser
sources:
  - agent 97ebcec3-36ef-4ce7-be58-4313aa7feaea
  - benchmark run planner-memory-blue-bottle-on epoch-4 job r001-j0016 (fleet 20261106-110445-4093487)
  - task planner-memory-blue-bottle-on
  - commit c943797626
repro: agents/tests/blackbox/prompt_invariants.blackbox.py::test_planner_routes_retrieval_before_stateful_execution (structural) + scripts/replicate_llm_dump.py Foundry replays of the planner dump (behavioral, see Diagnosis)
status: mitigated
---

## Problem

`planner-memory-blue-bottle-on` (the memory-ON arm of the planner-memory A/B) failed
its plan-shape evaluator on the cloud fleet (/descend run
descend-failed-neverrun-20261106, epoch 4, job r001-j0016, agent 97ebcec3) with
`Plan shape: no_tools: spawn_explore_agent present in ['spawn_explore_agent',
'spawn_browser_agent', 'display']`, even though H-03's rebuilt cp-v7 fixture made
retrieval work: the guest worker.log shows `planner_memory.retrieved` with one hit
(`1cba6647…`, similarity 0.82), `compressed=0`, `skipped_uncompressed=0` and
`injected_chars=3678`. The injected memory says known start URLs may be used
directly, "no separate discovery task is needed for a route a memory already shows",
and to keep navigation and live verification in the same browser task. The planner
(served `gpt-6.1-sol-foundry`, rose-foundry-southcentralus, no leased token) still
emitted task 0: "Find and verify the official online pickup-ordering entry point …
Treat this as a route hint, not proof of current availability. [spawn_explore_agent]".

## Diagnosis

The planner reads two instructions that disagree. The system prompt's
`MANDATORY DECOMPOSITION INVARIANTS` say "Plan information retrieval and discovery in
spawn_explore_agent before dependent execution. spawn_browser_agent may read pages
only while executing a known stateful trajectory; it MUST NOT own public research,
target discovery, or route discovery." The memory tool result, which sits later in
the context with lower authority, says the memory's route is known and to plan
without discovery. The explore agent-type description already exempts routes "not
already provided", but the MANDATORY invariant itself carries no such exception, so
a model that weighs the system invariant over the tool result re-plans the
store-specific route as discovery.

Exact replays of the dumped planner call (`scripts/replicate_llm_dump.py --mode
exact`, BACKEND_API_KEY unset so the Foundry leg serves like the guest):

| Arm | Served | Runs | Planned explore | Full evaluator pass |
|---|---|---|---|---|
| Baseline | gpt-6.1-sol-foundry | 33 | 7 (21%) | 26 (79%) |
| Invariant names memory routes as known | gpt-6.1-sol-foundry | 40 | 0 | 40 (100%) |
| Baseline | openai/gpt-6.1-sol (OpenRouter) | 13 | 0 | 13 |

One-sided Fisher exact for explore, baseline vs fixed: p ≈ 0.003. The OpenRouter
route never reproduced it, which is why H-03's 7 OpenRouter replays all passed.

## Solution

`agents/utils/prompts.py`: the MANDATORY retrieval invariant now ends with "A route
a get_memories result already shows (its known entry points and critical path) is a
known stateful trajectory: plan it directly in spawn_browser_agent, without a
separate discovery task." This aligns the invariant with the memory fork's own
contract and the explore definition's "not already provided" clause; runs without
memories are unaffected. `prompt_invariants.blackbox.py` asserts the clause (red
before, green 5/5 after). 10k agents: static prompt text, no per-agent cost; the
planner cached prefix changes once.

## Human feedback

None recorded.

## Reusable lesson

When a lower-authority context source (a tool result such as an injected memory)
must be able to waive a MANDATORY system rule, write the exception into the rule
itself; models resolve the conflict toward the system prompt.
