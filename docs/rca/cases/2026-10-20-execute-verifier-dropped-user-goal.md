---
id: 2026-10-20-execute-verifier-dropped-user-goal
date: 2026-10-20
title: The execute verifier extracted the final output without the user's goal
surface: agents
component: verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py::_filter_context_for_execute_verifier dropped the first USER row (the goal) when it preceded the first EXECUTE-phase row
symptoms:
  - "summaries also use two sentences each, with “Led by …” as a separate sentence"
  - "puts “Led by <investor>” in a separate period-terminated fragment"
  - "visible record contains the explore agent’s consolidated report, not verifiable web-research tool results"
tags:
  - verifier
  - structured-output
  - background-agents
  - explore
sources:
  - agent 4cf417f1-0c5d-44c5-a00c-8c7675939853 (FAIL, judge)
  - agent 1469eaed-cda5-4d0a-a1af-c70d645bd347 (FAIL, judge)
  - agent b1cff031-e5f5-4037-89ae-2a0748205cad (FAIL, verifier rejected delegated report)
  - commit 6640defb9 (goal kept), commit 5c17904f5 (verifier rule 6 prompt hunk)
repro: agents/tests/blackbox/llm.blackbox.py::test_check_progress_execute_verifier_keeps_original_goal
status: fixed
---

## Problem

`explore-agent-mid-run-message` failed its declared LLM judge in 4cf417f1 and
1469eaed. Every final `summary` was `"<company> raised .... Led by X."`: two
sentences, although the goal asked for "a one-sentence summary". The final
structured output comes from the execute verifier's `output` extraction
(`verifier_execute` dump, model gpt-6-sol).

## Diagnosis

The `verifier_execute` dumps for all five earlier runs of this task (4e0609e1,
b398f5c4, 1469eaed, 4cf417f1 and b2726cac) contain neither "Compile a list" nor
"one-sentence". The verifier did see the mid-run follow-up ("also say who led
the round, written as 'Led by <investor>'"). With only that instruction, adding
a separate "Led by X." sentence is a reasonable reading. Passing runs happened
to write "Led by X, Y raised ...".

`check_progress` (call_site `verifier_execute`) runs
`_filter_context_for_execute_verifier`. That function keeps rows from the
first EXECUTE-tagged row onward. A `start_phase=execute` root has no phase on
its goal row, while every executor row is tagged EXECUTE, so the goal row is
always removed. The same happens to the goal of a plan-to-execute agent. Two
existing tests asserted this exclusion, even though the verifier static prompt
says it receives "the original user goal" and the `check_progress` docstring
says "first USER message is the goal".

Archive searches for "verifier goal missing structured output extraction" and
"execute verifier context filter" found no prior case, so this case is new.

Follow-on (b1cff031, after the goal fix): once the verifier could see the
"single explore agent" goal, it rejected the explore's FINAL_ANSWER as "only
the agent's summary". Rule 6 of the static prompt ended with "Do not treat this
as evidence for a positive fact", and the parent's context never contains a
child's own tool rows. Replaying that exact dump with
`scripts/replicate_llm_dump.py --mode exact` scored 0.0, 0.0 and 1.0. With the
clarified rule 6 it scored 1.0 three times.

## Solution

`_filter_context_for_execute_verifier` now always keeps the first USER row
(the goal) ahead of the execute-phase rows. Plan and research rows are still
excluded. The new `llm` blackbox regression uses the benchmark's message shape.
It failed with "execute verifier must see the original user goal" before the
fix and passes after it. The two old tests now assert that the goal is kept.

Rule 6 of the verifier prompt now says that a completed sub-agent's result is
a tool result whose findings and cited sources are grounded evidence. It also
says the child's own tool calls are never shown to the verifier. The
negative-finding requirement is unchanged. This is a prompt hunk that needs
approval. The `prompt-invariants` test
`verifier_credits_completed_sub_agent_results_as_evidence` locks it.

At 10k agents: there is one extra USER row per verifier call. The cost is
O(1) per agent, with no shared state.

## Human feedback

None recorded.

## Reusable lesson

A context-scoping filter must preserve the inputs that the consumer's prompt
says it receives. Check the scoped context against the prompt's declared
inputs, not only against the rows it is meant to remove.
