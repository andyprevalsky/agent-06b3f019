---
id: 2026-10-16-steel-auth-persist-navigation-tunnel-failure
date: 2026-10-16
title: Steel auth-persistence navigation failed once while unchanged focused and full follow-ups passed
surface: harness
component: browser-provider-live-qualification
classification: unresolved
problem_class: other
first_bad_boundary: browser-provider.auth-persist.live.ts readSignedIn switched Steel session navigates to example.com before restored-cookie and storage assertions
symptoms:
  - 'net::ERR_TUNNEL_CONNECTION_FAILED'
  - 'FAIL live Kernel/Steel auth persist'
  - '198 passed, 1 failed, 199 total'
tags:
  - browser-provider
  - steel
  - auth-persistence
  - proxy
  - coverage
sources:
  - PR #1510
  - commit 7ced2be3325b7043f4e214b6ad970543febcd745
  - task lantern-7ced2be3-backend
repro: 'Original normal npm run test:coverage, domain concurrency4/unit3/contract4, failed browser-provider; unchanged normal focused browser-provider and full coverage follow-ups passed. No deterministic causal reproduction.'
status: open
---

## Problem

At immutable `7ced2be3325b7043f4e214b6ad970543febcd745`, full backend owner71769 started at 04:18:19Z and failed after534.0s: 276 unit files passed, 198/199 blackbox domains passed. Browser-provider failed in its live auth-persistence case; coverage thresholds and both teardown regressions were not reached. The original failure remains retained.

## Diagnosis

Initial Kernel sign-in/export/close succeeded. Steel session creation succeeded at 04:20:25.239Z. `readSignedIn(switched.ws_url)` then navigated to `https://example.com/` and raised `net::ERR_TUNNEL_CONNECTION_FAILED` through the existing bounded navigation helper, before restored-cookie/storage assertions and the later Kernel allocation. No upstream HTTP status, proxy response, or timestamped individual navigation attempt was captured. The failure is bracketed by creation and cleanup beginning04:20:33.659Z; its deeper cause is unknown.

The fixture/provider/coverage files are byte-identical to prior passing9f/5221 sources. Current credential fields were present; values were neither printed nor historically compared. Root reported official Kernel/Steel status pages operational; that does not establish this session's transport cause or exclude a localized failure.

Native custody journal `auth-persist-ZdtzOf/custody.json` records cleanup-complete, zero failures, and successful release of both browsers, Kernel profile and local fixture. Processes joined, owned ports closed and prepared DB had zero other clients.

### Recurrence 2026-10-26 (PR fix/scale-s5-cookie-sync-diff deploy)

Backend coverage at `7825de8dd` (diff limited to the cookie upload path, no browser-provider code) failed only
`browser-provider` with the same `FAIL live Kernel/Steel auth persist: page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://example.com/`
(224/225 domains; bundle `backend-coverage-failed-20261026-175357-4111023`). The unchanged focused
`bash scripts/run-blackbox-tests.sh browser-provider` failed identically at ~18:00Z, so the tunnel failure persisted for
several minutes rather than being a single blip. The earlier coverage run on the same SHA (17:22Z) had passed this domain.

## Solution

No causal code fix was established or applied. Root authorized one unchanged normal focused retry: owner60543 ran `cd back-end && bash scripts/run-blackbox-tests.sh browser-provider`, actual start04:30:05.260021Z, next eligible due04:40:05.260021Z. It passed in105916ms (wrapper118.8s); custody cleanup succeeded and its newly owned standalone DB was dropped before further work.

The canonical coverage wrapper deletes raw V8 inputs at startup and EXIT; its failure bundle preserves logs, not raw V8. `--report-only` still runs the suites and only changes report enforcement. No supported partial resume or retained original V8 existed, so no synthetic report aggregation was attempted.

Root separately authorized one fresh full top-level coverage macro, owner50406, starting04:32:47.540323Z with the same source/normal command, explicit owned prepared DB and unchanged concurrency. It passed in545.1s: 276 units, 199/199 domains, statements/lines89.72%, branches81.25%, functions93.04%, both normal-exit and SIGTERM teardown regressions. Cleanup joined with ports closed/zero DB clients. These are recovery observations, not proof of a causal fix. Existing owning browser-provider coverage remains unchanged; no new test, skip, timeout, proxy or credential change was introduced. Transport cause remains open.

Private receipts are retained under the isolated preflight `.context/preflight-artifacts/`: original `backend-result-7ced2be3.json`, focused intent/log/cleanup, source/native timeline comparisons, and `backend-result-7ced2be3-followup.json`. The original failure bundle is `backend-coverage-failed-20261016-042712-3243065`.

## Human feedback

None recorded.

## Reusable lesson

An unchanged successful retry establishes recovery, not the cause of a missing proxy-transport response; preserve the original failure and distinguish canonical requalification from fabricated coverage reuse.
