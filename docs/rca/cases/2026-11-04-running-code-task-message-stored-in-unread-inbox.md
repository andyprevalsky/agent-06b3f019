---
id: 2026-11-04-running-code-task-message-stored-in-unread-inbox
date: 2026-11-04
title: send_message_to_agent to a running background code agent was stored in a task inbox no code agent reads, and reported "Message sent"
surface: cross
component: agent-to-agent-messaging
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentToAgentService.ts sendAgentMessage stored a recipient_task_id USER row (excludeFromModel) for a running code task; only explore/browser activities poll GET /:id/agent-inbox, the code activity never reads it
symptoms:
  - "Message sent to /root/progress_loop."
  - "The message tool reported success, but banana.txt is absent from the final listing."
  - message to a running code agent silently dropped
  - send_message_to_agent to a background code agent never reached the CLI
  - "{\"message_id\":\"…\",\"delivered\":false}"
tags:
  - a2a
  - code-agents
  - background-tasks
  - agent-inbox
  - multi-day
sources:
  - agent 9c84b03a (root, live repro on 28a7bfc99, 2026-11-04 22:46Z)
  - commit 4317820584 (fix, branch fix/code-agent-multiday-t4-parent-orchestration)
  - commit 350c4b429e (review round: per-run session lookup, retry-free code turns)
  - commit f4c70095f (introduced task-inbox messaging, 2026-10-19)
repro: back-end/src/tests/blackbox/agents-agent-messages-code.cases.ts "POST /:id/agent-messages — a message to a running code task reaches its live CLI as a turn"
status: fixed
---

## Problem

Live repro (parent thread, local stack on 28a7bfc99): root 9c84b03a spawned the
background code agent `/root/progress_loop` (a 6-minute Bash loop) and called
`send_message_to_agent` with "Also create a file named banana.txt containing the
word banana before you finish." The tool returned FINISHED "Message sent to
/root/progress_loop." (22:46:03Z). The code agent finished at 22:52:33 with
SUCCESS and no banana.txt; the root concluded "The message tool reported
success, but banana.txt is absent from the final listing."

## Diagnosis

Path: planner → `agents/domains/agent_messaging/handler.py` resolve_message_target
(own in-activity task → target = self, recipient_task_id = run inbox) →
`send_agent_message_activity` → POST /:id/agent-messages → `sendAgentMessage`
→ `createMessage` USER row {recipientTaskId, excludeFromModel}, no signal.
Readers of that inbox: `agents/helpers/agent_inbox.py`, called only by the
explore and browser activity loops. Nothing under spawn_claude_code_agent reads
it, so the row is never consumed. The existing live-CLI primitive
(`deliverUserTurnToCodeSession`, ws-server `user_turn`) was only wired to
agent-graph sends addressed to a code session id and to direct chat.

Step 5a: why possible? The task-inbox contract assumed every activity-backed
task polls its inbox; code tasks are a CLI, not a poller (evidence: grep of
agent_inbox readers). Next rung (design of the inbox) is shared with
explore/browser and correct for them; stop.

Local repro: `cd back-end && bash scripts/run-blackbox-tests.sh agents` with the
new cases; pre-fix: `owner: a running code task must get the turn:
{"message_id":"448b5da8-…","delivered":false}` and `Expected status 409, got
201` for an ended CLI.

## Solution

`sendAgentMessage` now hands a message addressed to a RUNNING code task to
`sendAgentMessageToRunningCodeTask` / `deliverToRunningCodeTask`
(`back-end/src/domains/agents/agentCodeTurnDelivery.ts`) before the inbox
guard (no inbox row is written, so the unread cap does not apply). It finds the
task's current-run code session: the owner's newest rows since the run's
`started_at` (tree state) whose metadata.toolCallId is the task id and that
name a task_id, so a woken run never reaches the previous run's closed session.
It delivers the text as the CLI's next user turn through the same
`deliverToCodeAgent` path agent-graph sends use (sender "agent", turn id from
the sender key, so a retry is `duplicate`), with the retry-free per-sender send
budget. No live CLI → 409 with what to do ("has not started yet; send again once
it runs", or "has finished its turn … resume a paused code agent with
send_message_to_agent(continue_conversation=true); for new work after it
completed, spawn a new code agent"), nothing stored. The code-turn delivery
moved out of agentGraphSendService.ts (one implementation for both senders; no
import cycle). Owner sends and peer sends by address both go through it.

10k agents: per send, one findMany (take 20) over that owner's rows since the
run started ((agentId, timestamp) index range), one session PK read, one
received-row PK read, one ws round trip and one timeline insert. Cost depends
on the owner's rows since the current run, not on the number of agents; no
polling, no fan-in.

Adversarial review (2026-11-04) found the first revision matched run 1's
session for a woken run, charged retries through the inbox guard and scanned
the chip row oldest-first; all three were fixed and covered by
"a woken code task run never gets the previous run session" (also sends a
4-message burst past the guard's 3-message burst).

Golden reference: claude-code-src/src/tools/SendMessageTool/SendMessageTool.ts
~:808-820 queues a message to a running agent for its next tool round;
ws-server merges a mid-turn turn into the running turn the same way.

## Human feedback

None recorded.

## Reusable lesson

A message API must deliver through the recipient's actual input channel or fail; never report "sent" for a row only some recipient kinds read.
