---
id: 2026-11-06-sidebar-order-ranked-blocked-first-and-lacked-user-message-recency
date: 2026-11-06
title: Left-bar lists ranked needs-help above running and sorted by creation because no person-message recency existed
surface: cross
component: sidebar-agent-ordering
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: front-end agentListOrdering.ts sortAgents (RUN_STATE_RANK put needs-help before active; tie-break was created_at) with no backend field recording when a person last messaged an agent
symptoms:
  - paused / needs-help agent sorts above running agents in the Rose left bar
  - an old agent I just messaged stays below newer agents in its project / folder / Home list
  - sub-agent disclosure lists children in tree arrival order, code agents always after sub-agents
  - GET /api/agents row has no last_user_message_at
  - "A new agent should have no last_user_message_at"
tags:
  - sidebar
  - ordering
  - rose-desktop
  - sub-agent-tree
  - last-user-message
sources:
  - commit 3a77d488a
repro: front-end/src/tests/blackbox/rose-sidebar-ordering.blackbox.tsx
status: fixed
---

## Problem

Andy asked that every left-bar list (any project, any folder, any sub-agent list)
show running agents first, and within that tier put the agent with the most
recent user message on top. On `main` (75d1b1df8) the unchanged new tests showed
the actual order:

- Home list (`rose-sidebar-ordering.blackbox.tsx`): received
  `help (PAUSED), run-new, run-messaged, done-old, done-messaged`; expected
  `run-messaged, run-new, help, done-messaged, done-old`.
- Sub-agent disclosure (`rose-sidebar-tree.blackbox.tsx`): received
  `done-messaged, run-old, run-messaged, paused, code-run, code-done` (tree
  arrival order, code agents appended oldest-first); expected
  `run-messaged, code-run, run-old, paused, done-messaged, code-done`.
- Stock sidebar (`app-sidebar-rows.blackbox.tsx`): `Still working` above
  `Just messaged` despite the newer user message.
- Backend (`agents-last-user-message.cases.ts`): GET /api/agents rows carried no
  `last_user_message_at` (306 passed, 1 failed).

Command: `cd front-end && npx vitest run src/tests/blackbox/rose-sidebar-ordering.blackbox.tsx src/tests/blackbox/rose-sidebar-tree.blackbox.tsx src/tests/blackbox/app-sidebar-rows.blackbox.tsx`
→ 3 failed / 38 passed on main; `cd back-end && bash scripts/run-blackbox-tests.sh agents`
→ 306/307 on main.

## Diagnosis

1. `sortAgents` (front-end `agentListOrdering.ts`) ranked run states
   `needs-help: 0, active: 1, done: 2`, so a paused or blocked agent outranked
   every running one — the opposite of the requested order.
2. Its tie-break was `created_at`, because no layer recorded when a person last
   messaged an agent: `Agent` had no such column, the list/tree endpoints exposed
   nothing, and deriving it per poll (the list is polled every 10 s) would scan
   `Message` per root agent (O(agents × trailing messages) per read).
3. Sub-agent disclosures (`RoseAgentBranch.tsx`) did not sort at all: children
   rendered in tree-map insertion order and code agents were appended after them,
   oldest first, so a running code agent sat below finished sub-agents.

Deepest owned cause: the ordering preference was never captured as one shared
contract — roots, folders and sub-agent lists each had their own (or no) rule,
and the recency signal the preference needs did not exist in the data model.
The next rung ("the sidebar has no ordering spec at all") is the same fix.

Archive searches: "sidebar sort order running agents first most recent user
message" and "agent list ordering needs-help active sortAgents created_at
sub-agent children order" — no prior case; novel.

## Solution

- New nullable `Agent.lastUserMessageAt` (migration
  `20261106120000_agent_last_user_message_at`, backfilled for the live prod agents
  (333 roots + 831 children, counted read-only on 2026-11-06) from the newest USER
  row without agent-authored flags and without a bot-relayed Slack occurrence). `recordPersonMessage`
  (`providers/personMessageStamp.ts`) stamps it after the message is committed
  and delivered, with raw SQL so `Agent.updatedAt` (liveness reconciler,
  old-agent collapse) does not move, and never throws: a failed stamp is logged
  and cannot fail, retry or duplicate the delivery. Person-authored entry points
  only: non-internal POST /:id/messages (incl. Browser-composer messages) unless
  `personAuthored: false`, attention replies (after commit) and SMS supervisor
  replies. A2A, notifications, compaction and Slack-relayed error occurrences
  never stamp it; Slack reviewer feedback does.
- GET /api/agents and GET /api/agents/tree expose `last_user_message_at`; the
  tree subscription preserves it across realtime updates.
- One shared rule: `runStateRank` (active 0, needs-help 1, done 2) and
  `lastUserMessageTime` (stamp, else created_at). `sortAgents` keeps pinned on
  top, then uses both; `RoseAgentBranch` sorts sub-agents and code agents
  together with the same rule. After a send the terminal re-reads the root list
  and patches the live tree node (`noteTreeUserMessage`), so a messaged sub-agent
  reorders among its siblings at once; a realtime-spawned child sorts by its
  event time instead of the root's creation.
- CodeRabbit round 2 found the same class on the other side: a reconnect snapshot
  fetched before a send replaced the newer stamp of a REST-only child. The fetch now
  keeps the later stamp from the published node
  (`agent-tree-snapshot-race.blackbox.ts`, failing on the old code, 5/5 after).
  Its verification round asked the one-time backfill to cover live children and to
  skip Slack occurrences; both are in the migration, run by
  `agents-last-user-message.cases.ts` (fails on the old SQL, 5/5 after).
- Sibling failures prevented: folders, mobile list and stock sidebar inherit the
  same comparator; any new list reuses `runStateRank`/`lastUserMessageTime`.
- 10k-agent behavior: one keyed `UPDATE "Agent"` per person message; the list and
  tree read one extra column; no per-poll Message scan, no new channel.
- Golden reference: not applicable (no approval-gated hunk).
- Code agents still order by creation inside their run-state tier: code-agent
  rows carry no person-message time (follow-up).

Post-fix: same FE command 41/41; same backend command 307/307 (and 5
consecutive passing runs).

## Human feedback

Andy (2026-11-06) specified the order: running agents first in any project,
folder and sub-agent list, then the most recent user message on top within that
tier. The implementation consequently moved needs-help below running (it had
been ranked first); that choice was surfaced to him for confirmation.
He then asked for `/rca fix` followed by `/deploy`.

The Step 7 adversarial review (agent thread ph7279fqap113m1s0maxxnyt3h8hqrrk)
rejected the first fix shape: stamping inside the delivery path (a failed
UPDATE could drop or duplicate a user message), bumping `updatedAt` through
Prisma `updateMany`, an unmeasured whole-root backfill, sub-agent recency that
only REST refreshed, and Slack-relayed alerts counting as person messages. All
were changed before deploy.

## Reusable lesson

Encode a list-ordering preference as one shared comparator plus a stored recency field, and test every list surface against it, rather than letting each list derive its own order from whatever timestamp happens to exist.
