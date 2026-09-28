---
id: 2026-09-28-explore-compaction-protected-tail-floor-above-trigger
date: 2026-09-28
title: Unbounded explore tool results push protected compaction tail past the overflow trigger
surface: agents
component: run-agent-tool-result-context
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/loop/run_agent.py activity-mode context.append of tool results — no hard cap before explore/grep dumps enter the protected compaction tail
symptoms:
  - "Context compression ineffective: compressed context estimate"
  - "still exceeds trigger 167000"
  - "spawn_agent" toolStatus ERROR with error_reason Context compression ineffective
  - explore agent tokens_in jumps from ~20k to ~140k on one grep iteration
tags:
  - explore
  - compaction
  - grep
  - tool-result
  - context-window
sources:
  - agent a890a362-9775-410c-beb0-c251cd511845
repro: agents/tests/blackbox/run_agent.blackbox.py::test_activity_tool_results_are_hard_capped_before_context_append
status: fixed
---

## Problem

Prod agent `a890a362-9775-410c-beb0-c251cd511845` (Amazon apartment inventory)
spawned explore children that hard-failed with:

```
Context compression ineffective: compressed context estimate 210745 tokens
still exceeds trigger 167000 (original estimate 228460).
```

and

```
Context compression ineffective: compressed context estimate 182858 tokens
still exceeds trigger 167000 (original estimate 183388).
```

`spawn_agent` ERROR chips carried `agentType: explore` and
`error_reason` with those strings. LLM usage on the first failure showed
iteration 3 `tokens_in=139694` after a successful grep — then compaction
ran and could not get under the 167k trigger.

## Diagnosis

Archive searches (`Context compression ineffective`, `explore context overflow`,
`compressed context estimate still exceeds trigger`) hit the related prior case
`2026-08-04-compaction-token-accounting-asymmetry-grows-context` (estimator
asymmetry — fixed). This incident is a **relative**, not a recurrence of that
estimator bug: savings were positive (~7.7% and ~0.3%) but the floor stayed
above the trigger.

Critical path:

1. Explore activity builds a clean `initial_context` and runs `run_agent` with
   `poll_messages=None` (`spawn_agent/service.py`).
2. Grep returns large match dumps (email/message bodies) as `message` JSON.
3. `run_agent` appends the full tool result into context with no size bound
   (web_fetch already uses `summarize_tool_result`; grep does not).
4. Head/tail-protected compaction keeps recent TOOL turns verbatim
   (`HEAD_TAIL_PROTECTED_TURNS`); a single oversized dump in the tail cannot
   be summarized away.
5. `compressed_tokens >= compaction_trigger` → explore returns
   `status=error` with the compression-ineffective message.

Step 5a ladder:

- Why 1: compaction stayed above 167k.
- Why 2: protected tail still held ~180–210k of tool payload.
- Why 3: activity-mode append had no hard cap (web_fetch had one; grep shared
  the uncapped path). **Deepest owned cause.** Sibling: any large
  activity-mode tool result (future tools, huge error blobs).

## Solution

Reuse the existing `TOOL_RESULT_HARD_CAP_CHARS` (50k) at the shared
activity-mode append boundary via `hard_cap_tool_result_text()` in
`helpers/summarize.py`, applied in `run_agent.py` when `not poll_messages`
before TOOL rows enter context (success and error paths).

Cemented by
`test_activity_tool_results_are_hard_capped_before_context_append`
(pre-fix: 520000-char grep result in context; post-fix: capped with
`truncated, original_len=` marker).

10k-agent behavior: O(1) string slice per tool result on the activity path;
no new fan-in, queries, or broadcasts.

## Human feedback

None recorded.

## Reusable lesson

Every tool result that enters an activity-mode agent context must share the
same hard size bound — a summarizer on one tool does not protect siblings
that dump raw JSON into the protected compaction tail.
