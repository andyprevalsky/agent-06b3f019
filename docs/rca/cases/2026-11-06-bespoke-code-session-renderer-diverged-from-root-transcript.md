---
id: 2026-11-06-bespoke-code-session-renderer-diverged-from-root-transcript
date: 2026-11-06
title: The code-agent view and card used a bespoke renderer that made empty and duplicate "Worked for" rows and hid the agent's settings
surface: front-end
component: code-agent-view
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/hooks/codeSessionTurns.ts SessionBuilder (code-session work slots) + components/code-agent-view/CodeSessionMessages.tsx WorkSlot, a second transcript renderer beside the root's groupTrajectoryWork
symptoms:
  - "Worked for 35.8s" and "Worked for 35.8s · Ran 3 commands" shown twice for one code-agent turn
  - Opening the Worked drawer in the code-agent view shows nothing (empty "Worked for 1m 42s")
  - "Session settings unavailable" under the code agent's query box
  - "Claude Code Active" card with Cloud, Open app; "Committed 75d1b1d on rose/rose-repo-status-1a3d495c" rows
  - No work by the code agents is visible in the FE; code-agent query box shows no model, speed or context usage
tags:
  - code-agent
  - claude-code
  - transcript
  - worked-for
  - code-agent-view
sources:
  - agent 1a3d495c-826c-4eca-afe0-382fcbf72e82 (prod, "Rose Repo Status", 2026-11-06)
  - agent 9c3c19a0-5596-4854-acdc-1685da1ef942
  - agent 6f8f8f4d-c670-4bc8-b5df-e2c785c4a908
repro: front-end/src/tests/blackbox/code-agent-view-transcript.blackbox.tsx
status: fixed
---

## Problem

Andy reviewed the root agent "Rose Repo Status" (prod 1a3d495c, Rose repo attached)
and called the code-agent UI "super jank". In the root transcript the code agent was
a separate card with a Claude header ("Claude Code Active", "Cloud", "Open app",
Maximize, an in-card transcript and steer input) and, after it finished, extra rows
"rose/rose-repo-status-1a3d495c → main · pushed" and "Committed 75d1b1d on …" (75d1b1d
was only origin/main's HEAD: 0 local commits). The code-agent view showed an empty
"Worked for 1m 42s" drawer for code agent 9c3c19a0. For 6f8f8f4d it showed two rows,
"Worked for 35.8s" and "Worked for 35.8s · Ran 3 commands". Its query box read
"Session settings unavailable" and showed no model, speed or context usage.

Runtime evidence (prod, read-only):
- The owner's Message rows hold 68 persisted code_transcript batches for 6f8f8f4d
  (Bash runs, thinking, assistant text, result): its work existed.
- 9c3c19a0 has only the goal record. ClickHouse: its CLI emitted `final` exit 0 at
  04:19:26, 2 s after start, with the only output "[Project] Running startup script
  for Rose". Three ClaudeCodeSession rows were created on the same sandbox for one
  spawn (Render: 4 ws-server overlays at 04:16:36/04:19:07/04:19:25/04:21:17). That
  upstream session churn is Lane A's (C1); the FE still drew an empty work row for it.
- GET /claude-code-session/:task/capabilities requires a live session (502 when
  ended), so the composer printed "Session settings unavailable". Nothing persisted
  carried the CLI's model/speed or a per-call context size.

## Diagnosis

Path: ws-server events → worker CodeTranscriptBuilder → owner Message rows
(code_agent_events) → FE codeSessionTurns.buildCodeSession → WorkSlot (view) /
DesktopCodeAgentChip (root).

First bad boundary: the FE's second transcript renderer. buildCodeSession opens a
work slot at the goal message. The turn's lifecycle record is an upsert keyed by turn
id, now at its latest rev ('ended') but sorted at the turn-start seq, before the
turn's tool records. So the builder closed the goal's slot empty ("Worked for 35.8s",
0 rows), then opened a second slot for the tools. A session with no turn at all
(9c3c19a0) kept the goal's slot open until session end: an empty "Worked for 1m 42s".
Replaying the prod payload through buildCodeSession reproduced both exactly.

Deeper (Step 5a): why could this happen? The code session had its own grouping
(WorkSlot), header, composer selects and chip body. They duplicated the root
transcript's work grouping (groupTrajectoryWork), which never emits a group without an
activity, and its query box controls. The two projections drifted. Next rung: the
transcript records carried no settings (model/speed/context), so no display could
show them after the session ended. Rung beyond: ownership of the CLI's state
(ws-server), which already knows model, speed, per-call usage and context window.

## Solution

Delete/unify (Step 6a):
- Deleted the bespoke renderers: CodeSessionMessages/WorkSlot, CodeRoutingActivity,
  routineAgentRouting, the chip's in-card transcript/steer input
  (codeAgentChip.steer.tsx), the view header, SessionLine/Summary rows and the
  composer's Model/Effort/Speed selects and "Effective/Session settings unavailable" lines.
- The code-agent view now renders the root MessageList inside an AgentContext whose
  selected agent is the code session (CodeAgentContext.tsx) and whose messages are
  the flattened projection (codeSessionTurns.codeSessionMessages). groupTrajectoryWork
  folds them into "Worked for …" exactly as for a Rose agent, so empty/duplicate rows
  are impossible by construction. Mid-turn narration is an assistant (thought) row;
  only the answer is user-facing.
- Root transcript: spawn_claude_code_agent is no longer a user-facing boundary, so the
  code agent folds into the Worked drawer as one plain row (title · state, devbox
  usage bars while running, elapsed). Clicking it opens the code-agent view. The
  existing Open app button moved into the view's top-right strip.
- Query box: the existing ModelSelector chip, SpeedToggle and nub (ContextMeter)
  are fed from the live capabilities or the session's own records. The existing
  BackgroundAgentsBanner (via BackgroundAgentsBannerView) lists the code agent's
  Claude Task/Agent sub-agents.
- Data: ws-server's system.init session event carries speed/effort, and usage
  events carry the call's context_tokens and the model's context_window. The backend
  overlays ws-server.mjs on every session, so no template rebuild is needed.
  code_transcript.py forwards a `session` record and the context fields, and keeps a
  background-launched Task row running until its task_notification.

10k agents: the view reads only the owner's already-loaded rows (no new fetch, poll
or subscription); the projection is O(owner messages) per render of one open view.

## Human feedback

Andy (via the orchestrator): "DON'T make a new display. Use the existing FE we already
have: the transcript that folds work into the Worked for drawer and displays user
messages"; "rm this random jank shit" (branch/commit rows); remove the Claude header
but keep the devbox usage indicator and show it on the root row too; the code agent's
query box must show its model and speed with the existing elements and the nub must
show the code agent's real context usage; "make sure that when claude spawns a sub
agent, it still shows up on the running agent querybox drawer". Moving "Open app" into
the code-agent view (its only entry point) is a default taken by Lane B, pending
Andy's confirmation.

## Reusable lesson

Render every agent-like transcript (Rose agent, code agent, sub-agent) through the one root transcript path with an adapted context, never a parallel renderer, so grouping invariants hold everywhere.
