---
id: 2026-11-10-semantic-project-flow-omitted-finished-disclosure
date: 2026-11-10
title: Project semantic flow omitted the newly required Finished agents disclosure
surface: harness
component: projects-sidebar-flow-playwright
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: projects-sidebar-flow.spec.ts expanded the root but asserted its completed child before opening the intentionally collapsed Finished agents drawer
symptoms:
  - "getByTestId('rose-folder-f-ui').visible().getByText('Audit navigation', { exact: true })"
  - "expect(locator).toBeVisible() failed"
  - "original project flow at 1280px"
  - "original project flow at 390px"
tags:
  - playwright
  - sidebar
  - completed-children
  - disclosure
sources:
  - commit 291e1a1301c65d2114a671cd260da84fb7f496dc
  - commit 7fb7d7d91069e4461dd9365ad40b289ce99b7265
  - commit 0207a5078885928b30db59c922934aed21543b5b
  - commit 6368e3c4ea7794e875d2f70e0f8f5dd001daebec
  - agent ph79jajav9c2tbbr0xpn3g1k9h8hz1td
  - agent ph7380r28dz4qjkhf0rbjtzdbn8hy26d
repro: front-end/tests-e2e/projects-sidebar-flow.spec.ts
status: fixed
---

## Problem

The full semantic command on current main 6368e3c4e failed at line 147 in both
original project-flow viewports, waiting 15000ms for Audit navigation after
expanding Rose work. The initial full command's latency lane overwrote its
standard Playwright output directory, so those original traces were unavailable.
A focused unchanged local run retained private native artifacts and reproduced
both exact failures. Its error-context shows Collapse Rose work expanded and
Finished agents (1) collapsed; Audit navigation is absent. No Rose agent ran for
this controlled API fixture, so there is no agent self-report to query.

## Diagnosis

Path: controlled agents/tree response -> useAgentTree -> RoseAgentBranch ->
completed-child partition -> collapsed Finished agents drawer -> semantic
visibility assertion. The private trace confirms agents/tree returned HTTP 200 with the root and
navigation-child both COMPLETED and the correct parent link. The child inherits
COMPLETED from the root fixture. The disclosure button appears, proving the child reached the branch model.
The test asks for the row before performing the additional disclosure action.

Gate: INTRODUCED relative to baseline 291e1a130 by current-main integration
7fb7d7d91 through 0207a5078. Baseline RoseAgentBranch rendered orderedChildren
directly; the integrated version intentionally partitions inactive children into
RoseFinishedAgentsDrawer, whose initial open state is false. The semantic spec
is identical at baseline291 and current6368. This does not attribute the change
to PR1912's branch: that merge also includes newer main-side work.

Owner-thread reading confirmed the user's explicit request to fold paused coding
sessions and completed browser/general-purpose agents into Finished agents.
Existing rose-sidebar-tree.blackbox.tsx independently asserts that completed
children are absent until that drawer opens and then selectable. Reverting the
renderer or forcing an active fixture would violate that contract. The deepest
owned gap is incomplete acceptance-flow integration when adding a disclosure:
the new lower-level behavior and the old semantic action sequence disagreed.

Archive searches used the raw string "Audit navigation projects-sidebar-flow
toBeVisible folderRow" and the behavior "project folder expand agent children
sidebar visibility". Related mobile polling and folder-driver-budget cases do
not share this boundary. This is a relative of acceptance-contract drift, not a
recurrence of those causes.

## Solution

Add four lines after expanding Rose work: locate its children, locate Finished
agents (1), assert it starts aria-expanded=false, and click it. Preserve every
original visibility/content/action assertion, the COMPLETED fixture, both
viewports and all timeouts. No production behavior changes. This corrects both
desktop and mobile flows through the shared drawer without mounting hidden rows
or changing subscription behavior for large lists.

Reproduction command (only the private report prefix differs between captures):
SEMANTIC_WORKERS=1 LOCAL_DB_PORT=5432 BACKEND_PORT=3001 FRONTEND_PORT=3002
SEMANTIC_NATIVE_REPORT_PREFIX=<private-absolute-prefix>
bash front-end/scripts/run-semantic-tests.sh projects-sidebar-flow

Original run: two exact line147 failures. Five consecutive corrected runs: 10/10 passes, no skips, retries or flakes.
Desktop/mobile durations in seconds were 10.7/8.4, 9.6/8.8, 8.6/7.4,
11.3/10.0, and 12.1/8.3. Existing tree/folder blackboxes passed 22/22
unchanged and supply owning-boundary coverage;
the corrected semantic itself remains in the canonical runner's discovered suite.
Removing exactly the four added lines restores the original spec byte for byte
(SHA256 5139901ee78fefd2a82f045f29a55b70373083a32a3facfb117c70ed71206b19);
final spec SHA256 is e422daa9983d159aab6e7b86c8ef595cc17675ec2dd8e892e194c1f6972a519e.
Formatting, diff whitespace checks and RCA archive validation pass. Parent owns
the full combined semantic command and deployment; those are not claimed here.
The spec was unchanged across the five passes, but sibling icon source changes
arrived during this verification; these runs do not certify a frozen combined
workspace. The parent must validate that final combined snapshot.
A temporary additional folder test failed at its fixture's missing Expand button,
was excluded as invalid causal evidence, and was removed; no blackbox assertion
was weakened. The final existing-suite run uses the untouched files.

## Independent assigned repair — November 11, 2026

Reused from unmerged PR1916 (head a5571947ccc95eb1c8f48974cd448a568b09582f), rather than duplicating its implementation. Current repair runs on Bugs devbox ce4276fb-7c13-4e72-b59b-444ad8e95afe, distinct from originating devbox93afb2e9. Fetched main contains the exact PR1918 merge3d3b9a2de7c600d0b9665f8b312bc99cbae02de1. Gate: NOT_INTRODUCED relative to PR1918; all six original fixture-backed traces were downloaded from GitHub Actions42959383180, and all six supplied file hashes matched. Their completed child and unconditional coding-row letters match the owning boundaries above. No agent/chat request or self-report exists for these fixtures.

Fresh local reproduction on d38c15a198462350ec23d155994549afcdadb382 ran `cd front-end && ../node_modules/.bin/playwright test tests-e2e/projects-sidebar-flow.spec.ts tests-e2e/sidebar-agent-tree.spec.ts --grep 'original project flow|dark mobile agents use robots' --workers 4`: all three original failures reproduced. Private artifacts and logs are retained under `.context/sidebar-repair/`. The reused mobile blackbox also reproduced both mobile failures with its desktop case passing before product edits. Current verification and full deploy receipts must certify this repair independently; historical PR1916 passes above are provenance only.

## Human feedback

Preserve all original assertions, fixtures, viewports and timeouts. Do not undo
the intentional Finished agents behavior. Parent is the sole deployment owner;
this worker coordinates exact hunks and runs no deployment or service changes.

## Reusable lesson

When an intentional disclosure changes, update acceptance actions to open it before retaining the same visibility assertions, and verify the default collapsed contract separately.
