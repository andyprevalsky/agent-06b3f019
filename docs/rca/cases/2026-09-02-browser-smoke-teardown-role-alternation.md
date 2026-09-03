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

Pre-deploy smoke failed `browser-smoke` with role_alternation even though the
agent completed the example.com heading task successfully.

## Diagnosis

FE teardown posted FINISHED on the spawn `toolCallId` without
`excludeFromModel`, so the model-facing transcript lost the spawn tool result
and showed consecutive assistant tool-calling turns.

## Solution

Mark FE-only browser teardown terminal events `excludeFromModel` so they do not
mutate the spawn tool result the context validator / model transcript require.

## Human feedback

Smoke aborted on context validation while the durable FE agent had already
succeeded; failure was harness dual-write, not task failure.

## Reusable lesson

FE-only side effects that reuse a toolCallId must be excluded from the model
context, or dedup/role_alternation validators will fail a successful agent.
