---
id: 2026-11-08-dock-task-rows-had-no-open-target
date: 2026-11-08
title: Running-agents dock code/nested task rows had no open target, so clicking them did nothing
surface: front-end
component: background-agents-dock
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/background-agents/BackgroundAgentsBanner.tsx BackgroundAgentsBannerView.navigate — every synthetic `task:` node id went to useOpenTrajectories.toggle, which ignores ids without an explore/browser trajectory (code tasks, tasks owned by descendant agents)
symptoms:
  - "clicking `code · <task name>` in the Running N agents dock does nothing"
  - "can't click on that agent and move to its view"
  - "browser task row under a child agent in the dock does not navigate"
  - "browser row in the Running N agents dock unfolds inline instead of opening the Browser drawer"
  - "Browser drawer empty after opening a child agent's browser task from the dock"
tags:
  - rose-desktop
  - background-agents
  - code-agent-view
  - navigation
sources:
  - plan:front-end/src/tests/blackbox/background-agents-open.blackbox.tsx
repro: front-end/src/tests/blackbox/background-agents-open.blackbox.tsx
status: fixed
---

## Problem

In Rose Desktop, the expanded "Running N agents" dock above the query box lists
a background code agent as `code · remove_rose_card_border` with a chevron, but
clicking it did nothing. The same was true of a browser/explore/code task owned
by a descendant agent (listed from `Agent.backgroundTasks`). General-purpose
agent rows did navigate (`onNavigate(agentId)`), as did the selected agent's
own explore/browser rows, which unfold their trajectory inline.

Local repro (pre-fix): `cd front-end && npx vitest run
src/tests/blackbox/background-agents-open.blackbox.tsx` →
`AssertionError: expected "vi.fn()" to be called with arguments: [ ObjectContaining{taskId: 'cc-1', ownerAgentId: 'root-1'} ] Number of calls: 0`.

## Diagnosis

1. `agentsPanelGroups.taskTreeNode` turns every in-activity explore/browser/code
   task into a synthetic TreeNode `task:<path|address>` documented as "never
   navigable"; only explore/browser tasks of the selected agent get a
   `trajectories` entry.
2. `TreeNodeRow` calls `onNavigate(node.agentId)` for every row, including the
   chevroned task rows.
3. `BackgroundAgentsBannerView.navigate` routed every task id to
   `useOpenTrajectories.toggle`, which returns early when the id has no
   trajectory. Code tasks and descendants' tasks therefore had no action.
Deepest owned cause: the dock model carried no "what does this row open"
contract for task nodes, although an open target existed for both: the code-agent
view (`useCodeAgentView().open`, already used by the transcript code chip and
the sidebar) and the owning agent's conversation.

## Solution

`buildAgentPanelModel` returns `taskTargets`: every synthetic task node maps to
`{type, ownerAgentId, own, taskId, taskName}`. Tree tasks fill it in one pass over
the bus tree, and the selected agent's spawn rows refine it (`task_id`, path's
task name). `useAgentsPanelData` adds `rootAgentId` (the bus id).
`BackgroundAgentsBannerView` (`usePanelNavigation`) resolves:
- real agent row → `onNavigate(agentId)`
- selected agent's explore task with a trajectory → inline unfold (unchanged)
- browser task with a known task id → `openAgentBrowser(owner, taskId)`
- browser task without one → new `RoseApps.openAgentBrowserTab(owner)`: selects
  the agent's first real tab, else no selection with a pending switch, so the
  agent's tab takes over when its BrowserStatusBar registers. It never calls
  `focusTask` with an empty id (that had created a fake `{taskId:''}` tab that
  stayed selected). A child's task navigates to the owner first.
- code task → `useCodeAgentView().open`, with the id from the spawn rows, else
  `useFindCodeAgent`: owner + task name join over the left bar's cached
  GET /api/agents/code-agents pages, and on a miss ONE `fetchQuery` of the
  root's list (`staleTime: 0`) and a second join. On a title collision a
  running (ACTIVE) row wins, then the newest.
- no id found / view unavailable / tree-only explore → `onNavigate(owner)`
- nothing to open (the code-agent view's Claude Task sub-agent rows, which have
  no per-sub-agent transcript) → `canNavigate` false: `NodeRowBody` renders no
  pointer, hover or chevron, and no click handler.

Why the list join rather than `task_id` on Agent.backgroundTasks: the entry is
written at registration, before the code task exists. A new field would also
change `backgroundTaskEntrySchema` (Zod, approval-gated) and the worker. Owner +
task_name is the key both sides already carry. 10k agents: one O(nodes + tasks)
map per model rebuild, a click-time cache read, and at most one list request per
miss click; no polling, subscriptions or channels.

## Human feedback

User: "that should work for browser and code agent and general purpose"
(clicking the dock row must move to that agent's view).

## Reusable lesson

Every row rendered with an affordance (chevron, hover, pointer) must resolve to a concrete open target in the model; synthetic nodes need an explicit target map, not a silent no-op fallback.
