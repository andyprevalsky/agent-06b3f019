---
id: 2026-07-18-tool-call-scoped-terminal-errors-never-closed-browser-panels
date: 2026-07-18
title: Browser chips stayed visible because tool-call-scoped terminal errors were only recognized at task scope
surface: front-end
component: browser-panels
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "front-end `computeActiveBrowserPanels` — recognized only task-scoped terminal messages plus a `session_paused` special case"
symptoms:
  - 4 phantom browser chips stay visible after every browser agent has failed
  - '"Browser automation failed" ERROR does not close its browser chip'
  - "browser chip count never reached 0 — Expected: 0, Received: 1"
tags:
  - front-end
  - browser-agent
  - browser-chips
  - lifecycle
  - tool-call-scope
sources:
  - PR #791
repro: browser-chip-count semantic spec (front-end/tests-e2e)
status: fixed
---

## Problem

On prod agent `85530622-66ed-4a88-8c51-bd50370bcd8e`, 4 phantom browser chips
stayed visible after every browser agent had already failed. Replaying the
captured 115-message prod transcript reproduced it exactly: the derivation
returned 4 active panels where it should have returned 0, and a pre-fix semantic
run reported `browser chip count never reached 0 — Expected: 0, Received: 1`.

## Diagnosis

The producer and the consumer disagreed about scope. The browser manager's
catch-all error path (`agents/domains/spawn_browser_agent_v3/handler.py`,
"Browser automation failed") posts terminal ERRORs at **tool-call scope** —
`toolCallId` only, with no `task_id`/`action_type`, because the exception can fire
before or between browser tasks. `computeActiveBrowserPanels` recognized only
**task-scoped** terminal messages, plus a narrow `session_paused` special case, so
a parent-scope terminal event could never close the child-scope panels it ended.
Problem class: child-scope lifecycle UI never closed by parent-scope terminal
events.

## Solution

A terminal `spawn_browser_agent` message without `task_id` now closes every task
whose init shares its `toolCallId`, replacing the `session_paused`-only special
case (unify/delete rather than another special case). Task-scoped terminals still
close only their own task — required because the same tool call retries with a new
task after a `task_complete`, proven in the prod transcript. The invariant "chips
visible == active browser agents" was cemented three ways: the 115-message prod
transcript as a blackbox fixture (4 panels → 0), 6 unit tests covering tool-call
scoped ERROR/FINISHED, sibling-retry survival under task-scoped
`task_complete`/`session_paused`, and cross-tool-call isolation, plus a semantic
Playwright spec `browser-chip-count` seeding worker-shaped TOOL messages via
`POST /api/agents/:id/messages` and asserting 0→2→1→0 with a reload-hydration
check. All were run against pre-fix code and failed at exactly the diagnosed step;
post-fix 34/34 derivation tests pass and the semantic spec passes in 14.1s. At 10k
agents this is a pure derivation change over the selected agent's own messages —
no new subscriptions, channels, queries, or per-agent fan-in.

## Human feedback

None recorded.

## Reusable lesson

When lifecycle UI won't close, compare the scope the producer stamps on terminal
events with the scope the consumer matches on — a parent-scope terminal must close
every child it owns.
