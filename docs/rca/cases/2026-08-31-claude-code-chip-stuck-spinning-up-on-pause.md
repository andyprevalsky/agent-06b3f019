---
id: 2026-08-31-claude-code-chip-stuck-spinning-up-on-pause
date: 2026-08-31
title: Claude Code chip stays on Spinning up after pause cancel
surface: agents+front-end
component: spawn-claude-code-agent / ClaudeCodeChip
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_claude_code_agent/handler.py — pause cancel posted session_cancelled without task_id / task_complete
symptoms:
  - Hub FE shows "Claude Code Spinning up..." after agent is PAUSED
  - Agent status banner correctly shows PAUSED
  - Cancel message present in realtime as session_cancelled with no task_id
  - Hub durable transcript ends on agent_observation heartbeats (no task_complete)
tags:
  - claude-code
  - chip
  - pause
  - cancel
  - task_complete
  - spinning-up
sources:
  - agent 182cf2ab-cb85-4437-9c4b-35d3b5afc2a4
  - hub run f1c51827-0132-4e7a-bdc3-241a4b2e80f5
  - task 45ce853d-aa0e-41c4-94b3-dabe3c561562
repro: agents/tests/blackbox/spawn_claude_code_agent.blackbox.py::test_cc_execute_tool_cancelled_status_yields_error; front-end terminal-component-chips blackbox cancel cases
status: fixed
---

## Problem

After a benchmark timeout paused a CUDA-kernel code-agent run, the durable hub
FE kept showing **Claude Code Spinning up...** even though the agent chrome was
correctly **PAUSED**.

## Diagnosis

"Spinning up" is ClaudeCodeChip state, not agent status. Chip terminality is
`action_type === 'task_complete'` on a **task_id-scoped** message (plus live WS).

Pause cancel in the handler yielded:

```text
action_type=session_cancelled  (no task_id)
```

Realtime INSERT confirmed that cancel landed, but without `task_id` the chip
filter ignored it. Even with `task_id`, `session_cancelled ≠ task_complete`, so
`isComplete` stayed false. Hub snapshot ended on `agent_observation` heartbeats
with no `task_complete`. A late heartbeat after cancel could also reopen a chip
that only looked at the last task-scoped message.

Browser cancel already posts `task_complete` with `task_id`; Claude Code activity
cleanup does too, but the handler path (what the workflow posts after pause)
did not.

## Solution

1. **Handler cancel** emits `action_type=task_complete`, `success=false`, and
   includes `task_id` / `code_provider` from the activity result when present.
2. **FE chip derive** treats terminality as sticky (`task_complete` or
   `session_cancelled` anywhere in the task transcript) so a late heartbeat
   cannot reopen the chip.
3. **MessageBubble routing** keeps `session_cancelled` on the ClaudeCodeChip
   path for legacy transcripts.

## Human feedback

User confirmed the hypothesis: Spinning up is the code chip; it flips off
`task_complete` / live WS, not PAUSED; cancel never landed as chip completion.
