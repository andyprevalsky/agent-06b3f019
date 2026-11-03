---
id: 2026-10-26-browser-chip-terminal-not-scoped-to-run
date: 2026-10-26
title: Relaunched browser lost its status chip because an ended run's task_complete on the same task_id still counted
surface: front-end
component: browser-panel-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/lib/browserPanelLifecycle.ts computeActiveBrowserPanels — terminality was evaluated over every message of a task_id, not the task's latest run
symptoms:
  - browser chip disappears when the Agents running pane shows
  - browser status chip hidden while the browser agent is still running
  - Running 1 agent · 3 total but no browser chip
  - new browser reuses task_id after kill_agent / relaunch, chip never returns
tags:
  - browser-status-chip
  - background-agents
  - task-id-reuse
  - rose-desktop
sources:
  - agent 447576b9-f5e5-4f81-b883-865e5dad5fa9 (prod, 2026-10-26, "Get me breakfast")
  - commit 24ff32e34 (branch fix/ui26-browser-pane)
repro: front-end/src/tests/blackbox/browser-panel-derivations.blackbox.ts ("keeps a relaunched browser visible when it reuses the task id of an ended run")
status: fixed
---

## Problem

Andy (UI review of origin/main, item 8): the browser chip disappeared once the
"Agents running" pane showed, although a browser was still running. Read-only
prod query of agent 447576b9: browser run 1 (tool call 79359b27) ran on task
6ec1d971-ba85-5917-9dcb-7b0819c23ab8. At 15:58:44 the user wrote "go to instacart
instead". The root started background browser run 2 (tool call 5ad0e0c38) at
15:58:52 and killed run 1 at 15:59:09. Run 1 posted `task_complete` rows on that
task id at 15:59:06 and 15:59:08. Run 2 reused the same task id and kept stepping
from 15:59:27 (instacart goto, clicks, typing). The pane showed the browser as
running, but the chip never came back.

## Diagnosis

`computeActiveBrowserPanels` gathered every message for a `task_id` and set
`hasTerminalTaskMessage = taskMessages.some(isBrowserTaskTerminalMessage)`.
It took `initToolCallId` from the first init message. When run 2 reused the
task id, run 1's `task_complete` remained in that set, so run 2's chip stayed
closed. The existing supersede logic only covered the opposite case: one tool
call retrying with a new task id. Deeper class: the lifecycle treated a task id
as a single run, but the producer can relaunch a task under the same id.

## Solution

`currentBrowserRun` sorts a task's messages by persisted time. An init after a
terminal starts a new run, and only the latest run supplies the init, the
terminal check, the tool-call-scoped terminal and the live URL. Run 2's own
`task_complete` still closes the chip. This is pure client derivation over rows
the client already holds: no new channel, request or per-agent state, so it is
O(messages of the selected agent) at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

Scope chip or panel terminality to the latest run of an identifier, because producers can reuse a task id when they relaunch it.
