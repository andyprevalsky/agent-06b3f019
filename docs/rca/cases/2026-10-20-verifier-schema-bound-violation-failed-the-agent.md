---
id: 2026-10-20-verifier-schema-bound-violation-failed-the-agent
date: 2026-10-20
title: A verifier reply that broke the output schema's minItems was treated as a verifier failure and failed the agent
surface: agents
component: verifier
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/helpers/llm.py::_call_llm_verifier raised pydantic ValidationError on an `output` bound violation; run_agent counted it as "Progress check failed" and failed after 3
symptoms:
  - "Verifier unavailable after 3 consecutive failures: Progress check failed: 1 validation error(s): output.drafts: List should have at least 3 items after validation, not 2"
  - "Timeout after 904s (task timeout=900s) | Agent status: ACTIVE"
tags:
  - verifier
  - response-schema
  - background-agents
sources:
  - agent 181f5281-001c-4a75-9cf4-66a93bc38dfd (tree-feedback-routing root, FAIL timeout)
  - agent 18ff3ebb-2613-4ebc-a813-0a511205ea45 (outreach_lead, FAILED verifier unavailable)
repro: agents/tests/blackbox/llm.blackbox.py::test_verifier_output_breaking_schema_bounds_is_a_rejection_not_a_failure
status: fixed
---

## Problem

In tree-feedback-routing 181f5281 the outreach lead killed one of its three
drafters (elad_draft) after the user's signature correction. Its evidence then
grounded two drafts. Its `output_schema` required `drafts` with `minItems=3`.
The verifier (gpt-6-sol, structured output with OpenAI strict mode off) honestly
returned two drafts. Pydantic rejected the reply, `check_progress` returned
"Progress check failed: … at least 3 items … not 2" three times (03:41–03:46 UTC),
`run_agent` failed the agent with "Verifier unavailable", and the root spent its
remaining budget recovering the drafts. The task timed out at 904s.

The wake / finished-task changes were not involved: the worker logs contain no
`[background] woke` or `wake_task_id` entries for this run.

## Diagnosis

`_call_llm_verifier` validated the whole reply with the response model. A bound
violation inside `output` is a semantic verdict ("the evidence only supports
two"), but it raised exactly like an unparseable reply, so it was classified as
a verifier outage instead of feedback the agent could act on.

## Solution

`_validate_verifier_response`: when every validation error is under `output`,
keep the verifier's own `reasoning`/`score`, cap the score at 0.5, drop the
invalid output and append the violated bounds to the feedback. An invalid
`reasoning`/`score` still raises. The repro test fails on the previous revision
(missing function) and passes after the fix.

## Reusable lesson

A structured verdict that fails the declared schema because the evidence does not
support it is feedback for the agent, not an outage. Only an unparseable or
verdict-less reply is a verifier failure.

## Human feedback

None yet (fix queued for the deploy approval batch: LLM-visible feedback text).

## 10k agents

No new I/O: one in-process validation per verifier call.
