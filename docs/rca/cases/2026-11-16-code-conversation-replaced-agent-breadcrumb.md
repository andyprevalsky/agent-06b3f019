---
id: 2026-11-16-code-conversation-replaced-agent-breadcrumb
date: 2026-11-16
title: Opening a coding conversation discarded its owner breadcrumb
surface: front-end
component: terminal-agent-navigation
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AgentChatArea ChatColumn returned CodeAgentConversationView before rendering SubAgentBreadcrumb and only recognized parent_agent_id for trails
symptoms:
  - when i click into a coding agent the breadcrumb thing at the top no longer gets displayed
  - Unable to find an accessible element with the role "navigation" and name "Agent breadcrumb"
tags:
  - code-agent
  - breadcrumb
  - navigation
  - frontend
sources:
  - agent 147bb3eb-415a-475d-9f2f-289220bdcd12
  - commit 780ec1dc547dcca4cf9aabd09634c9c4a4c4ac7e
repro: front-end/src/tests/blackbox/rose-code-agent-view.blackbox.tsx (keeps the owner breadcrumb)
status: open
---

## Problem

The user reported that entering a coding agent removes the breadcrumb at the
top of the frontend. Production root147bb3eb-415a-475d-9f2f-289220bdcd12 has
parent_agent_id=null and spawned Codex task128fc65a-d530-4753-9efd-24bab20fabf1,
title verify_project. Its immediate startup death is an independent incident;
this case concerns the navigation that must render for any coding session.

The real Terminal blackbox opens the owner's code row and asserts an accessible
owner-to-session trail, then clicks the owner and checks the restored chat and
removed code-agent URL parameter. Identical command before and after repair:

`cd front-end && npx vitest run src/tests/blackbox/rose-code-agent-view.blackbox.tsx -t 'keeps the owner breadcrumb'`

Before: exit1, 13.54s, cannot find navigation named Agent breadcrumb after the
coding view appears. After: exit0, 7.46s, same assertion passes. Raw production
capture and local logs are retained privately under .context/rca-147bb3eb.

## Diagnosis

Critical path:

```text
sidebar code row -> CodeAgentViewProvider (owner + task)
  -> AgentChatArea.ChatColumn
     -> code session open: early return replaced all chat chrome
     -> ordinary sub-agent: SubAgentBreadcrumb below that early return
```

What: code sessions lose the owner trail. Where: ChatColumn's early return.
Why: composition treated the entire column as session-owned, and the existing
breadcrumb predicate recognized only a Rose agent's parent_agent_id. Coding
sessions use a separate task identity with ownerAgentId, so even coding agents
of a root must show a parent trail. Proof: real row-click reproduction and
root's captured null parent plus task identity. General class: view replacement
omitted shared navigation across independently selectable entity kinds.

Archive searches were `coding agent breadcrumb`, `coding agent terminated
instantly`, `SubAgentBreadcrumb coding conversation`, and `spawn codex ENOENT`.
The Nov10 code-session row-actions case is a relative: selectable coding tasks
need their own UI affordances. Its missing-actions boundary does not explain
this early return. The Oct27 mobile PWA overlay case is another relative:
reuse its safe-area-aware breadcrumb geometry, but this failure is absence of
the element, not placement. No same-cause recurrence found.

Before implementation edits, all other running project conversations were read
for actual current repair scope and evidence, alongside open PRs, historical
code-session failure evidence, Bug Report and literal symptom searches. No
existing owner covered this navigation boundary. Independent review confirmed this first bad boundary and cleared the final
implementation after the corrections below. This case remains open pending
landing and production verification.

## Solution

Reuse SubAgentBreadcrumb above the coding conversation. A coding title appends
the owner to the existing ancestor path and becomes the current page. The code view supplies its existing resolved session title to the trail,
including deep links. Clicking an ancestor closes the code view, then selects
it only when different from the already selected owner; owner return keeps
the loaded chat and introduces no detail refetch. Root chat remains without a trail;
ordinary sub-agent trails retain their parent fallback and mobile geometry.
The semantic nav/aria-current attributes expose the path accessibly.

Regression coverage includes the real row-open/owner-return path plus nested
ancestor and owner navigation. Existing archived-parent and mobile chrome
checks remain. No extra network request, subscription or polling is introduced;
at10k agents this derives from the selected owner's already-loaded ancestors.
Independent review found and reproduced two initial gaps: deep links showed a
placeholder instead of their loaded title, and owner return made one extra
owner-detail GET (expected2, actual3). Both assertions failed together (exit1)
before corrections. A nested Terminal test initially invented new message IDs
on every fake server refresh, creating duplicate text in the full-file run;
its handlers now return stable persisted identities with the same unique-text
assertion. All failures are retained in the private evidence.

Final validation: five unchanged full focused suites each pass43/43; the
two-provider Chromium spec passes five times and verifies resolved titles,
viewport containment and no transcript overlap at1280,430,320px. Code view
reserves space below the trail. ESLint required extracting the code-view
composition into AgentCodeConversation; a post-extraction43/43 suite, two
Chromium provider checks, ESLint and TypeScript all exit0. Fresh independent
RCA/flakiness review passed these final bytes. Permanent owning regressions
map to frontend-vitest; the existing semantic-stack runner also discovers the
Chromium spec through its tests-e2e glob (the offline selector does not model
individual Playwright units). Golden reference: not applicable (no
approval-gated hunk).

## Human feedback

The user required the missing breadcrumb and immediate coding-agent death to
be fixed independently, requested reconciliation with existing bug owners
before editing, and required completion through /deploy.

## Reusable lesson

Preserve owner navigation when replacing a conversation with an independently selectable coding session.
