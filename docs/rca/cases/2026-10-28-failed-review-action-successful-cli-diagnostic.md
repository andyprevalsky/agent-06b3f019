---
id: 2026-10-28-failed-review-action-successful-cli-diagnostic
date: 2026-10-28
title: A successful CLI record hid failed review action outcome
surface: harness
component: claude-review-fallback-diagnose
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: The diagnostic returned OK from is_error false without the enclosing action outcome.
symptoms:
  - 'An explicit failure action outcome plus successful CLI record produced OK.'
  - 'Claude review fallback diagnosis: OK'
tags:
  - pr1627
  - runtime
  - ownership
sources:
  - PR #1627
  - commit c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2
repro: python3 -B $R/after/scripts/tests/claude-review-fallback-diagnose.test.py
status: open
---

## Problem

An explicit failure action outcome plus successful CLI record produced OK. Frozen source is c8b8aeb2dfbc92cdb5c0d2de899bbf53d4a1b8e2. No integrated fix or deployed result is claimed.

## Diagnosis

The diagnostic returned OK from is_error false without the enclosing action outcome. This boundary is demonstrated by unchanged regression bytes against temporary before/after production snapshots. Archive leads: 2026-10-28-claude-review-explicit-session-limit. Those related cases do not replace the current reproduction.

## Solution

Pass inert steps.review.outcome to diagnostic; classify action failure as EXECUTION_ERROR and continue suppressing successful review body. The workflow stays disabled.

Nine owner tests pass after, including failure-vs-success and secret-body suppression. Credentials, dispatch and provider behavior are untouched.

Evidence root: `/var/tmp/deploy-1627/cycle2-runtime-rca`. Original failure: `owner-diag-before.log`. Candidate evidence: `owner-diag-after.log` and `repeat-1.log` through `repeat-5.log`. All five iterations passed the same selected owner tests plus real local DB negative controls and actual Node18/20/22 probes. Official Node archives were verified against downloaded nodejs.org SHASUMS256 files; no toolchain installation occurred. The source-bound nine-file proposed patch SHA256 is `38a728f4b8a8096d96d436f4e31157f39d6576fac9e798faf6fbc13644bdecf8`; individual source and candidate hashes are in `manifest.json`.

Exact command (after `. /var/tmp/deploy-env.sh`, with `R=/var/tmp/deploy-1627/cycle2-runtime-rca`):

    python3 -B "$R/after/scripts/tests/claude-review-fallback-diagnose.test.py"

For DB tests, set DATABASE_URL and DIRECT_URL to the existing local owning test database as captured in `repeat.sh`; each run uses UUID-owned rows and removes them in finally. No real browser/provider was called. Before comparison uses the identical candidate regression file with the original production snapshot; see `run-owner.cjs` for module binding, `owner-*-before*.log` for failures, and `repeat.sh` for exact final commands.

OPEN: parent independent review, source application, integrated typechecking/full gates and final deploy validation remain. Existing active checks are not superseded. Golden review does not apply: these are ordinary runtime/fixture/diagnostic changes, with no model-visible prompt or schema change. AutoFill remains HOLD.

## Human feedback

Parent required temporary-only work on frozen c8, actual old-runtime evidence, retained browser protection, unknown custody, disabled fallback, and unchanged budgets/assertions. Source owner alone may apply reviewed changes. Freedom remains protected.

## Reusable lesson

An inner operation result does not prove success of its enclosing action.
