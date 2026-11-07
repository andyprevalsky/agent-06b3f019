---
id: 2026-11-07-code-agent-work-history-spec-asserted-the-removed-work-slot-renderer
date: 2026-11-07
title: The semantic work-history spec still asserted the removed code-agent work slot after code agents moved to the root transcript renderer
surface: front-end
component: code-agent-view
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: front-end/tests-e2e/code-agent-work-history.spec.ts located code-work-slot, code-work-activities, a Work history pages navigation and a Working label that only the removed CodeSessionMessages renderer produced; the code-agent view now renders a running or finished turn as the root transcript's trajectory-work-group
symptoms:
  - "Locator: getByTestId('code-agent-view').getByTestId('code-work-slot') Expected: 1 Received: 0"
  - semantic-stack lane UI group failed 2 of 56 specs (claude and codex variants)
tags:
  - semantic-stack
  - code-agent-view
  - trajectory-work-group
sources:
  - PR #1744
repro: cd front-end and run FRONTEND_URL=<vite dev server> npx playwright test tests-e2e/code-agent-work-history.spec.ts --project chromium (red before the spec update, green three times after, both providers)
status: fixed
---

## Problem

The staged cycle's semantic-stack gate failed `code-agent-work-history.spec.ts` for both providers: the work slot the spec
looks for never renders. Gate: INTRODUCED. The branch's change that renders code agents through the root transcript removed
the main-line `CodeSessionMessages` work slot but left its semantic spec in place.

## Diagnosis

Local repro against a Vite dev server reproduced the exact failure. The page snapshot at failure shows one running work row
("Run echo command-29", elapsed time, a disclosure chevron), which is the root transcript's `TrajectoryWorkGroup`. The group
keeps the behaviours the spec exists to protect (a running turn is one row, steps appear on expansion, 20 steps a page opened on
the latest page for a running turn, a finished turn reads "Worked for ..." with an activity count, the final answer stays
outside the fold) under different hooks: `trajectory-work-group` (`data-state`), `trajectory-work-history`,
`trajectory-history-entry`, plain Previous/Next activities buttons and an `N / M` page label.

## Solution

The spec now asserts the same behaviours through the root transcript group's hooks. Two contract differences are written into
the spec rather than hidden: a running row names its latest activity instead of "Working", and the finished duration is timed
from the first to the last activity (56.7 s for this fixture) rather than from the turn record (57.7 s).

## Human feedback

None; found by the staged deploy cycle of PR #1744.

## Reusable lesson

When a renderer is replaced, search the semantic specs (not only the unit and blackbox tests) for its test ids and labels.
