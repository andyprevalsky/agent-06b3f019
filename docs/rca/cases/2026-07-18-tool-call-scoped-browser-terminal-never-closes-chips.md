---
id: 2026-07-18-tool-call-scoped-browser-terminal-never-closes-chips
date: 2026-07-18
title: Tool-call-scoped browser terminal ERRORs (no task_id) never closed task-scoped chips
surface: front-end
component: terminal-derivations
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal/hooks/derivations.ts — computeActiveBrowserPanels only recognized task-scoped terminal messages
symptoms:
  - 4 phantom browser chips remain after every browser agent failed
  - "Browser automation failed" terminal message carries toolCallId but no task_id
  - browser chip stays "started" and never resolves
tags:
  - browser-agent
  - front-end
  - chip-lifecycle
  - message-scope
  - phantom-chip
sources:
  - PR #791
  - commit 88dd319a0
  - memory:project_browser_chip_leak_toolcall_scope
repro: front-end/tests-e2e/browser-chip-count.spec.ts
status: fixed
---

## Problem

Prod agent `85530622` (2026-07-18) rendered 4 phantom browser chips in the
terminal after all of its browser agents had already failed. The chips stayed in
the "started" state forever, so the UI claimed browser work was in flight when
none was.

## Diagnosis

The browser manager's catch-all error path in
`agents/domains/spawn_browser_agent_v3/handler.py` ("Browser automation failed")
posts its terminal ERROR at **tool-call scope only** — it carries `toolCallId`
but no `task_id`/`action_type`, because the exception can fire before or between
tasks. The front-end reducer `computeActiveBrowserPanels`
(`front-end/src/features/terminal/hooks/derivations.ts`) only recognized
task-scoped terminal messages, plus one special case for `session_paused`
keyed by `toolCallId`. A parent-scope terminal event therefore closed nothing,
and every child (task-scoped) panel leaked. The deeper cause is a scope-contract
mismatch: producer and consumer disagreed about which scope a terminal event may
arrive at.

## Solution

Terminal detection was unified in `computeActiveBrowserPanels`: any
`spawn_browser_agent` terminal message **without** `task_id` closes every task
whose init shares its `toolCallId`; a task-scoped terminal closes only its own
task. The task-scoped narrowing is load-bearing — the prod transcript proves the
same tool call retries with new tasks after a `task_complete`, so closing all
tasks on a task-scoped terminal would hide live work. The prod transcript is
checked in as
`front-end/src/tests/blackbox/browser-chip-leak-prod-85530622.fixture.json` and
replayed through the reducer; the semantic invariant
`front-end/tests-e2e/browser-chip-count.spec.ts` seeds worker-shaped TOOL
messages via `POST /api/agents/:id/messages`. Known scoped-out edge: a browser
tool failing inside a sub-agent (`subAgentId` set) is untested and its
reachability was never established.

## Human feedback

None recorded.

## Reusable lesson

When a chip or panel never closes, compare the scope of the terminal event
(task vs tool-call vs sub-agent) against the scope the consumer matches on
before assuming terminal events are missing.
