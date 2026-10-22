---
id: 2026-10-20-cerebras-output-limit-reported-as-tool-calls
date: 2026-10-20
title: A Cerebras reply cut off at its output limit was accepted as a complete tool call
surface: agents
component: rose-client
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/providers/rose/cerebras.py::cerebras_complete passed through finish_reason=tool_calls when completion_tokens == max_completion_tokens
symptoms:
  - "Your final result was truncated in my context after the seventh row"
  - "completion_tokens 8192 finish_reason=tool_calls"
  - "Background explore task ... has completed; explore/browser/code tasks cannot be continued"
tags:
  - cerebras
  - truncation
  - explore
  - rose-client
sources:
  - agent b2726cac-7a84-4825-b8d8-587d6395b0cf (FAIL, forbidden spawn_browser_agent)
  - agent b2726cac-7a84-4825-b8d8-587d6395b0cf explore_agent dump 3c275fab7346 (request f84cc660)
  - commit 6640defb9
repro: agents/tests/blackbox/rose.blackbox.py::test_cerebras_tool_call_at_output_limit_is_escalated_not_accepted
status: fixed
---

## Problem

In b2726cac the explore's FINAL_ANSWER table stopped mid-sentence at row 7
("... with customers including Ramp and Zapier, announced a"). The root tried
to ask the finished explore for the rest and got an error, because completed
explore tasks cannot be continued. It then spawned recovery explores, and
their grep calls failed with "No agent at /root/ai_agent_rounds". Finally it
spawned a browser agent, which the task forbids.

## Diagnosis

The explore's final `explore_agent` call (request f84cc660, Cerebras
qwen-3.8-27b, `cerebras-direct`) has usage `completion_tokens: 8192`, which
equals the requested `max_tokens: 8192`. It produced 23k characters of
reasoning and one `attempt_completion_with_result` tool call. Its strict tool
grammar closed the JSON string early. Cerebras reported
`finish_reason: "tool_calls"`. The worker log shows `finish_reason=tool_calls`.
`call_llm_structured_streaming` escalates to 32768 only on
`finish_reason == "length"`, so it accepted the cut-off result. The explore
then returned it as its final answer.

Archive searches for "cerebras finish_reason tool_calls truncated max_tokens"
and "explore final answer truncated" found no matching boundary, so this case
is new.

## Solution

`cerebras_complete` now reports a usage chunk whose
`completion_tokens >= max_tokens` as `finish_reason="length"`. It also logs
`rose.cerebras.output_limit_reached` with the reported reason. The existing
escalation retry with a larger limit then runs. The `rose` blackbox regression
replays the observed stream shape through the real HTTP builder, Cerebras
parser and `call_llm_structured_streaming`. Before the fix it failed with "a
reply that used the whole output limit must be retried with room to finish".
After the fix it passes, makes exactly two requests with the larger limit, and
returns the complete result.

At 10k agents: this adds one integer comparison per Cerebras usage chunk, with
no shared state. The retry runs only on calls that were cut off.

Still open: a finished explore task's address cannot be resolved by
grep(trace_path) or list_agents after it completes.

## Human feedback

None recorded.

## Reusable lesson

The provider's finish label alone does not prove a reply completed. When
usage shows the whole output limit was spent, treat the reply as cut off.
