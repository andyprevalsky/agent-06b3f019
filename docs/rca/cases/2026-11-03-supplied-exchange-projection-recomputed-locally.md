---
id: 2026-11-03-supplied-exchange-projection-recomputed-locally
date: 2026-11-03
title: Supplied exchange grouping still recomputes local history and starts a second clock
surface: front-end
component: message-list-projection
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/useMessageListProjection.ts invokes local exchange grouping before selecting the supplied grouping
symptoms:
  - A genuine10001st insertion reads10000 persisted timestamps again after the supplied projection is already complete
  - A supplied exchange projection starts an unused10000ms interval
tags:
  - trajectory
  - projection
  - lifecycle
sources:
  - PR #1670
  - commit 11c6e07269b47a3db1f6b096a8779453e109ce9d
repro: front-end/src/tests/blackbox/rendering-review-lifecycle.blackbox.tsx
status: fixed
---

## Problem

The exported list boundary accepts precomputed exchange groups, but still computes its own local groups and installs a periodic clock before rendering the supplied result. No current app caller supplies this option: this is a reproduced conditional API-boundary defect, not an observed live-production rootcause.

The real-hook regression starts with10000 valid agent exchanges, performs a genuine10001st insertion, computes the owner projection, then counts actual persisted timestamp reads during the consumer update. The original consumer repeats10000 reads and starts one unused interval. Rendered representative rows and animation completion are asserted separately.

## Diagnosis

Path: complete message history → owner grouping → supplied projection → consumer local grouping → rendered row filtering.

The first bad boundary invokes useAgentExchangeGroups without its supplied grouping; selecting the supplied object afterward does not undo the work or timer. Reading inserted history once is required for grouping. Repeating that read in a consumer that already owns the result is avoidable.

Archive searches used the exact hook/projection names and behavioral duplicate-grouping/clock terms. No same-boundary recurrence was established; other grouping-control cases are relatives only.

## Solution

Pass the optional supplied grouping into the owning exchange hook. Enabled grouping uses that object and retains folded animation completion while omitting its unused local periodic clock. Without a supplied grouping, the same local grouping/10000ms clock is retained. Disabled/compressed grouping retains its completion behavior.

The unchanged regression observes zero duplicate timestamp reads after the real insertion, one folded completion and no second clock. Positive controls advance the original fallback clock, preserve disabled callback semantics and verify cleanup. The normal seven-case suite on the original merged 7e51f7e9 modules fails four cases and passes three controls; the literal final formatted regression also reproduces that result against byte-exact original modules in an ignored import copy. The actual repaired production modules pass all seven cases on five consecutive unchanged runs of `npx vitest run src/tests/blackbox/rendering-review-lifecycle.blackbox.tsx` in front-end. Eight related rendering and lifecycle suites pass all 60 tests. Focused ESLint, formatting and combined full frontend typecheck pass. No arbitrary timing threshold or truncation is used. Full combined release gates and production verification remain pending.

This removes redundant O(n) history projection only when the caller supplies the result. It does not make the required owner scan sublinear or change visible rows, content, age formatting or motion.

## Human feedback

Keep all history, grouping order and animations; prove actual insertion work and resource ownership rather than only memo identity. Preserve original fallback behavior and do not claim this unused option caused the observed live workload.

## Reusable lesson

Select the owner of a projection before doing the work. Keep clock and completion ownership together so avoiding duplicate data work does not introduce a second timer or lose a required callback.
