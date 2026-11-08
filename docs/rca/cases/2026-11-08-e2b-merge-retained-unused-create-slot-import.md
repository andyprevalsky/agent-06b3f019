---
id: 2026-11-08-e2b-merge-retained-unused-create-slot-import
date: 2026-11-08
title: E2B merge retained a create-slot import after moving its callers
surface: back-end
component: providers/e2b.ts
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: merge 580 retained the main create-slot import without its wrapper call
symptoms:
  - "'withClaudeCodeCreateSlot' is defined but never used"
  - "@typescript-eslint/no-unused-vars"
  - "TS2304: Cannot find name ProjectWorkspace"
  - "DEPLOY_FREEZE BLOCKED: fix the remaining format/lint errors first"
tags:
  - e2b
  - merge
  - lint
sources:
  - commit 5809574d5e0323fb2f285ce34746f955acde7593
  - commit 9fa85f91bcb5262b756779727572c9982ef81c3e
  - commit ec431bc51657e78b25bfad7caf816247b0009a81
  - agent ph78myb8q8q683vq35tk6e500n8htjvv
repro: cd back-end && node node_modules/eslint/bin/eslint.js src/providers/e2b.ts
status: open
---

## Problem

The normal deploy freeze failed on e2b.ts line 41 because withClaudeCodeCreateSlot was imported but never used. The original freeze log and the exact ESLint stdin reproduction are retained in the private cli-nov08-user-sync evidence directory.

## Diagnosis

Gate: INTRODUCED by merge 580 relative to both parents. Main 131f imported and called the outer wrapper; the CLI parent had neither. The merge kept the import and the direct createClaudeCodeSessionUnlocked call. The later 9fa commit preserved those exact bytes. The lower-level sandbox acquisition/resume and native template reservation still use the real create-slot helper. Their source hashes and call sites were checked separately.

## Solution

Remove only the unused import from e2b.ts. Keep every function body, native template call and lower-level serialization guard unchanged. With the same installed ESLint, configuration and canonical filename, the original source failed in 0.894 seconds and the patched source passed in 0.836 seconds. The existing no-unused-vars rule is the permanent regression check. The full normal freeze and deployment remain required; this local check grants no deployment credit.

## Human feedback

None recorded for this specific import failure. The parent requested a bounded scratch-only investigation while the existing deployment continued.

## Reusable lesson

Reconcile imports with their surviving callers when merging a wrapper refactor, then run the owning lint rule without weakening it.

## Recurrence — retained ProjectWorkspace use lost its type import (2026-11-08)

The native quick52 TypeScript command exited 2 on frozen source ec431bc5:
`src/providers/e2b.ts(513,24): error TS2304: Cannot find name 'ProjectWorkspace'.`
Its original receipt and output remain in
.context/cli-nov05-cycle/attempts/52/quick/typescript/. The gate recorded
UNVERIFIED, not PASS, and the parallel quick gates continued separately.

This is the same merge-import reconciliation incident. Main 131f588d had both
`import type { ProjectWorkspace } from './projects/types'` and the
harnessOptions.projectWorkspace field. CLI parent 7c93c06a had neither. Merge
5809574 retained that field but lost its type import, and ec431bc5 still has the
missing binding. The earlier unused-value-import fix did not add the missing
type binding; its focused ESLint pass was not a TypeScript compilation pass.

Restore only the type-only import. Every function body, runtime import, guard
and timing remains unchanged. A TypeScript CompilerHost substitutes only the
canonical e2b.ts text from private scratch and asks for that source file's
semantic diagnostics with the real backend compiler configuration. The original
input reports TS2304; the patched input has no diagnostics for this file.
This is explicitly a scoped Compiler API result, not the native full `tsc`
command or deployment acceptance. The parent must run that exact native command
after the remaining quick gates terminate. Evidence and source comparisons are
in .context/cli-nov08-user-sync/project-workspace-type-result.json.

The operational handoff required isolated scratch while canonical source and
other quick jobs remained frozen, and prohibited dependency, provider, database
and financial actions. It is not a new direct user quote about product policy.
The existing TypeScript gate is the owning regression check; no duplicate test
or new RCA case is introduced. Overall case status remains open pending native
full compilation and deployment verification.

Parent validation on the applied type-only change: the exact native full backend
TypeScript command exited 0 (session 91611), followed by focused Prettier and
ESLint checks with no errors. The original quick52 failure remains retained;
new-source native quick and full deployment validation are still required.
