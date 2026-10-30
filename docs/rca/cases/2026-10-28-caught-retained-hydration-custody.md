---
id: 2026-10-28-caught-retained-hydration-custody
date: 2026-10-28
title: Caught retained-browser hydration failure kept receipt in flight
surface: back-end
component: browser-resume-lifecycle
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The source-session or empty-provider guard returned before settling a definitely rejected hydration receipt.
symptoms:
  - 'The safe retained-session cases remained STARTED after a caught error and blocked later admission.'
  - 'Browser resume hydration outcome remains unknown'
tags:
  - pr1627
  - runtime
  - ownership
sources:
  - PR #1627
  - commit c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2
repro: node $R/run-owner.cjs $R/after hydration
status: open
---

## Problem

The safe retained-session cases remained STARTED after a caught error and blocked later admission. Frozen source is c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2. No integrated fix or deployed result is claimed.

## Diagnosis

The source-session or empty-provider guard returned before settling a definitely rejected hydration receipt. This boundary is demonstrated by unchanged regression bytes against temporary before/after production snapshots. Archive leads: 2026-10-28-failed-browser-hydration-retained-live-custody; 2026-10-28-hydration-source-release. Those related cases do not replace the current reproduction.

## Solution

Retain the native session, then atomically settle the rejected receipt under the existing owner, binding and user-control predicates. Unknown/crashed outcomes retain custody.

8 original owner scenarios plus five independent real-DB custody controls. The candidate passes; baseline fails the retained receipt assertion.

Evidence root: `/var/tmp/deploy-1627/cycle2-runtime-rca`. Original failure: `owner-hydration-before-final.log`. Candidate evidence: `owner-hydration-after.log` and `repeat-1.log` through `repeat-5.log`. All five iterations passed the same selected owner tests plus real local DB negative controls and actual Node18/20/22 probes. Official Node archives were verified against downloaded nodejs.org SHASUMS256 files; no toolchain installation occurred. The source-bound nine-file proposed patch SHA256 is `38a728f4b8a8096d96d436f4e31157f39d6576fac9e798faf6fbc13644bdecf8`; individual source and candidate hashes are in `manifest.json`.

Exact command (after `. /var/tmp/deploy-env.sh`, with `R=/var/tmp/deploy-1627/cycle2-runtime-rca`):

    node "$R/run-owner.cjs" "$R/after" hydration

For DB tests, set DATABASE_URL and DIRECT_URL to the existing local owning test database as captured in `repeat.sh`; each run uses UUID-owned rows and removes them in finally. No real browser/provider was called. Before comparison uses the identical candidate regression file with the original production snapshot; see `run-owner.cjs` for module binding, `owner-*-before*.log` for failures, and `repeat.sh` for exact final commands.

OPEN: parent independent review, source application, integrated typechecking/full gates and final deploy validation remain. Existing active checks are not superseded. Golden review does not apply: these are ordinary runtime/fixture/diagnostic changes, with no model-visible prompt or schema change. AutoFill remains HOLD.

## Human feedback

Parent required temporary-only work on frozen c8, actual old-runtime evidence, retained browser protection, unknown custody, disabled fallback, and unchanged budgets/assertions. Source owner alone may apply reviewed changes. Freedom remains protected.

## Reusable lesson

Do not conflate receipt settlement with releasing a native browser.
