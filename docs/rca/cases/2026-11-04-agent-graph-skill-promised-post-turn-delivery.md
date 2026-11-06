---
id: 2026-11-04-agent-graph-skill-promised-post-turn-delivery
date: 2026-11-04
title: The agent-graph skill told code agents replies arrive after their turn, but ws-server ends the CLI's stdin when an autonomous turn finishes; the dead question path gave false coverage
surface: harness
component: rose-skills-agent-graph
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/assets/rose-skills/agent-graph/SKILL.md "Messages sent to you arrive as a new user turn after your current turn" contradicts e2b-templates/claude-code/ws-server.mjs onCliTurnResult (ends stdin after an autonomous turn; later turns rejected session_ended)
symptoms:
  - "Messages sent to you arrive as a new user turn after your current turn."
  - "Code agent session has finished"
  - "Code agent session is not running"
  - "(The parent-LLM relay below is unreachable"
  - a code agent asked its parent a question, ended its turn and never received the answer
tags:
  - code-agents
  - rose-skills
  - a2a
  - dead-code
sources:
  - commit 314bc343a (code agents cannot ask questions)
  - commit 4317820584 (fix)
repro: agents/tests/blackbox/prompt_invariants.blackbox.py test_agent_graph_skill_states_when_messages_reach_a_code_agent
status: fixed
---

## Problem

The agent-graph skill (read by every code agent) said a reply arrives "as a new
user turn after your current turn". ws-server.mjs merges a turn written while
the CLI works into the running turn, and `onCliTurnResult` ends stdin once an
autonomous turn finishes with nothing queued; any later turn is rejected
`session_ended` (backend 409 "Code agent session has finished"). A code agent
that asked its parent something and ended its turn could never get the answer.

Separately, the old question path (markAwaitingParent, the keepalive
awaiting_parent branch, call_parent_llm, the "The code agent asked you:"
result text) had no production writer since 314bc343a; its tests
(code_sessions question_* cases, code-sessions.blackbox.ts keepalive question,
call_parent_llm_* cases) covered unreachable code.

## Diagnosis

Two descriptions of one delivery contract (skill text vs ws-server) drifted.
Repro: `python scripts/run_blackbox_tests.py prompt-invariants`, pre-fix
`AssertionError: a finished turn receives no later messages`.

Step 5b climb (prompt edit). Class C: the skill misstates when a code agent can
receive a message. C+1: the delivery contract has two sources of truth (skill
prose and ws-server). A coherent C+1 fix would generate the skill sentence from
the ws-server contract, but skills are static Markdown read by the CLI and the
contract is behavioural (stdin lifetime), so there is no data to derive from;
the coherent repair is to make the text state the implemented behaviour and pin
it with an invariant test. Keeping stdin open after the autonomous turn to make
the old text true would need an idle bound (a new timeout) and contradicts the
C11/W3 lifecycle; rejected.

## Solution

Skill: "A message sent to you while you are still working is added to your
current turn. Once you finish your turn, your run is over and later messages do
not reach it, so put any open question or blocker in your final result for the
agent that started you." Pinned by the prompt-invariants test. The dead question
path and its tests were deleted (Step 6a: delete), the keepalive response no
longer carries awaiting_parent, and the keepalive config comment no longer
describes questions. The code-agents list API keeps its `awaiting_parent` field
(always null now) to avoid a Zod/API change; removing it and the
ClaudeCodeSession.awaitingParent column is a follow-up.

Golden reference: claude-code-src/src/tools/SendMessageTool/SendMessageTool.ts
~:808-820 delivers to a running agent "at its next tool round"; a stopped agent
is resumed explicitly.

## Human feedback

None recorded.

## Reusable lesson

When prose describes a runtime contract, pin the prose with a test against the implementation, and delete code paths with no writer instead of keeping their tests.
