---
id: 2026-11-10-sidebar-child-activity-dropped-mobile-presentation
date: 2026-11-10
title: New child activity badges rendered desktop letters in the mobile sidebar
surface: front-end
component: RoseAgentBranch child rows and AgentStatusIndicator
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: RoseCodeAgentRow added an unconditional active AgentStatusIndicator without receiving the branch mobile presentation
symptoms:
  - dark mobile agents use robots and retain one-layer disclosure
  - sidebar-agent-tree.spec.ts:302 drawer.locator('[data-letter]') Expected 0 Received 2 Timeout 15000ms
  - Mobile coding-agent Working badges animate ROSE letters after expanding child rows
tags:
  - mobile
  - sidebar
  - activity-badge
  - presentation-propagation
sources:
  - commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265
  - commit 6368e3c4ea7794e875d2f70e0f8f5dd001daebec
  - commit 291e1a130
  - PR #1912 acceptance investigation
repro: front-end/src/tests/blackbox/sidebar-mobile-activity.blackbox.tsx and front-end/tests-e2e/sidebar-agent-tree.spec.ts
status: fixed
---

## Problem

The full local semantic run on main `6368e3c4e` failed the unchanged dark mobile
test at line 302: the Menu drawer contained two `[data-letter]` elements instead
of zero, through the original 15-second deadline. Its initial zero-letter and
ordinary root/child robot assertions passed. The following latency lane
overwrote the original default test-results directory; the original log was
retained, and a separate canonical local reproduction captured new private
trace, screenshot, video, error context, JSON and lifecycle artifacts.

Before source edits, this exact runner command produced **11 passed, 1 failed**
in 58.6 seconds, with the original line 302 failure:

`SEMANTIC_WORKERS=1 SEMANTIC_NATIVE_REPORT_PREFIX=/home/boxes/rose/.context/dark-mobile-before bash front-end/scripts/run-semantic-tests.sh sidebar-agent-tree`

The trace's DOM snapshots identify both offending glyphs: the Working badges
inside `rose-code-agent-row-landing` and `rose-code-agent-row-build`. Their
provider icons and row labels were present. This is a fixture-backed browser
test, not a Rose runtime-agent investigation, so no agent self-report applies.
Private raw artifacts remain under `.context/dark-mobile-before*`; none were
published.

## Diagnosis

Critical path: valid code-agent API fixture -> mobile RoseAgentGroups ->
RoseAgentBranch with `mobile=true` -> RoseCodeAgentRow -> AgentStatusIndicator
active state -> animated ActiveDots DOM.

The first bad boundary was the new coding-row Working badge: it selected the
desktop animated glyph without receiving the existing branch presentation.
The new browser/explore task row had the same missing propagation. Root and
ordinary sub-agent rows received the mobile flag already, and their asserted
robot rendering passed. No upstream data defect or timing issue explains the
two captured code-row letters.

Baseline `291e1a130` rendered coding rows with provider icons only. Commit
`7fb7d7d91`, integrated into main before PR 1912, added the unconditional
Working badge and new task rows. The coding-row source is byte-identical at
PR 1912's first parent `b72e55c00` and merge `6368e3c4e` (SHA256
`47d0e5403930c13ba655d2df7d991d53af49e0393cc1ac0106e7b7948c20d0cf`).
Thus **Gate: NOT_INTRODUCED** relative to PR 1912; the source change is present
in current main relative to baseline 291. The assigned repair remains owned.

Archive searches used `data-letter expected 0 received 2 sidebar-agent-tree`
and `mobile sidebar robot icon project initials`, followed by
`sidebar active dots mobile code badge`. The October 28 stale-semantic-spec
case was read including Solution and Human feedback. This is a related UI
presentation failure, not a recurrence of that stale-spec cause: the current
mobile no-letter contract remains valid and the product needs repair.

The permanent real-branch blackbox was run before production edits: two mobile
cases failed because the Working glyph had no robot, while the desktop case
passed. An earlier setup-only attempt incorrectly waited for a minimized-only
count badge in an expanded branch; that failure is preserved separately and
was corrected before the valid causal reproduction. Both test themes use the
real theme provider. The test covers both code providers, active browser and
explore rows, provider/task icons, accessible Working labels, desktop letters,
and inactive rows behind Finished agents.

## Solution

Parent approved exactly four production files: pass the existing branch
`mobile` setting to coding/task rows, then to AgentStatusIndicator; only active
mobile status selects a static Bot. Shared indicator selection unifies the
mobile rule for both newly added row kinds. Removing all activity badges would
discard the intended Working state; making all badges static would discard
desktop behavior. Provider icons, labels, inactive glyphs, desktop dots,
disclosure semantics, original assertions and timeouts remain intact.

The permanent regression is
`front-end/src/tests/blackbox/sidebar-mobile-activity.blackbox.tsx`, discovered
by the existing Vitest `src/tests/blackbox/**/*.blackbox.{ts,tsx}` include.
The deploy pipeline's `frontend-coverage-blackbox` lane in
`scripts/run_deploy_pipeline.py` invokes front-end `npm run test:coverage`,
which uses that configuration. No runner exclusion or wiring change is needed.

The identical owning-boundary command
`cd front-end && npx vitest run src/tests/blackbox/sidebar-mobile-activity.blackbox.tsx`
passed all three cases in five consecutive runs after the fix (8.08, 12.18,
11.32, 10.87 and 8.38 seconds). The pre-fix valid run failed two mobile cases
and passed the desktop case in 9.23 seconds. The related
`rose-sidebar-code-agents.blackbox.tsx` and `rose-sidebar-tree.blackbox.tsx`
suites passed all 34 tests in 23.59 seconds. TypeScript, changed-file ESLint
and `git diff --check` passed.

After the parent rebuilt the stack from `220fd4f06`, the same canonical
sidebar runner passed **12/12** in 40.2 seconds, including the unchanged dark
mobile test in 2.5 seconds. The command differed only in the private output
prefix (`/home/boxes/rose/.context/dark-mobile-after`); all source/test hashes
for the four repaired files, new blackbox and existing semantic spec matched
the already verified snapshot. The exact previously failing count assertions,
contrast checks and one-layer disclosures passed without any test edit.
Native JSON/lifecycle receipts and the log are retained privately under that
prefix. Parent owns all service lifecycle, commits, full acceptance and deploy;
this focused repair does not claim a complete deployment or full semantic run.

10k-agent behavior: no API, polling, subscription, cache or tree traversal is
added. Each already mounted row passes one boolean; active mobile rows avoid
the letter-animation subscription. Desktop subscription behavior is unchanged.

Golden reference: not applicable (no approval-gated hunk).

## Independent assigned repair — November 11, 2026

Reused from unmerged PR1916 (head a5571947ccc95eb1c8f48974cd448a568b09582f), rather than duplicating its implementation. Current repair runs on Bugs devbox ce4276fb-7c13-4e72-b59b-444ad8e95afe, distinct from originating devbox93afb2e9. Fetched main contains the exact PR1918 merge3d3b9a2de7c600d0b9665f8b312bc99cbae02de1. Gate: NOT_INTRODUCED relative to PR1918; all six original fixture-backed traces were downloaded from GitHub Actions42959383180, and all six supplied file hashes matched. Their completed child and unconditional coding-row letters match the owning boundaries above. No agent/chat request or self-report exists for these fixtures.

Fresh local reproduction on d38c15a198462350ec23d155994549afcdadb382 ran `cd front-end && ../node_modules/.bin/playwright test tests-e2e/projects-sidebar-flow.spec.ts tests-e2e/sidebar-agent-tree.spec.ts --grep 'original project flow|dark mobile agents use robots' --workers 4`: all three original failures reproduced. Private artifacts and logs are retained under `.context/sidebar-repair/`. The reused mobile blackbox also reproduced both mobile failures with its desktop case passing before product edits. Current verification and full deploy receipts must certify this repair independently; historical PR1916 passes above are provenance only.

## Human feedback

The assignment requires preserving every assertion, timeout and actual failure,
coordinating exact hunks with the parent before editing, keeping one deploy
owner, and leaving parent services and Freedom untouched. All are retained.

## Reusable lesson

Propagate an existing presentation mode through every newly added child row and test the real branch with mixed child kinds before relying on top-level icon checks.
