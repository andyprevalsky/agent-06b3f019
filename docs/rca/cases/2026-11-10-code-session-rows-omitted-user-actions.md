---
id: 2026-11-10-code-session-rows-omitted-user-actions
date: 2026-11-10
title: Coding session sidebar rows omitted rename and ID actions
surface: cross
component: rose-sidebar-code-agents
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: RoseCodeAgentRow rendered a bare navigation button without session actions
symptoms:
  - Cannot rename coding agents
  - Cannot copy IDs from coding agents
  - Unable to find role="menuitem" and name "Rename agent"
  - Unable to find role="menuitem" and name "Copy agent ID"
tags:
  - sidebar
  - code-agents
  - rename
  - clipboard
sources:
  - commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265
  - commit 11828d4eac7f2faa410da8a4afb25b48e2477a8f
repro: front-end/src/tests/blackbox/rose-sidebar-code-agents.blackbox.tsx
status: fixed
---

## Problem

Root agent rows exposed rename and copy-ID controls; coding session rows did
not. The user requested both controls for coding agents and explicitly chose
`/rca` then `/push`. No failing execution agent ID was supplied, so an agent's
own report_bug lookup is inapplicable.

The permanent sidebar regression ran against the original production source:
`cd front-end && npx vitest run src/tests/blackbox/rose-sidebar-code-agents.blackbox.tsx -t 'Code-agent row actions'`.
Four tests failed in 29.72s: Rename agent and Copy agent ID menuitems were absent.
The same command after the fix passed all four in 5.91s, covering Codex,
Claude, legacy-provider sessions owned by child agents, and persisted rename
readback after a sidebar remount. A first implementation verification exposed
an unstable dialog target reseeding the input; memoizing that target fixed the
failure without changing the assertion.

## Diagnosis

Path: authenticated code-agents list -> RoseCodeAgentRow -> user action ->
clipboard / authenticated task rename -> fresh list read.
The first missing boundary was the row: unlike RoseAgentRow it rendered only a
navigation button. The backend likewise exposed list-only operations for these
sessions, so reusing a root Agent PATCH would target the wrong identity.
Session task IDs and owning Rose agent IDs are distinct.

What: missing actions. Where: RoseCodeAgentRow and code-agents routes.
Why: the separate session list never implemented user editing controls.
Proof: the unchanged permanent blackbox fails before the fix and passes after.
Problem class: missing capabilities across selectable session kinds. The next
proven rung is the absent authenticated session rename contract; no broader
harness change is required.

Archive searches: `coding agent rename copy ID` and
`RoseCodeAgentRow context menu`. Related mobile-overlay and context-menu
opening-release cases exist, but neither has this missing-capability cause.
This is a new incident, not a recurrence. Existing menu primitives retain
those prior fixes.

## Solution

Give coding rows their own ContextMenu actions and reuse RenameAgentDialog
with its minimal identity/title/goal contract. Copy writes code_agent_id,
never owner_agent_id. Rename sends a task-scoped PATCH, persists its taskName,
and updates cached list pages for that root. Errors produce toasts without updating cached titles. The backend scopes the atomic update through
the owning user's non-deleted Agent; missing and foreign tasks return 404.
No schema migration or workflow/status change is needed. The rename contract
trims and validates 1–80 characters, matching the shared dialog.

The backend permanent regression in
`back-end/src/tests/blackbox/agent-graph-code-agents.cases.ts` failed before the
endpoint existed (`expected 200, got 404`, `Cannot PATCH`), then passed with
the same assertion five consecutive times (19/19 domain cases). The final
80-character boundary also passed using the isolated documented runner:
`cd back-end && ROSE_TRUST_CONDUCTOR_WORKSPACE_NAME=1 CONDUCTOR_WORKSPACE_NAME=code-agent-rename-rca CONDUCTOR_PORT=58200 bash scripts/run-blackbox-tests.sh agent-graph`.
It checks persisted readback, authentication, foreign/missing tasks, invalid
titles and preservation of goal/provider/status.

A follow-up sidebar regression failed when leaving the hovered bar collapsed
the coding branch and removed the menu. Coding rows now share the sidebar's
menu expansion hold, retained until the per-row rename dialog closes. The
regression checks menu use outside the bar, dialog visibility and release after
Cancel and pointer leave. Its final pointer leave explicitly accounts for
synthetic pointer entry while clicking the portaled dialog; the original
missing expansion assertion is unchanged.

At 10k agents, these controls add no polling, subscriptions or background
requests. Copy is local. Rename is one indexed task update joined to its owner,
plus local updates to cached pages containing the root. Each page contains at
most 50 root IDs; no per-row network fan-out or full-user DB scan is added.

## Human feedback

The user asked to allow renaming and copying IDs from coding agents, not just
root agents, then run `/rca` followed by `/push`.

## Reusable lesson

Expose actions using each selectable session's own identity and persist edits at its authenticated owning boundary.


## Final combined validation — November 10

Source: commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265. Full frontend coverage passed 324 files,
4,732 tests passed and one skipped; line coverage 89.69%, branch coverage
81.87%. Full backend failed-first sharded coverage passed all 253 selected
blackbox domains and all 391 unit files (including the separately scheduled
browser-performance probe), with line/statement coverage 90.26%, functions
93.13% and branches 82.95%. Configured thresholds passed; backend teardown
checks also passed. The coverage runner intentionally excludes the separate
live credential-health domain. No production rollout or live account probe
is implied by these local validation results.

Commands: `cd front-end && npm run test:coverage`;
`cd back-end && bash scripts/run-coverage-sharded.sh --failed-first 2 && bash ../scripts/tests/blackbox-backend-teardown.test.sh`.
