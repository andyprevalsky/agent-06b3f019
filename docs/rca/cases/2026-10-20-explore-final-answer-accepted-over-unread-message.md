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
  - "Agent messages sent to this explore agent that arrived after it finished:"
  - "Declared evaluator smoke_rfc_semantics failed: ... The routing requirement is not met"
tags:
  - background-agents
  - explore
  - agent-inbox
  - a2a
sources:
  - agent 7166707a-a447-4cbe-bef1-41f45ac95ac3 (FAIL, forbidden spawn_browser_agent)
  - commit df9d863e7
  - agent 6e3693b3-23b0-4c3d-b38a-453e835599d6 (recurrence 2026-10-25, background-agent-message-smoke r001-j0008)
  - agent 9a1eea7c-2523-49ee-b31f-914e0a7c1f86 (recurrence 2026-10-25, r002-j0043)
  - commit 2289dacef
  - commit b84939604
repro: agents/tests/blackbox/spawn_agent.blackbox.py::test_explore_reads_a_message_stored_before_its_final_answer; agents/tests/blackbox/spawn_agent.blackbox.py::test_explore_message_stored_during_a_tool_batch_reaches_the_final_turn
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

### Recurrence 2026-10-25 (descend-full69 BG)

Both copies of background-agent-message-smoke on 016fca859 failed the LLM
judge: the explore never acted on the forwarded marker, and its result said
"Agent messages sent to this explore agent that arrived after it finished".
The root spawned the explore in the background both times (wait_for showed it
"running" when the follow-up arrived) and forwarded with
send_message_to_agent to the same task, so the root's spawn choice and prompts
were not the cause.

Why the earlier fix stopped holding: MA4 (aa25bf7aa, Andy: inbox reads must
never block) turned the completion read into a background read that the
completion does not wait for. The only other reads were the progress-post
piggyback, which answers when a model turn ends and before its tools run,
and a 30s fallback GET. In 6e3693b3 the post read ran at 02:02:56, the
message was stored at 02:03:03 during a 21s web_fetch batch, and the final
turn started at 02:03:17 with no read since. The completion at 02:03:42 found
nothing fetched, was accepted, and finish() handed the message to the root
(GET /agent-inbox at 02:03:42.29). 9a1eea7c: message at 02:03:00, final turn
02:03:10, same path. The root then added the marker itself.

Fix (2289dacef, non-blocking): every model turn starts one background GET
alongside its model call (`AgentInbox.next_step_messages`), so a message
stored before the turn starts is fetched while the model runs and defers the
completion through the existing path. The 30s fallback and `_last_read_at`
are deleted. b84939604 (adversarial review) makes the per-turn read
`fresh`. Previously, a read still in flight from before the tool batch (each
read is bounded to 5s) could suppress the turn's read.
Messages stored during the final model call still go to the parent at
finish(), which keeps them from being lost. The explore does not act on
them. That window can also widen if the turn's own read is slower than the
final model call.
Copy-2 evidence (9a1eea7c worker.log): send_message_to_agent at 02:03:00.39,
final explore_agent rose.complete.start at 02:03:10.79, the only explore
progress posts at 02:02:56.45 and 02:03:24.58, and backend GET /agent-inbox
at 02:03:24.60 followed by "[AgentInbox] delivered agent messages" at
finish.
The root's spawn choice is not a variable here: Rose spawns are always
background (loop/dag_executor.py, "Planned spawns ... start in the
background like LLM spawns"). Both copies used wait_for while the task ran.
claude-code-src/src/tools/AgentTool/prompt.ts:263 makes background opt-in
for its own blocking-default tool, so no prompt change applies.
Golden reference: claude-code-src/src/tools/SendMessageTool/SendMessageTool.ts:809-819
queues a message to a running agent "for delivery ... at its next tool
round", and src/utils/attachments.ts:1084-1100 drains that queue into
every turn. claude-code-src/src/tools/SendMessageTool/SendMessageTool.ts:822-835
auto-resumes a stopped agent with the message. Rose now matches next-round
delivery. It does not yet auto-resume a finished explore. Red: the new
regression failed on 016fca859 with "the final answer must not be accepted
over a stored message". Green: it passes on 2289dacef, and the spawn-agent
domain passes.
At 10k agents: at most one extra bounded indexed (agentId, timestamp > since)
GET per explore model turn, never awaited. That is up to 2k req/s at one
turn per 5s, versus about 333 req/s from MA4's 30s fallback, so inbox read
load is about double MA4's. Each read is the same per-agent indexed range
(about 8ms in the captured runs) with no shared row or lock. The rate is the
cost of making each turn see messages stored before it.

## Human feedback

None recorded for the original case. For the recurrence, Andy (MA4,
2026-10-25) said "inbox checks should be done in parallel as much as possible
and never block" and "don't lose messages / consume them and throw them away
in a race". The fix keeps every read in the background.

## Reusable lesson

When reads are batched one step late, every turn, the terminal one included,
must see messages stored before it started. With non-blocking reads, start
one read alongside each model turn rather than relying on a read that
predates the turn's tools.
