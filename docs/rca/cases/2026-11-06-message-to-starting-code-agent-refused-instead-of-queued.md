---
id: 2026-11-06-message-to-starting-code-agent-refused-instead-of-queued
date: 2026-11-06
title: A send_message_to_agent to a code agent that was still starting was refused ("has not started yet", later "finished its turn"), so the sender retried blindly or concluded the agent was done
surface: cross
component: code-agent-messaging
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/agents/agentCodeTurnDelivery.ts deliverToRunningCodeTask threw 409 "Code agent session has not started yet" when no session existed, and e2b-templates/claude-code/ws-server.mjs deliverNativeTurn rejected `session_ended` while no CLI was launched; a spawn registers its task at once but has no session (create in flight) and then no CLI (project startup) for minutes, and neither state means "refuse"
symptoms:
  - "Code agent session has not started yet; send again once it runs"
  - "Code agent session has finished its turn, so this message was not delivered"
  - "is a completed code agent ... cannot be messaged"
  - "user_turn_ack status=rejected reason=session_ended" for a session whose CLI had not been launched
tags:
  - claude-code
  - send-message-to-agent
  - startup-window
  - queue
  - idempotency
  - ws-server
sources:
  - agent 9f709385 (integrated-branch exploratory run, reported by the orchestrator)
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82
repro: back-end/src/tests/blackbox/agents-agent-messages-code.cases.ts (agents.blackbox.ts); agents/tests/blackbox/code_session_direct_chat.blackbox.py; back-end/src/tests/blackbox/code-sessions-lifecycle.cases.ts
status: fixed
---

## Problem

Integrated branch, exploratory run agent 9f709385: the code agent's CLI was not
launched until about three minutes after the spawn. A `send_message_to_agent` in
that window failed with `Code agent session has not started yet; send again once
it runs`. A retry after the (short) task had ended failed with `Code agent session
has finished its turn, so this message was not delivered`, and a later one with
`... is a completed code agent ... cannot be messaged`. The sender could not tell
a code agent that had not started from one that had finished, and the message was
never delivered. The user's requirement: messaging a code agent works.

## Diagnosis

A background code spawn registers its task in the owner's tree state at once
(so `send_message_to_agent` resolves it and `runningCodeTaskDelivery` takes it),
but the code agent exists in two steps, each minutes long on a repo:

1. Create in flight. `createWithCodeSession` runs the sandbox create and the repo
   clone (173 s measured on the Rose repo). No session exists; the backend finds
   the spawn's session by the rows the agents activity posts after the create
   returns (`findCodeSessionForToolCall`), so it found none and refused with the
   409 above. The sender was told to retry; the first retry that landed after the
   create got through, the others were wasted.
2. ws-server up, CLI not launched. `runProjectStartup()` runs before
   `runClaudeCli()`; until the CLI exists `deliverNativeTurn` rejected
   `session_ended` (`!cliChild`), which the backend maps to the 409 "has finished
   its turn" text. That is a false finish: the session had not started. A model
   that reads "finished its turn" stops messaging a code agent that is about to
   run.

First bad boundary: both refusals treat "not started yet" as an error state of
the message, when it is a state of the recipient that the message can wait out.

Local repro (fails before, passes after, unchanged tests, original source at
25ea989a9d): `bash back-end/scripts/run-blackbox-tests.sh agents` cases `a message
to a code task still starting is queued...` (before: `Expected status 201, got
409: {"error":"Code agent session has not started yet; send again once it
runs"}`) and `python tests/blackbox/code_session_direct_chat.blackbox.py` cases
`agent_turns_before_the_cli_has_its_task_are_queued...` (before: `rejected
reason=session_ended` for the first and the second turn).

## Solution

A message sent in either window is accepted (the sender is told `queued`) and
becomes the CLI's next user turn right after the task prompt, in arrival order,
exactly once. A message to a session that finished or closed is still the
truthful error with the real state; nothing is reported queued for it.

- Window 1 (`back-end/src/providers/codeSessions/startupTurns.ts`): one row per
  spawn tool call (key `tool:<agent>:<call>`, the create's lease owner) in
  SharedEphemeralState. `enqueueStartupTurn` takes the spawn's lock, re-checks
  whether the session was published, and otherwise appends the turn (bounded:
  10 messages, 100 000 characters; a retry of a queued send is not queued twice
  and costs no send budget). When the create returns, `createWithCodeSession`
  calls `drainStartupTurns` under the same lock (and again on a replayed create):
  it delivers the row's turns in order to the new session's ws-server and
  publishes the session in the same row, so a sender either sees the published
  session or its turn is in the row the drain reads. A woken run reuses the tool
  call id: the sender accepts a published session only if it was created at or
  after the run started, so a woken run queues for its own session. The row is
  deleted when the task closes (`closeClaudeCodeSession`, only by the task that
  still owns the sandbox) and expires after 6 hours.
- Window 2 (`e2b-templates/claude-code/ws-server.mjs`): an agent turn that
  arrives before the CLI is launched is acked `queued` (`queue_position`), held
  (at most 20; the 21st is `rejected startup_queue_full`), and released into the
  delivery chain when the CLI is spawned. From the launch on, every turn waits for
  the task prompt (`taskPromptReady`) before it is written, so ordering no longer
  depends on promise registration order. A retry of a queued id is acked
  `queued`, after the write `duplicate`. If the session ends first, the server
  emits `user_turn_undelivered` with the lost ids and later sends get
  `session_ended`. A user's direct turn in this window is not queued (it carries
  settings and attachments that must be confirmed): it is `rejected
  session_starting`, which the direct chat route maps to a retry message.
- Plumbing: `queued` is a `TurnAckStatus` (TS and Python twins);
  `deliverToCodeAgent` accepts it; the route answers `{delivered: false, queued:
  true, task_running: true}`; `recordCodeTimelineRow` and `codeTurnId` moved to
  `providers/codeSessions/agentMessageRows.ts` so the queue (a provider) writes
  the same timeline rows as the domain.
- Benchmark: `check_message_reached_code_agent` now requires every send to a
  code spawn to be delivered and seen; a send made while the code agent started
  must have been queued then delivered; a refusal ("has not started yet"), a
  queued message that never reached the CLI, and any other failure fail it.

LLM-visible strings (sender, `send_message_to_agent` result):

- queued: `Message queued for {to}: its code agent is still starting. It will receive this as its next turn as soon as its CLI runs, in the order you sent it; do not send it again.`
- queue full (409): `Code agent is still starting and its queue of waiting messages is full; send again once it runs`
- ws-server pre-launch for Codex (409): `Code agent is still starting; send again once it runs`
- finished/closed, unchanged: `Code agent session has finished its turn, so this message was not delivered. Wait for its notification: resume a paused code agent with send_message_to_agent(continue_conversation=true); for new work after it completed, spawn a new code agent.` and `Code agent session is not running`
- user direct chat during startup (409): `The code agent is still starting. Send your message again in a moment.`

10k-agent behavior: one SharedEphemeralState row per code spawn (two with the
existing create record), one lock per spawn, taken only by that spawn's senders
and its create; at most 10 turns and 100 000 characters per row; no polling, no
shared key across spawns, no per-user fan-in. The ws-server queue is per sandbox
and at most 20 turns in memory. Cost per message is a constant number of
queries, independent of how many agents exist.

Not changed: the Codex ws-server still has no startup queue (its pre-spawn
window is the instant between listening and starting its app-server; a turn
there is `session_starting`, now mapped to the 409 above); a queued message that
the CLI refuses after the ack (the CLI ended during startup) is logged
(`A queued code agent message was not delivered`) and surfaces as the task's own
result, the sender is not notified separately.

Golden reference: the LLM-visible strings above are new harness text; they go to
the golden-reference review with the approval items.

## Human feedback

Orchestrator (2026-11-06, C20): a message sent to a code agent during its startup
window must be accepted and delivered when its CLI is up, not rejected; define
the delivery order and exactly-once behavior; a send to a finished or closed code
agent stays a truthful error; the queue is per code-agent session, bounded and
cleaned up at close; state the 10k-agent behavior.

## Reusable lesson

A recipient state that the message can wait out ("not started yet") is not an
error of the message: queue it at the narrowest owner that outlives the wait,
make enqueue and publish one critical section, and keep the refusal for states
that never end ("finished", "closed").
