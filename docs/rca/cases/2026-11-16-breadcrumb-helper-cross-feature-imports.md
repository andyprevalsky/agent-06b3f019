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
  - commit 562cc8c49008708918d15ee9844ab1c8c333062c
  - PR #2411
  - commit c04bacf96b8293782ec8810fed66561448f6a289
  - commit 780ec1dc547dcca4cf9aabd09634c9c4a4c4ac7e
repro: front-end/src/tests/structural/structural-deps.test.ts
status: fixed
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
applicable (ordinary UI composition, no approval-gated hunk). The delivery section records the completed merge and production verification.

## Human feedback

The user required completion of both original bug fixes through deployment.
No issue-specific human correction was recorded for this introduced failure.

## Reusable lesson

Keep cross-feature imports at the established composition boundary when extracting a helper.

## PR2411 delivery evidence

PR #2411 merged as `562cc8c49008708918d15ee9844ab1c8c333062c`.
The original failures and reproduction assertions above remain unchanged
historical evidence. Frozen source `4a9d224abd5bf5ab1770237f2a8097762938a876`,
digest `882008a4bc15beb817e758c96fd6fcabb8c9fddfcfd52454d9877be30fab17c0`,
passed all 17 selected native deploy gates. The original cycle and report
are preserved under `.context/rca-147bb3eb/validated-4a9/` and
`validated-4a9-report.log`; the report command exited 0.

The first production attempt failed semantic workflow dispatch with HTTP401
at 20:22:58 UTC before creating any workflow run. Its original FAIL and null
run identity remain in `.context/rca-147bb3eb/production-first-attempt/` and
the final production receipt's semantic_history. Render, Vercel, backend probes
and Mac release passed. The credential CLI repair was separately validated
and pushed as operations commit `6e2496487add55f3416737566873573528474fd3`;
its 91-test `/push` is not PR2411's 17-gate full deploy.

The normal semantic-only retry exited 0 at 2026-11-16T20:48:30Z. Run
[43951508861](https://github.com/Rose-Ai-Labs/rose/actions/runs/43951508861)
completed all five jobs successfully. It is **PASS-verified-by-descendant**,
not an exact-source PASS: target product merge is562cc8, effective live frontend
and tested specification source is `1ec28940191764ecf435ffc38b345006269bc95b`,
and workflow execution head is6e2496487add55f3416737566873573528474fd3.
The final `.context/deploy-pipeline/production-lanes.json` records all
applicable lanes satisfied: exact562cc8 Render/Vercel, backend probes, Mac
run43946926015 (v1.1.355), and descendant-verified semantic. Fly, WMH,
workflow migration and AgentCard remain SKIPPED-not-applicable, never PASS.
The native finish command exited0 at20:49:05Z. This resolves this repaired
boundary's delivery; it does not certify unrelated runtime repairs, original
paused-session recovery, marker release or whole-workspace deletion readiness.


The import-boundary repair is independently supported by the original
base/failed comparison, unchanged structural assertion, and retained full
structural and focused UI results above. It shipped within PR2411. No import
allowlist, policy or test criterion was relaxed. Full17 is additional exact-source
evidence, not a replacement for that introduced-failure reproduction.
