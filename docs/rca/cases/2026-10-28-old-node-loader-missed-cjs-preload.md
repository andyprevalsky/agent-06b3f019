---
id: 2026-10-28-old-node-loader-missed-cjs-preload
date: 2026-10-28
title: Node 20.5 loader did not transform a CommonJS TypeScript child
surface: back-end
component: process-safety
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: typeScriptProcess supplied only the ESM loader on the pre-import Node path.
symptoms:
  - 'An actual official Node20.5.1 process raised Missing initializer in const declaration for the CJS TypeScript entry.'
  - 'SyntaxError: Missing initializer in const declaration'
tags:
  - pr1627
  - runtime
  - ownership
sources:
  - PR #1627
  - commit c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2
repro: $R/bin/node-v20.5.1-linux-x64/bin/node $R/node-proof.cjs $R/after/processSafety.cjs
status: open
---

## Problem

An actual official Node20.5.1 process raised Missing initializer in const declaration for the CJS TypeScript entry. Frozen source is c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2. No integrated fix or deployed result is claimed.

## Diagnosis

typeScriptProcess supplied only the ESM loader on the pre-import Node path. This boundary is demonstrated by unchanged regression bytes against temporary before/after production snapshots. Archive leads: 2026-10-28-node-loader-file-url. Those related cases do not replace the current reproduction.

## Solution

Add tsx/cjs via --require only to the legacy --loader branch. Preserve the Node22 --import argv, direct interpreter ownership and timeouts.

Node20.5.1 fails before and passes after. Node18.17.1 passes both: no Node18 failure claim. Node22 passes; all four owner unit tests pass after.

Evidence root: `/var/tmp/deploy-1627/cycle2-runtime-rca`. Original failure: `node-20.5.1-before.log`. Candidate evidence: `node-20.5.1-after.log` and `repeat-1.log` through `repeat-5.log`. All five iterations passed the same selected owner tests plus real local DB negative controls and actual Node18/20/22 probes. Official Node archives were verified against downloaded nodejs.org SHASUMS256 files; no toolchain installation occurred. The source-bound nine-file proposed patch SHA256 is `38a728f4b8a8096d96d436f4e31157f39d6576fac9e798faf6fbc13644bdecf8`; individual source and candidate hashes are in `manifest.json`.

Exact command (after `. /var/tmp/deploy-env.sh`, with `R=/var/tmp/deploy-1627/cycle2-runtime-rca`):

    "$R/bin/node-v20.5.1-linux-x64/bin/node" "$R/node-proof.cjs" "$R/after/processSafety.cjs"

For DB tests, set DATABASE_URL and DIRECT_URL to the existing local owning test database as captured in `repeat.sh`; each run uses UUID-owned rows and removes them in finally. No real browser/provider was called. Before comparison uses the identical candidate regression file with the original production snapshot; see `run-owner.cjs` for module binding, `owner-*-before*.log` for failures, and `repeat.sh` for exact final commands.

OPEN: parent independent review, source application, integrated typechecking/full gates and final deploy validation remain. Existing active checks are not superseded. Golden review does not apply: these are ordinary runtime/fixture/diagnostic changes, with no model-visible prompt or schema change. AutoFill remains HOLD.

## Human feedback

Parent required temporary-only work on frozen c8, actual old-runtime evidence, retained browser protection, unknown custody, disabled fallback, and unchanged budgets/assertions. Source owner alone may apply reviewed changes. Freedom remains protected.

## Reusable lesson

Exercise the actual declared runtime and module format rather than inferring compatibility from flag selection.
