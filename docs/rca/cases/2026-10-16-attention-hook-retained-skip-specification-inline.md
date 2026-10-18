---
id: 2026-10-16-attention-hook-retained-skip-specification-inline
date: 2026-10-16
title: Formatted attention hook retained skip action assembly beyond its function limit
surface: front-end
component: attention-inbox
classification: our-bug
problem_class: other
first_bad_boundary: The formatted useAttentionActions hook retained the independent skip action specification inline and exceeded the configured 80-line function limit
symptoms:
  - Function 'useAttentionActions' has too many lines (85). Maximum allowed is 80
  - max-lines-per-function
tags:
  - eslint
  - attention
  - function-boundaries
sources:
  - commit 5221bbe19912e50137e1d4217c3fde850de48828
  - task .context/lantern-live405b/.context/preparation5221bbe1/frontend-eslint.log
  - task .context/lantern-attention-lines5221/.context/attention-lines-rca/red.log
repro: cd front-end && node /home/boxes/rose/node_modules/eslint/bin/eslint.js src/features/terminal-component-group/components/attention-inbox/useAttentionActions.ts
status: fixed
---

## Problem

The fresh combined qualification's changed-frontend ESLint stage rejected
useAttentionActions at 85 counted lines against the existing 80-line limit.
Formatting and TypeScript checks passed; this was a function boundary violation,
not a product behavior failure. The exact affected-file ESLint command reproduced
that error in a detached worktree before the extraction. The original frozen
frontend coverage, build and static receipts remain attached to their source.

## Diagnosis

The hook coordinates state and four user actions. Its skip handler also built a
self-contained ActionSpec using only requestId and requests. Keeping that assembly
inside the main hook made normally formatted source exceed its function contract.
Archive searches for frontend attention max-lines extraction and formatting lint
found related module-size boundary cases, not this specific hook. This repair
neither relaxes the rule nor compresses formatted source to hide the size.

## Solution

Extract the existing skip specification into a typed same-file skipActionSpec
helper, and pass its result to the unchanged runner. Preserve the same remaining
count, mutate closure, toast strings and keepOpen value. Authored respond/reject
bytes, protocol overrides, optimistic state, loading/error handling and iMessage
paths remain unchanged. No prompt, UX, lint configuration or timeout changes.

Run the same affected-file ESLint command RED then GREEN. Check formatting and
TypeScript, and run existing approval-authored-context and low-cov-chips blackbox
owners rather than adding tests that mirror the extraction. The full combined
qualification remains root-owned; this local repair does not relabel earlier
source receipts or authorize deployment.

## Human feedback

None recorded.

## Reusable lesson

Move independent action-specification assembly out of an orchestration hook before formatted code exceeds its unchanged function boundary contract.
