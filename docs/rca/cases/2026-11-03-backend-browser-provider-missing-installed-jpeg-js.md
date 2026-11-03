---
id: 2026-11-03-backend-browser-provider-missing-installed-jpeg-js
date: 2026-11-03
title: Backend browser-provider failed at module load because declared jpeg-js was absent from the installed tree
surface: harness
component: backend-installed-dependencies
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: browser-provider support imported declared jpeg-js 0.4.4 but Node resolution found no installed package
symptoms:
  - "Error: Cannot find module 'jpeg-js'"
  - MODULE_NOT_FOUND in browser-provider.tilion-live.support.ts
  - browser-provider domain failed before assertions
tags:
  - jpeg-js
  - node
  - installed-tree
sources:
  - PR #1664
  - commit 61c3f876ee37d6b52a29c6d870d9459a90a33307
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: mitigated
---

## Problem

The first full two-shard backend coverage invocation on November 3 failed the
browser-provider domain before assertions. The sibling shard passed 120/120;
the affected shard passed 118/119. Both outcomes are retained separately from
the assigned frontend test's successful original four-worker invocation.

## Diagnosis

The backend manifest and committed lock declare jpeg-js 0.4.4, but the current
installed tree could not resolve it. The first bad boundary is local module
resolution, not the browser-provider implementation. Backend production and
test source were unchanged from main. Why the earlier workspace setup omitted
the package was not reproduced; this case does not diagnose npm, pruning, or
cloud-init. Searches for MODULE_NOT_FOUND/jpeg-js and workspace installed-tree
issues found related July 24 lockfile and September 9 pruning cases, without
proof of either mechanism recurring.

## Solution

Restore the exact existing declared package in the local dependency tree: npm
pack 0.4.4, verify its SHA-512 against both committed lock integrity and npm's
receipt, extract to a staging directory, then rename atomically. All nine
installed files matched the retained tar members. Resolution and a real 1x1
JPEG encode/decode passed. No source, manifest, lockfile, test, or environment
configuration was changed. This is a local mitigation, not a durable installer
fix. The full unchanged failed-first two-shard gate was rerun; its terminal
outcome and clocks are retained with the deployment receipts. The failed
attempt and raw coverage remain preserved.

The private evidence directory mobile-pwa-fixture-repair contains the first
native logs and manifest, dependency-repair/restoration-receipt.json, exact
locked tarball, independent review, and complete backend retry. No credentials
are published. Golden reference and 10k-agent runtime impact: not applicable;
production code is unchanged.

## Human feedback

The user required recovering running gates rather than duplicating them,
preserving actual failures and clock bounds, and finishing all remaining gates
and deployment. No permission to waive this backend failure was given.

## Reusable lesson

Verify the declared dependency at its actual Node resolution boundary and restore only the lock-integrity-matched package while retaining the failed gate and full rerun.
