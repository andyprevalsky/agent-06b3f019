---
id: 2026-10-15-cloud-package-metadata-refresh-aborted-best-effort-provisioning
date: 2026-10-15
title: Package metadata refresh aborted best-effort database provisioning
surface: infra
component: cloud-build
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: scripts/cloud-build.sh unguarded apt-get update inside the best-effort system Postgres fallback
symptoms:
  - FAIL an unavailable pgvector aborted cloud-build.sh
  - unavailable package metadata aborted dependency provisioning
tags:
  - apt
  - pgvector
  - provisioning
sources:
  - commit 0118ea315c327471d761d3939a715fc4c5a1eb9c
  - plan:.context/deploy-rejected-caps-20261015/cycle4-monitor/structuralfailure.raw.private.log
repro: scripts/tests/workspace-env.test.sh
status: open
---

## Problem

C4's unchanged workspace gate exited when its missing-extension fixture could not refresh package metadata. The intended owner contract provisions the independent Node/Python dependencies, then reports an unusable database honestly. The fixture passed on hosts already carrying the extension because that host state skipped the offending branch.

## Diagnosis

The system fallback explicitly handles a failed pinned extension build and failed distribution install, but its preceding `apt-get update` was unguarded under `set -e`. Thus metadata failure exited before either handled attempt or later dependency provisioning. Archive searches for the literal provisioning failure and pgvector metadata found the related 2026-10-01 PGDG/ABI case; this first bad boundary is separate from package compatibility. The isolated actual fallback returned exit 1 in 0.010 seconds before any provisioning continuation. No database, provider or package service was contacted in the reproduction; command fixtures own those boundaries.

## Solution

Log metadata-refresh failure, continue through the existing pinned build/distribution install, and retain `PG_FALLBACK_ERROR` so final build status still fails when the extension is unavailable. Do not report the database ready or change its installed major. A small extension of the existing owning workspace test makes the missing-extension precondition independent of host packages and keeps every existing assertion. That identical registered test file SHA256 `5f50cbf95ec38c1e769a34df5b1e9c9e00b030bc6ba5fda64bcf8311432f4218` failed against the original producer in 1.850 seconds and passed against the corrected producer in 2.638 seconds. This deletes an unintended early exit; it adds no model context, runtime retry budget, cap or global service mutation. Cost per startup is unchanged; there is no per-agent hot path at 10,000 agents. Full final-source deploy validation remains pending, hence open status.

## Human feedback

The user authorized infrastructure repairs and retained approval for WHM context changes. No timeout or benchmark contract was relaxed.

## Reusable lesson

Keep independent dependency provisioning alive after a best-effort prerequisite fails, while preserving the final prerequisite failure explicitly.
