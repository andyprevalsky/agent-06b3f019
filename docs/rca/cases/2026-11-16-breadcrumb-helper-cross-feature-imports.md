---
id: 2026-11-16-breadcrumb-helper-cross-feature-imports
date: 2026-11-16
title: Breadcrumb helper extraction crossed the terminal feature import boundary
surface: front-end
component: terminal-composition
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: AgentCodeConversation.tsx imported terminal-component-group values and an internal type outside the existing composition boundary
symptoms:
  - AgentCodeConversation.tsx follows import direction rules
  - Cross-domain import
  - features/terminal-component-group (from components layer)
tags:
  - frontend
  - import-direction
  - composition
  - structural-test
sources:
  - PR #2411
  - commit c04bacf96b8293782ec8810fed66561448f6a289
  - commit 780ec1dc547dcca4cf9aabd09634c9c4a4c4ac7e
repro: front-end/src/tests/structural/structural-deps.test.ts
status: open
---

## Problem

During the coding-agent breadcrumb repair, extracting a helper to satisfy
existing file/function lint limits introduced two forbidden cross-feature
imports. Full frontend coverage reported its existing structural assertion:
`AgentCodeConversation.tsx follows import direction rules`, with one runtime
barrel import and one deep type import crossing the boundary. Focused UI tests,
ESLint and TypeScript passed but do not assert import architecture.

## Diagnosis

Path: ChatColumn -> extracted AgentCodeConversation -> component-group imports
-> structural dependency validator. The first bad boundary is the new helper's
imports. The existing composition exception belongs to AgentChatArea, not any
component next to it. OpenCodeAgent was already publicly exported, and changing
only the deep import to the barrel still violates the runtime import rule.

Gate INTRODUCED: base780ec1dc54 passes the complete structural file (922 tests);
failedc04bacf96b fails one of923 tests with two exact import violations. The
unchanged targeted assertion fails on the buggy source and passes with the
composition repair. The staged full structural file passes923/923; the live
structural plus focused UI run passes966/966 after application. Exact commands,
source hashes and exits are preserved in .context/rca-147bb3eb/import-rca.

Archive searches: `Cross-domain import AgentCodeConversation` and
`helper extraction import direction`. Existing import-boundary incidents are
relatives; this incident is introduced by this release's extraction. A fresh
independent reviewer named the same first boundary before preparing the fix.

## Solution

Keep the component-group component and hook imports at the existing
AgentChatArea composition boundary. Pass the keyed conversation element,
owner ID and close action into the terminal-only helper. The helper composes
only the navigation/backdrop props with React cloneElement, preserving the
child's key, session state and resolved title. No export, allowlist, linter
suppression, structural assertion or dependency policy changes.

The permanent existing structural assertion is the regression; it remains in
the full frontend deploy gate. Existing owner-return, deep-link, nested trail,
read-only and mobile UI assertions remain. No extra fetch, subscription or
agent scan is introduced at10,000 concurrent agents. Golden reference: not
applicable (ordinary UI composition, no approval-gated hunk). Deployment and
post-merge status remain pending.

## Human feedback

The user required completion of both original bug fixes through deployment.
No issue-specific human correction was recorded for this introduced failure.

## Reusable lesson

Keep cross-feature imports at the established composition boundary when extracting a helper.
