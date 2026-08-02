---
id: 2026-07-06-benchmark-cookies-only-refreshed-at-setup-db-went-stale
date: 2026-07-06
title: Benchmark browser cookies were only refreshed at one-time setup-db, so authenticated runs used expired state
surface: harness
component: benchmark-fixtures
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/seed-local.ts --credentials-only — covered passwords/passkeys only and was never called from the benchmark runner
symptoms:
  - browser benchmark runs on stale cookies and loses the authenticated session
  - cookies refreshed only at one-time setup-db, never per run
  - credentials-only seed path never invoked by run_benchmark.py
tags:
  - benchmark
  - fixtures
  - cookies
  - credentials
  - staleness
sources:
  - memory:project_live_data_fixtures
repro: agents/tests/blackbox/benchmark.blackbox.py — live_fixture_* cases
status: fixed
---

## Problem

Benchmark tasks that need an authenticated browser realm were running against
stale browser state: cookies were only refreshed during the one-time
`setup-db` step and never again, so by run time they had expired. The
`--credentials-only` seed path that should have refreshed them covered
passwords/passkeys **only** and was never called from the runner at all.

## Diagnosis

Credentials were being modeled like reproducible database fixtures — frozen deltas
on a base image — when they are the opposite: compute tokens, cookies, and
passwords all expire, so they must be **current at runtime** and must never be
snapshotted. Nothing in the harness expressed that distinction, so the refresh
step had no place to hook in and silently drifted out of the run path.

## Solution

Introduced `live_fixtures` as a first-class, composable concept distinct from
`db_fixtures`: `agents/benchmarks/live_fixtures.py` holds the metadata registry
(`LiveFixtureSpec`, `LIVE_FIXTURES`, `DEFAULT_LIVE_FIXTURE="base"`,
`resolve_live_fixtures`), and `run_benchmark.py` gained runtime appliers
(`_apply_base_live_fixture`, `_apply_amazon_auth`, `_sync_browser_credentials`)
behind a `LIVE_FIXTURE_APPLIERS` dispatch table with an import-time assert that it
matches `LIVE_FIXTURE_NAMES`, replacing hardcoded per-task-name branches
(`AMAZON_COOKIE_BOOTSTRAP_TASK_NAMES` / `AMAZON_COOKIE_PAYMENT_TASK_NAME` deleted).
The `base` fixture is injected into every live/hybrid task the same way base images
are, so every such run pulls fresh compute tokens, cookies, and passwords.
`back-end/scripts/seed-local.ts --credentials-only` was broadened via a new
`syncBrowserState()` (context + cookies + localStorage + indexedDB + permissions +
cacheStorage), and `long_horizon.py:_validate_environment` rejects unknown fixture
names and `synthetic + live_fixtures`. Tests: `live_fixture_*` in the benchmark
blackbox (80 passing).

## Human feedback

None recorded.

## Reusable lesson

Anything that expires — cookies, tokens, passwords — must be re-synced per run and
never captured in a frozen fixture snapshot; give it a separate fixture concept so
the refresh cannot fall out of the run path.
