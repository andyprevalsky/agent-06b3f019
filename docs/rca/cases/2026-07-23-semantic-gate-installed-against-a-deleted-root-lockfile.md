---
id: 2026-07-23-semantic-gate-installed-against-a-deleted-root-lockfile
date: 2026-07-23
title: The production semantic gate installed dependencies against a root lockfile that no longer existed, so its installs were unreproducible
surface: infra
component: semantic-deploy-gate
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: .github/workflows/chat-lifecycle-ratchet.yml — the semantic dependency install ran from the repository root, whose lockfile had been deleted
symptoms:
  - production semantic dependency install has no lockfile to resolve against
  - chat-lifecycle-ratchet installs resolve different dependency versions per run
  - production workflow-marker validation fails on a Temporal visibility query mismatch
tags:
  - semantic-gate
  - lockfile
  - npm-ci
  - github-actions
  - temporal-visibility
sources:
  - PR #868
repro: scripts/tests/semantic-deploy-gate.test.sh
status: fixed
---

## Problem

The production semantic gate installed its dependencies from the repository root,
but the root lockfile had been deleted — so the gate had nothing to pin against and
its installs were not reproducible run to run. Separately, the production
workflow-marker validator failed when the Temporal visibility query returned a
mismatch, taking the gate red for a reason unrelated to the product.

## Diagnosis

The front-end package had no committed lockfile of its own, and the workflow's
install step still pointed at the (now absent) root lockfile, so dependency
resolution fell back to unpinned resolution against the registry. That makes the
gate's outcome a function of whatever the registry serves at that moment rather
than of the committed tree — the same fragility class that had already produced a
phantom-version install failure. The validator half was a strictness problem: it
treated a Temporal visibility query mismatch as fatal instead of tolerating the
visibility store's expected lag/shape differences.

## Solution

Committed a front-end-scoped lockfile and pointed the semantic dependency install
at the front-end package instead of the deleted root lockfile, making installs
reproducible; and hardened `back-end/scripts/validate-prod-workflow-migration.ts`
against Temporal visibility query mismatch. Verified with
`npm ci --ignore-scripts --workspaces=false` in `front-end`,
`scripts/tests/semantic-deploy-gate.test.sh`,
`scripts/tests/workflow-deployment-migration.test.sh`, backend `tsc --noEmit`, and
prettier on the changed workflow and script.

## Human feedback

None recorded.

## Reusable lesson

Every CI install must resolve against a committed lockfile in the package it
installs from — a deleted or absent lockfile silently converts a gate into an
unpinned registry query.
