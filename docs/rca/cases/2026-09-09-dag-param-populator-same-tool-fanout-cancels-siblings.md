---
id: 2026-09-09-dag-param-populator-same-tool-fanout-cancels-siblings
date: 2026-09-09
title: DAG param-populator treated N spawn_agent calls as a hard failure and cancelled sibling browsers
surface: agents
component: dag-executor / call_llm_activity
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py:call_llm_activity required_tool cardinality check — rejected N copies of the required tool before DAG selection
symptoms:
  - "LLMStructuredOutputError: LLM must call exactly one tool, 'spawn_agent'. Got: ['spawn_agent', 'spawn_agent', 'spawn_agent']"
  - "Error: Cancelled"
  - spawn_browser_agent ERROR after "Starting browser agent"
  - Random browser failure
  - three parallel spawn_browser_agent chips fail together
tags:
  - dag
  - param-populator
  - spawn-browser-agent
  - spawn-agent
  - required-tool
  - structured-output
  - sibling-cancel
sources:
  - agent 37b7bb31-8db5-4c7e-806d-d31b7891106f
  - PR #1298
repro: agents/tests/blackbox/dag_executor.blackbox.py::test_execute_dag_parallel_browser_fanout_does_not_cancel_siblings
status: fixed
---

## Problem

Agent `37b7bb31-8db5-4c7e-806d-d31b7891106f` (SMS tattoo-photo edit, created 2026-09-09T03:23:27Z) planned one explore plus three parallel `spawn_browser_agent` tasks. After explore finished, all three browsers posted `Starting browser agent` at 03:26:05. At 03:27:36 the first chip became:

`Error: LLMStructuredOutputError: LLM must call exactly one tool, 'spawn_agent'. Got: ['spawn_agent', 'spawn_agent', 'spawn_agent']`

The other two chips became `Error: Cancelled` one second later. The execute loop recovered at 03:28:14 and spawned three live browsers; the original ERROR chips are the "random browser failure."

Archive searches: `LLM must call exactly one tool spawn_agent`, `LLMStructuredOutputError spawn_browser_agent Cancelled`, `browser replicate github oauth session not sticking`, `required_tool spawn_agent three parallel DAG`. Relative of `2026-07-16-malformed-structured-output-failed-agent-without-regenerating` (structured-output treated as terminal) and `2026-08-04-subagent-success-decided-by-last-event-not-evidence` (one failure cancels siblings). Novel cause: required-tool cardinality rejected a same-tool fan-out.

## Diagnosis

Critical path: planner `set_plan` → DAG ready batch of three `spawn_browser_agent` → alias to `spawn_agent` → `call_llm_activity(..., required_tool="spawn_agent")` → required_tool check → DAG cancel siblings.

1. Each DAG tool task emits an IN_PROGRESS placeholder, then asks the param-populator for exactly one `spawn_agent` call.
2. The shared execute conversation plus three similar photo goals made the model emit three `spawn_agent` calls in one turn.
3. `call_llm_activity` required `len(tool_calls) == 1`, so three valid `spawn_agent` calls raised non-retryable `LLMStructuredOutputError`.
4. After two structured-output attempts the first task failed; `execute_dag` cancelled the other two ready browsers.
5. `_select_param_tool_call` also required `len(tool_calls) == 1`, so even a passed activity would have failed the DAG node. Both gates treated a same-tool fan-out as a contract violation instead of binding the call that matches this task. ClickHouse was unreachable from this VM, so the three raw spawn payloads were not reconstructed; the error `Got: ['spawn_agent', 'spawn_agent', 'spawn_agent']` already proves the activity received three copies of the required tool, not mixed tools.

Deepest owned cause: the required-tool contract constrained the tool family but enforced cardinality=1, while the DAG context describes N same-alias siblings. Sibling failures this also prevents: parallel explore/code/general_purpose param-populator fan-outs that emit one call per sibling.

The later Replicate GitHub OAuth loop on the recovered browsers is a separate auth-session issue, not this first-bad boundary.

## Solution

The populator prompt still asks for one call (best case). Runtime no longer fails the sibling batch when the model emits N copies of that required tool: `call_llm_activity` accepts N>=1 same-tool calls, and `_select_param_tool_call` binds the unique goal match (exact / containment / token overlap). Mixed tools, wrong alias types, and ambiguous goals still fail closed. Changing the prompt wording would be a separate approval-gated edit and is not required to kill this failure class.

10k-agent behavior: O(calls) over a single populator response (typically 1–3 tool calls). No new shared channel, lock, or per-user fan-in.

Permanent suite: `agents/tests/blackbox/dag_executor.blackbox.py` and `agents/tests/blackbox/llm.blackbox.py`. `/deploy` Step 4g runs the agent blackbox runner.

## Human feedback

None recorded.

## Reusable lesson

When a required-tool handoff returns N copies of that same tool, select the call that matches the current task instead of failing the whole sibling batch.
