---
id: 2026-11-08-stopped-code-agent-direct-turn-refused-instead-of-resumed
date: 2026-11-08
title: A user message to a stopped code agent returned 409 instead of resuming its persistent session
surface: cross
component: claude-code-direct-chat
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/claude-code/directChatService.ts requireOwnedLiveSession — any non-ACTIVE session threw 409 CODE_SESSION_CLOSED although the session is persistent and resumable
symptoms:
  - "This code session has finished. Ask Rose to continue the work."
  - "409 CODE_SESSION_CLOSED POST /api/claude-code-session/:taskId/turns"
  - message to a paused / completed code agent errors in the code-agent view composer
  - "completed browser and code agents cannot be messaged"
  - "output_schema is required for Claude Code agent - parent agent must provide structured output schema in tool call"
tags:
  - code-agent
  - direct-chat
  - persistent-session
  - resume
sources:
  - plan:back-end/src/domains/claude-code/directChatResume.ts
  - agent 91cd1296-4fff-46a8-9e1f-fd67e0aaabbf
repro: back-end/src/tests/blackbox/claude-code-direct-chat.blackbox.ts ("a message to a stopped code agent resumes it instead of failing"); agents/tests/blackbox/agent_control.blackbox.py (user_message_resumes_completed_code_task); front-end/src/tests/blackbox/code-agent-resume-on-message.blackbox.tsx
status: fixed
---

## Problem

Typing in the code-agent view of a code agent that had stopped (its run ended
paused/idle, completed or failed) failed with "This code session has finished.
Ask Rose to continue the work." The user expects the session to unpause and
pick up where it left off, with the container's progress shown beside the
message's time.

Local repro (backend blackbox, real ws-server, mocked persistence): POST
`/api/agents/:id/code-agent/<closed task>/messages` with a paused background
code task under a running owner → `expected: 200, actual: 409`
(`CODE_SESSION_CLOSED`).

## Diagnosis

- FE `useDirectTurn` → POST `/claude-code-session/:taskId/turns` →
  `sendDirectTurn` → `requireOwnedLiveSession`, which threw 409 for any session
  whose status is not ACTIVE or that has no stream URL (directChatService.ts).
- The resume machinery already existed, but only for agent senders: the owner
  workflow's `receive_agent_message {wake_task_id, continue_conversation}`
  starts the task's next run; the persistent CodeSession resumes the paused
  sandbox and the CLI continues its conversation (`--resume`) with the
  message as its next turn. The direct-chat path never used it.
- The workflow refused every completed/failed code task
  (`background_message_refusal`), a rule written for model senders, so even a
  wired wake would have refused a completed code agent.
- The FE view was keyed by one task id; a resumed run gets a new task id
  under the same spawn tool call, so its output would not appear in the open
  view.

## Solution

- Backend `directChatResume.ts`: a turn to a stopped session never refuses. The
  routing is:
  - A later live run of the spawn takes the turn.
  - If a resume is already starting, the turn is queued in the spawn's startup
    row (`startupTurns.ts`, with a person variant that carries the turn's own
    id, files and settings).
  - If the owner is running, its background code task is woken
    (`receive_agent_message` with `from_user`, `continue_conversation` and
    attachments).
  - Otherwise (owner finished or paused, or a foreground spawn),
    `CodeAgentResumeWorkflow` runs the existing spawn manager on the stopped
    session's `code_session_id` with the same tool call id. The CLI continues
    with `--resume`.
  - Every path answers `queued` and persists the turn row with
    `resume_requested` after its run is started.
- Agents: a `from_user` wake may resume a completed or failed code task, and its
  attachments are forwarded. A refused user wake posts a UI-only ERROR row so the
  turn reads "Couldn't resume: <reason>". The new workflow is registered beside
  AgentWorkflow and included in the replay-surface hash.
- FE: `queued` is a successful send. Runs of one spawn are merged into the open
  view. `UserBubble` shows the time plus resume state (Resuming… / Starting
  container… / Delivered / Couldn't resume), derived from the spawn's rows.
- Round 3: supervised runs write under `code-resume:<agent>:*`, which the
  backend binds to the owner's live generation (`codeResumeGeneration.ts`). The
  run gets a pause signal (sent by the owner's pause), a generation handoff
  (continue-as-new carrying the drained session), and on any failure a
  "could not resume" row plus a non-retryable failure. A refused or failed
  resume ends the in-flight marker, and queued turns are kept. `cli_settings`
  on the create request applies the person's model, effort and speed to the
  first resumed turn. A paused background browser resumes from the Browser
  composer (the turn goes to the run's inbox and wakes the owner with
  `continue_conversation`). Rose agents get `resumedFrom`, so their bubbles
  show a resume status too.
- 10k agents: per typed turn there is one owner lookup, one ephemeral marker and
  one signal or workflow start. Nothing fans in and nothing polls.

## Human feedback

User (2026-11-08): "when I send a message to an agent that has stopped working,
it shouldn't error, it should just unpause the session and pick back up where it
left off (the state of the container coming back online should be reflected in
the user message next to the timestamp)".

## Reusable lesson

When a resource is persistent and resumable, a user action against its stopped
state must route through the existing resume path rather than refusing as if it
were destroyed; check for a resume mechanism that only another caller type uses.

## Recurrence — November 10, 2026: accepted resume never reached session creation

The user reported that agent `91cd1296-4fff-46a8-9e1f-fd67e0aaabbf`
did not unpause when messaged and required user messages to unpause by default,
then explicitly requested `/rca` followed by `/push`.

The root bug-report lookup returned HTTP 200 with no report. Captured runtime
evidence distinguishes two paths:

- Earlier diagnostic root messages were internal USER rows marked
  `metadata.agentMessage=true`. Those are agent notifications and correctly
  preserve an explicit user pause. Genuine person-authored root messages
  already route through `deliverUserMessageToWorkflow`, including regular
  internal-key USER sends; workflow-authored writes remain negative controls.
- A direct user turn to stopped code task
  `e8869bd9-8496-45f6-8709-a1f05b751639` was accepted as queued/resuming.
  Workflow `code-resume:91cd1296-4fff-46a8-9e1f-fd67e0aaabbf:69aecaa2-dbae-80d1-97c0-ae14021e9bcb`
  reached activity attempt 9 with the literal missing-schema error above.
  No new diagnostic task was created. The diagnostic workflow was canceled;
  the original user workload was left paused.

### First bad boundary and why the earlier fix missed it

`agents/workflows/code_agent_resume.py:resume_tool_call` created a code spawn
without its required `output_schema`. The real spawn activity rejected those
arguments before its bounded error handler, while the Temporal retry policy
allowed unlimited crash retries. The request could therefore acknowledge
resumption while retrying the same invalid arguments indefinitely. This is
`logical-inconsistency-in-harness-contracts`, not an environment/credential or
model-intelligence failure.

The earlier workflow tests used a permissive fake spawn activity. They proved
the supervisor lifecycle but never exercised the actual activity's contract.
The new permanent case in `agents/tests/blackbox/code_agent_resume.blackbox.py`
executes the real Temporal workflow, spawn manager and spawn activity, mocking
only external session/provider effects. It checks session acquisition with the
same persistent session ID and user turn for both Claude and Codex, the actual
standard handoff schema, and a successful terminal tool row.

### Identical local reproduction: red to green

From `agents/`:

```bash
BLACKBOX_CASE_FUNCTIONS=test_user_turn_resumes_through_the_real_code_activity,test_spawn_activity_requires_output_schema venv/bin/python scripts/run_blackbox_tests.py code-agent-resume spawn-claude-code-agent
```

On buggy main `1ff6eacaa68f4e6fbff26a641f61cb5d8bf5487f`, the selected
cases failed in 2.4 seconds: session create was awaited zero times, and missing
schema raised a retryable `ValueError`. After the fix, the unchanged command
passed both selected cases in 1.5 seconds. This is a partial case-filtered
causal reproduction; full-suite verification is recorded separately.

The backend `agents` blackbox domain also passed all 334 cases, including
person-authored and regular internal-key messages resuming PAUSED roots and
workflow-authored USER rows preserving the pause. A supplemental local Temporal
probe executed the real activity with absent schema and unlimited retry policy:
one activity attempt, typed nonretryable failure, no sandbox allocation.

### Fix and reference comparison

Supervised user turns explicitly declare `output_schema={"fields":[]}`: they
have no planner requesting additional custom fields, and their results are
UI-only. The existing handoff builder still requires the complete standard
`rose_handoff` object (status, summary, branch, commit, PR URL and merged state).
Owner-driven background wakes retain their existing planner-defined schemas.
Missing-schema validation now raises typed nonretryable
`CODE_AGENT_OUTPUT_SCHEMA_REQUIRED` before installing heartbeat state or
allocating a sandbox. Transient crash/deploy retry behavior remains intact.

Golden references inspected: `codex/codex-rs/core/src/session/turn.rs:1586`
and `codex/codex-rs/core/src/client.rs:1036` explicitly carry the result schema
into the request; `openclaw/packages/retry/src/index.ts:397` classifies and
bounds retry attempts. This repair converges on explicit execution contracts
and nonretryable deterministic validation. Reference paths refer to the
local reference repositories, not shipped Rose code.

Archive searches used `user message paused agent resume agentMessage` and
`output_schema required code agent resume`; the independent reviewer also
searched `output_schema is required CodeAgentResumeWorkflow` and
`user message paused resume userControlPaused`. The stopped-code case is a
recurrence; the October 1 SMS pause case reinforces preserving the distinction
between genuine user input and workflow-authored USER rows.

### Human feedback for the recurrence

User: "we need to make sure that any user message unpauses by default" and
"/rca then /push". The repair addresses the missing stopped-code execution
boundary without treating automatic agent notifications as a new user intent.
