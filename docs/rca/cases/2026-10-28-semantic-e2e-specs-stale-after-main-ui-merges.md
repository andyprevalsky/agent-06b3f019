---
id: 2026-10-28-semantic-e2e-specs-stale-after-main-ui-merges
date: 2026-10-28
title: Semantic Playwright specs stale after main's sidebar/composer/display UI merges
surface: front-end
component: front-end/tests-e2e (agent-display-panel, projects-sidebar-flow, sidebar-agent-tree)
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/tests-e2e specs asserting the pre-merge UI (Agent Display icon/drawer, chip flush-left, zero-delay right-click at y=107)
symptoms:
  - getByRole('button', { name: 'Agent Display', exact: true }) not visible
  - getByTestId('rose-project-menu') menuitem 'Rename project' not visible
  - model picker is flush bottom left Expected: < 1 Received: 32
tags:
  - semantic
  - playwright
  - stale-spec
sources:
  - commit e96364f3b (left bar redesign), 9bbe2253f (paperclip left of model), 0490bb1cc (agent display inline)
repro: front-end/tests-e2e/agent-display-panel.spec.ts, projects-sidebar-flow.spec.ts, sidebar-agent-tree.spec.ts
status: fixed
---

## Problem

After merging origin/main, 5 semantic specs failed (33/33 before). Identical failures on a clean origin/main (3d1415782) worktree + vite, so not branch-related.

## Diagnosis

Main's merges changed intended UI without updating e2e specs (semantic lane is not in main's CI): the Agent Display drawer/icon was removed for inline expandable displays; the paperclip now sits left of the model chip (32px offset); the left bar redesign moved project rows up to y=107. The project spec's zero-delay right-click released inside the Radix context menu's transient pre-measure rect (2,0,236x122) on "Delete project" (confirmed by pointerup target), hit only because the row moved from y=155 to y=107. Bisect: e96364f3b.

## Solution

Specs updated to the intended UI (no assertion weakened): inline display frame + expand toggle with the same WebGL interaction; paperclip flush-left with chip adjacent; right-click held 120ms like a person. 15 targeted specs pass on clean main; 33/33 on the deploy branch.

## Human feedback

None recorded.

## Reusable lesson

When a main merge fails untouched e2e specs, confirm on clean main first, then update specs to the intended UI; run semantic specs on UI-changing merges.
