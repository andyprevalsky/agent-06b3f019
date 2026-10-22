---
id: 2026-10-20-explore-final-answer-accepted-over-unread-message
date: 2026-10-20
title: An explore's final answer was accepted over an agent message stored during its last LLM call
surface: agents
component: agent-inbox
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_agent/service.py explore_execute_tool accepted attempt_completion_with_result while agents/helpers/agent_inbox.py held the message for the next step
symptoms:
  - "Message sent to /root/<task>. (but the explore finished without reading it)"
  - "Background explore task ... has completed; explore/browser/code tasks cannot be continued"
  - "Forbidden tool 'spawn_browser_agent' was called"
tags:
  - background-agents
  - explore
  - agent-inbox
  - a2a
sources:
  - agent 7166707a-a447-4cbe-bef1-41f45ac95ac3 (FAIL, forbidden spawn_browser_agent)
  - commit df9d863e7
repro: agents/tests/blackbox/spawn_agent.blackbox.py::test_explore_reads_a_message_stored_before_its_final_answer
status: fixed
---

## Problem

In 7166707a, the root forwarded the "Led by <investor>" requirement to its
running explore at 02:18:31.95. The send returned "Message sent". The explore's
final `explore_agent` call had started at 02:18:30.0, and it returned
`attempt_completion_with_result` at 02:18:36.3. No explore dump contains the
forwarded text. The root then asked the finished task for lead evidence, got
"cannot be continued", and spawned a browser agent. The benchmark forbids that
tool.

## Diagnosis

An explore reads its inbox through the per-step progress post, and the
messages that read returns are delivered at the next step
(`helpers/agent_inbox.py`, "one step late"). There is also a 30s GET fallback.
If a message is stored while the final LLM call is running, it is stashed for a
step that never comes, because completion is accepted unconditionally. Earlier
runs (b2726cac, 4cf417f1, 1469eaed) happened to store the message 2 or more
steps before the final step.

Archive searches for "explore inbox message one step late finished without
reading" and "agent message stored before completion" found no prior case, so
this case is new.

## Solution

The explore's completion now performs one inbox read through
`AgentInbox.unread_before_finish`. If messages are waiting, the completion is
returned as a tool error with the text "Result not delivered: a new message for
you arrived before it; the message follows." The existing completion-rejected
path then continues the loop, and the stashed message reaches the next LLM call
exactly once. This is a new model-visible string and needs approval. The
`spawn-agent` blackbox regression drives the real
`spawn_explore_agent_activity`. Before the fix it failed with "a final answer
must not be accepted over an unread message". After the fix it passes and
asserts exactly one GET per completion attempt.

At 10k agents: there is one extra bounded indexed inbox GET per explore
completion attempt, and none per step.

## Human feedback

None recorded.

## Reusable lesson

When reads are batched one step late, a terminal transition must flush the
batch first. Otherwise a message that arrives during the last step is lost.
