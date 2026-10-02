---
id: 2026-09-30-tool-union-validation-summary-hides-selected-branch
date: 2026-09-30
title: Tool union validation summary hid the selected tool's missing argument
surface: agents
component: structured-llm-validation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/utils/error_utils.py _safe_error_text summarized the first five Pydantic union errors without selecting the branch named by the emitted tool discriminator
symptoms:
  - "Failed to parse Rose response as AgentAction (parse attempt 1/3)"
  - "tool_calls.0.WebSearchTool.tool: Input should be 'web_search'"
  - "web_fetch arguments contain objecive instead of objective"
  - "spawn-sub-agents timed out with the Tokyo child ACTIVE"
tags:
  - agents
  - structured-output
  - tool-validation
  - explore-agent
  - benchmark-timeout
sources:
  - agent b50b3e0f-2001-4f65-b156-a540eeba5ade
  - agent 5970809c-6728-45c9-8454-eca5e6b4151b
  - fleet run 1790816317-68296-79066
repro: agents/tests/blackbox/error_utils.blackbox.py
status: open
---

## Problem

The unchanged `spawn-sub-agents` predeploy smoke task timed out after 482 seconds
with the root agent still ACTIVE. The root spawned its two required general-purpose
children. The NYC child completed at 01:09:00 UTC; the Tokyo child continued
researching until the run was paused. Its first explore invocation began at
01:07:44 and was cancelled after about 180 seconds, leaving the parent waiting
for another research attempt.

The captured Tokyo explore LLM outputs at 01:09:29 and 01:10:17 both called
`web_fetch` with `objecive` instead of `objective`. The first output's
`AgentAction` validation correctly rejected the call, but the feedback sent to
the model was five errors for `WebSearchTool` and `PeopleSearchTool`, followed by
`... 6 more`. It omitted `WebFetchTool.objective: Field required`. The second
output repeated the same spelling error. These two calls consumed roughly 47
and 68 seconds, respectively.

## Diagnosis

The first bad boundary was the validation-error summary in
`agents/utils/error_utils.py`: Pydantic evaluated every member of the tool union
in declaration order, while `_safe_error_text` kept only the first five errors.
The chosen `web_fetch` branch appeared seventh. The retry path in
`agents/helpers/llm.py` did include the validation feedback, but that feedback
did not tell the model the field its chosen tool was missing. This is a
tool-schema feedback contract defect, not a spawn/join failure. A related
archive case, `2026-07-03-parallel-provider-subagent-fanout-stalls-until-timeout`,
concerned completed children stuck in a join; this Tokyo child was actively
researching.

The same captured payload, passed to the dynamic `AgentAction` model, reproduced
the misleading eleven-error summary locally. Validating it against the selected
`WebFetchTool` alone yielded the actionable error `objective: Field required`.
No model-intelligence classification is claimed without a controlled model-only
replay. The exact smoke task has not yet passed after this fix, so the benchmark
outcome remains open.

## Solution

`_safe_error_text` now excludes Pydantic union branches with a rejected `tool`
literal when exactly one branch matches the emitted discriminator. It then
summarizes the selected branch's errors, showing one error per tool call before
using the remaining summary slots. This prevents an earlier malformed call
from hiding every error for a later call. Ambiguous or missing discriminators
retain all errors, so validation remains fail-closed. The model's emitted
arguments and the schema are unchanged.

The permanent blackbox uses the captured `web_fetch` typo and five-tool union,
plus a two-call Pydantic error where the first call has five errors.
Before the fix, `venv/bin/python tests/blackbox/error_utils.blackbox.py` failed
because the feedback contained only `WebSearchTool` and `PeopleSearchTool`
errors. The same command passed after the fix and displayed
`tool_calls.0.WebFetchTool.objective: Field required`. The exact unchanged
captured call also passed through `_build_structured_retry_messages` locally:
the feedback named `WebFetchTool.objective` and the `web_fetch` tool-result ID
still paired with the rejected call. The exact unchanged
`spawn-sub-agents` benchmark still needs a passing local run before this case
can be marked fixed.

## Human feedback

None recorded.

## Reusable lesson

Summarize a union validation failure from the branch selected by the emitted discriminator before truncating errors for an LLM retry.
