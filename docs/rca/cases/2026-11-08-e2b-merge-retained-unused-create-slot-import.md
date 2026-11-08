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
  - "DEPLOY_FREEZE BLOCKED: fix the remaining format/lint errors first"
tags:
  - e2b
  - merge
  - lint
sources:
  - commit 5809574d5e0323fb2f285ce34746f955acde7593
  - commit 9fa85f91bcb5262b756779727572c9982ef81c3e
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
