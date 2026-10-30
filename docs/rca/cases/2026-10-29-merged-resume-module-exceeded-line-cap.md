---
id: 2026-10-29-merged-resume-module-exceeded-line-cap
date: 2026-10-29
title: Merged resume module exceeded its unchanged lint line cap
surface: back-end
component: browser-session-resume
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The combined main and speed-integration module had 602 counted code lines against the existing 600-line ESLint maximum.
symptoms:
  - 'File has too many lines (602). Maximum allowed is 600'
  - 'max-lines'
tags:
  - pr1627
  - lint
  - integration
sources:
  - PR #1627
  - commit 0c798385b66e049979c684ed3478940371539e85
repro: cd back-end && npx eslint src/providers/browserSessionResume.ts
status: open
---

## Problem

The frozen combined source passed TypeScript but its full lint lane failed with 602 counted code lines against the unchanged 600-line limit. Incoming main added its in-place Tilion branch to a module already close to that boundary. No runtime defect or raised limit is claimed.

## Diagnosis

The existing three type imports were separately re-exported from their source module in a five-line declaration. Re-exporting those same local imported bindings removes the redundant module specifier and is naturally formatter-stable. A first proposal merely compressed the original re-export to103characters; independent review rejected it because repository Prettier re-expanded it. That rejected proposal remains outside source.

Related archive cases read: `2026-10-15-coverage-unit-combined-independent-db-replay` (merged fixture file size) and `2026-10-06-hub-store-aggregated-independent-projections` (storage-module cohesion). They preserve the same size contract but do not establish this redundant type-export boundary.

## Solution

Use `export type { UserSettings, SerializedPassword, SerializedPasskey };`, retaining the exact existing imported aliases. Candidate patch SHA25658fd6e6c60cb3cf3db28e9c468b2c135bbfb8d50d55b2256cd99762dca5e5c46. No implementation statement, gate, assertion, formatter rule or line maximum changes.

Evidence: `/var/tmp/deploy-1627/main338-type-export/`. `proof.json` verifies identical emitted JavaScript SHA256 and identical TypeScript checker declaration targets for all three public aliases. Both declaration emits succeed without diagnostics; before/after d.ts differ only in equivalent re-export syntax. Repository Prettier returns the candidate byte-for-byte and actual ESLint stdin with the original filename passes. Original full-lane failure remains in `.context/deploy-pipeline-main338/logs/eslint.log`.

Exact candidate verification from the integration root, after sourcing its normal deploy environment:

    cd back-end
    npx prettier --stdin-filepath src/providers/browserSessionResume.ts < /var/tmp/deploy-1627/main338-type-export/after.ts
    npx eslint --stdin --stdin-filename src/providers/browserSessionResume.ts < /var/tmp/deploy-1627/main338-type-export/after.ts
    node /var/tmp/deploy-1627/main338-type-export/prove.cjs

OPEN until source-owner application at the immutable boundary, integrated lint/typecheck, exact-source review and required final release validation. Existing runtime receipts remain under their original source hashes; no automatic cache hit or new-SHA pass is fabricated.

## Human feedback

Independent technical review required a naturally formatter-stable consolidation, declaration/API equivalence and unchanged runtime output. A type-only equivalent syntax repair does not waive any release gate. Freedom and all protected instructions remain unchanged.

## Reusable lesson

Check lint on the combined integration snapshot; independently valid branches can cross a shared file limit when merged. Prefer removing redundant syntax over formatting that fights the repository formatter.
