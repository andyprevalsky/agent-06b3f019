---
id: 2026-10-01-benchmark-share-blackbox-required-a-prod-secret
date: 2026-10-01
title: The benchmark-share blackbox required a production signing secret that cloud VMs do not have
surface: back-end
component: blackbox-launchers
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/benchmark-share.blackbox.ts read BENCHMARK_SHARE_SECRET from the developer environment
symptoms:
  - BENCHMARK_SHARE_SECRET is required for benchmark-share blackbox
  - FAIL  benchmark-share
tags:
  - blackbox
  - fixtures
sources:
  - PR #1364
repro: back-end/src/tests/blackbox/benchmark-share.blackbox.ts
status: fixed
---

## Problem

Backend coverage on a Cursor Cloud VM failed the `benchmark-share` domain at import time with "BENCHMARK_SHARE_SECRET is required for benchmark-share blackbox".

## Diagnosis

The domain signs share tokens and verifies them against the isolated local backend, so any secret works as long as the test and the backend agree. It read the secret from the ambient environment (`back-end/.env`), which on developer machines contains the production value. The cloud VM's synthesized `.env` has no such key, and neither launcher provided a test value. A local test should not depend on, or sign with, a production secret.

## Solution

`back-end/scripts/blackbox-auto-rca-env.sh`, which holds the deterministic credentials that both backend blackbox launchers source before booting the backend, now exports `BENCHMARK_SHARE_SECRET=blackbox-benchmark-share-secret`. `coverage-script.test.ts` asserts the export. The test and the backend inherit the same value, so the domain no longer needs the production secret.

## Human feedback

None recorded.

## Reusable lesson

A blackbox test that only needs the two sides to agree on a secret should get a fixed test value from the launcher, never the ambient production one.
