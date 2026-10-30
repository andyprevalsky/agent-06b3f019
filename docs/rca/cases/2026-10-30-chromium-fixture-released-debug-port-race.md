---
id: 2026-10-30-chromium-fixture-released-debug-port-race
date: 2026-10-30
title: Local Chromium fixture released its debugging port reservation before launch
surface: harness
component: browser-tilion-chromium-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The parent released a selected TCP port before Chromium could bind it
symptoms:
  - /json/version not ready after 100 attempts
  - bind() failed Address already in use
  - Failed to start remote debugging http server
tags:
  - chromium
  - port-allocation
  - fixture-isolation
sources:
  - commit 9c30058e4deb8ee45c40596616b08d62e4a168e8
  - plan:/project/rose-speed-comparison-20261028/chromium-startup-rca/review-manifest.json
repro: cd agents && venv/bin/python scripts/run_blackbox_tests.py browser-tilion
status: mitigated
---

## Problem

The full browser domain failed while waiting for local Chromium on port 50959. The fixture discarded Chromium stderr and removed its profile, so the initiating cause of that original failure is unknown. It is not a Tilion provider outage. Inspection found a separate reproducible race: the parent reserved and released a port before the child bound it.

## Diagnosis

An unchanged ordinary capture passed in 7.366 seconds. A controlled competing bind at the released-reservation boundary made the same original case fail in 10.841 seconds. Captured native stderr showed EADDRINUSE and an IPv6 DevTools endpoint while the fixture probed IPv4. The same controlled command passed in 7.642 seconds with the candidate. This proves the race exists, not that it caused the uncaptured original failure. Prior WebAuthn document-service disconnect research concerns a later browser lifetime boundary and does not establish this startup cause.

The permanent regression failed against the original helper in 10.854 seconds and passed against the corrected helper in 0.673 seconds. Six focused checks passed, including the original popup assertions. Independent review of patch SHA256 35d3aa622fa475d9c0eb00abce53a5738a97209f48c026f9bd8c4537497566b1 found no blocking issues and confirmed all pre-existing tests and forty-popup assertions were unchanged.

## Solution

Full Chromium launches with remote-debugging-port=0 and its unique profile's native DevToolsActivePort file supplies the selected port. Missing, partial, or invalid files stay inside the existing 100-attempt readiness budget; this is not a strict ten-second wall clock because HTTP requests also take time. The non-full launch path is unchanged. Startup is inside protected cleanup, and bounded stderr is retained in failures. The actual integrated full browser-tilion domain passed: exit 0, one domain, zero failures, 136.2 seconds. Deployment remains pending. The original startup cause remains unknown, hence mitigated status rather than a claim that the original incident is conclusively fixed.

## Human feedback

The user requested completion of deployment while preserving failed evidence and allowing only explicit provider-outage skips. This local failure was repaired and tested rather than classified as a provider skip. No production browser session, provider allocation, credential, lease, or protected resource was changed.

## Reusable lesson

Let the child atomically choose and publish its listening port. A parent bind-close-launch sequence is not a reservation, and discarded native stderr prevents later attribution.
