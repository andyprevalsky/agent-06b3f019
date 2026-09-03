---
id: 2026-09-02-browser-smoke-teardown-role-alternation
date: 2026-09-02
title: Browser FE teardown FINISHED reused spawn toolCallId and aborted smoke with role_alternation
surface: agents
component: spawn-browser-agent-v3 / context-validator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "agents/domains/spawn_browser_agent_v3/handler.py `_emit_browser_task_terminal_for_fe` — posts FINISHED teardown on the spawn toolCallId without excludeFromModel"
symptoms:
  - predeploy smoke browser-smoke fails with role_alternation dual-write
  - agent actually completed the example.com heading task
  - OAI view shows consecutive tool-calling assistants (spawn then attempt_completion)
  - only "Browser session closed after teardown" remains as the spawn tool result
tags:
  - browser-smoke
  - context-validator
  - role-alternation
  - exclude-from-model
  - teardown
sources:
  - agent dabeeb92-8607-4a38-8762-61878aa0dfbd
  - PR #1197
repro: agents/tests/blackbox/context_validator.blackbox.py::test_browser_teardown_exclude_from_model_preserves_spawn_tool_result
status: fixed
---

## Problem

Pre-deploy smoke failed `browser-smoke` (5/6) with:

`Context validation error: [role_alternation] Consecutive assistant messages at OAI indices 3 and 4`

The durable FE agent completed successfully (`Example Domain`), but the
benchmark aborted while status was still `ACTIVE` because the final message
list failed context validation.

## Diagnosis

Timeline on agent `dabeeb92-8607-4a38-8762-61878aa0dfbd`:

1. ASSISTANT declares `spawn_agent` / `toolu_01PCzo…`
2. Parent-visible FINISHED `"Browser automation complete"` with structured_response
3. ASSISTANT declares `attempt_completion`
4. Later FINISHED `"Browser Session Closed"` / `"Browser session closed after teardown"` reuses the same `toolCallId`

`_emit_browser_task_terminal_for_fe` (added to close FE live chips on
timeout/cancel) intentionally reuses the spawn `tool_call_id` so the panel can
associate the terminal. It did **not** set `excludeFromModel`.

Latest-FINISHED-per-toolCallId dedup (validator + `collapse_duplicate_tool_results`)
then kept only the empty teardown row. Because that row's wall timestamp is after
`attempt_completion`, the unmerged OpenAI view became:

`assistant(spawn) → assistant(attempt_completion)` with no tool result between —
exactly the dual-write detector's hard error.

Local repro: validate the captured message list → role_alternation. Mark the
teardown `excludeFromModel=True` and skip excluded rows before dedup → clean.

## Solution

1. `_emit_browser_task_terminal_for_fe` posts `extra_metadata={"excludeFromModel": True}`
   so the FE chip-close row stays UI-visible but never enters model context.
2. `context_validator._convert_to_openai_format` drops `excludeFromModel` rows
   before terminal dedup (mirrors `drop_rows_never_sent_to_model`).
3. Cemented blackbox: buggy teardown shape fails; excluded teardown passes.
   Cleanup emitter asserts `excludeFromModel`.

## Human feedback

None recorded.

## Reusable lesson

FE-only lifecycle terminals that reuse a real toolCallId must set
`excludeFromModel` (or use a distinct id that panels can still resolve). Otherwise
post-completion cleanup silently replaces the model-visible tool result and
harness validators report corruption that never existed at LLM call time.
