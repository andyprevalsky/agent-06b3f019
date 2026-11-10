---
id: 2026-11-08-direct-chat-hold-blocked-finished-code-agent-result
date: 2026-11-08
title: A finished code agent's result never reached its parent while the user held the session in direct chat, so the root hung
surface: cross
component: code-session-direct-chat
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: e2b-templates/claude-code/ws-server.mjs onCliTurnResult kept the direct hold until hand_back or the 10-minute idle timer, and agents/domains/spawn_claude_code_agent/service.py never ends the monitor while direct_chat_active, so a goal finished during a user's turn was not reported
symptoms:
  - "[ClaudeCode] SDK result observed; arming post-result exit grace" followed by no "Task Complete" for 5+ minutes
  - "Message delivery failed: The user is talking to this code agent directly; send again after they hand it back"
  - "Not yet. The code agent is still verifying the update card change."
tags:
  - claude-code
  - direct-chat
  - code-agents
  - handoff
sources:
  - agent 0874662a-afaf-4d24-b411-af99649108ad
  - task e2a7379d-c77d-4eb6-8953-554b999ab617
repro: e2b-templates/claude-code/goal-turn.test.mjs ("a user's direct turn that writes the handoff hands the session back at once"), run by agents/tests/blackbox/spawn_claude_code_agent.blackbox.py
status: fixed
---

## Problem

Andy steered code agent find_update_card ("i'm talking about the auto updater
btw") at 03:59:41Z. The agent finished and wrote its result at 04:03:59 ("SDK
result observed; arming post-result exit grace"), but the parent root stayed in
`wait_for`. It told Andy "Not yet" at 04:09:21, and its `send_message_to_agent`
was refused because the user held the session.

Code agents also had no explicit end condition. Their task text did not say the
run ends by writing the result handoff, and one ended its turn with a question
for the user.

## Diagnosis

1. A user turn sets `directHold` (ws-server deliverNativeTurn).
2. While held, onCliTurnResult only re-arms the 10-minute idle timer, never
   endCliStdin.
3. The worker monitor (service.py, the `direct_chat_active` guard) never ends
   the attachment on post-result grace while held.

Result: about 13 minutes of dead time (10-minute idle plus 180 s grace) after
the goal was met. Reproduced in goal-turn.test.mjs: with the fix removed, the
held session never ends ("timeout waiting for CLI exit"); with the fix, it hands
back at once.

## Solution

Every code-agent task starts as the harness's native goal:
- Claude Code `/goal <task + end condition>`.
- Codex app-server `thread/goal/set` (the app-server has no slash commands).

The end condition is writing /home/user/.rose/handoff.json valid against
handoff.schema.json, with standard `rose_handoff` fields: status, summary,
branch, commit, pr_url, merged. There is no question field; questions are told
to be assumptions.

When a user's direct turn finishes while the goal's handoff exists, the
ws-server releases the hold ("goal handoff written"), so the monitor reports
the result immediately. The worker keeps the Codex attachment open while its
goal is active, because mid-goal turns are not the end.

10k agents: per-session state only.

## Human feedback

Andy:
- Every coding agent gets `/goal` as the first word, with the final end
  condition (write the output-schema file).
- No question in the standard fields.
- Code agents never ask questions; they assume.
- "doesnt claude have a func for goal? we shouldnt make a new 1": the Rose-side
  auto-answer loop was removed in favour of the native goal evaluator.

## Reusable lesson

When a user can take over an agent mid-run, its completion signal must not depend on the user handing it back.
