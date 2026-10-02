---
id: 2026-10-02-browser-live-test-used-pre-rotation-proxy-tier
date: 2026-10-02
title: The live Kernel stale-proxy test reused the pre-rotation residential tier after switching to mobile
surface: back-end
component: browser-provider
classification: test-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser-provider.live.support.ts passed initial residential metadata to assertResumeReprovisionsDeletedProxy after a mobile rotation; the helper also built residential-only candidates
symptoms:
  - "FAIL live Kernel provider parity: resume after a deleted cached proxy downgraded kernel_residential_city to kernel_mobile_city"
  - "no managed proxy candidate for source kernel_mobile_city"
tags:
  - deploy
  - blackbox
  - kernel
  - proxy
  - test-bug
sources:
  - PR #1344
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: fixed
---

## Problem

After merging `origin/main`, the integrated backend coverage gate passed all 233 unit files but failed the live `browser-provider` domain. The assertion reported a change from `kernel_residential_city` to `kernel_mobile_city` after the test deliberately deleted a cached proxy. The failure is recorded in `.context/deploy-runs/20261002-155611-70059/logs/backend-coverage-blackbox-20261002-160236-50669.log`.

## Diagnosis

The test initializes a session on a residential city proxy, rotates it to a mobile city proxy, then runs the stale-proxy resume leg. At that boundary, it passed the initial `metadata.proxy_source` and `metadata.proxy_location`, although the active session had `mobileMetadata`. The observed mobile result was therefore the correct tier for the session but failed against the test's stale residential expectation. Switching the argument exposed a second test-helper assumption: `kernelProxyCandidates(agentLocation)` defaults to residential, so it could not construct a candidate for `kernel_mobile_city`.

The first bad data is the test's post-rotation input to `assertResumeReprovisionsDeletedProxy`, followed by the helper's residential-only candidate lookup. This is related to the 2026-10-01 shared-proxy case, but is not its recurrence: no project-shared proxy was deleted and the product proxy ladder did not downgrade. Archive searches used the literal assertion text and `mobile proxy rotation stale cache browser provider live parity`.

## Solution

Pass `mobileMetadata.proxy_source` and `mobileMetadata.proxy_location` to the stale-proxy leg. In the helper, derive the managed proxy type from the source under test before asking `kernelProxyCandidates` for that type. Keep the same assertion that resume preserves the current source and location after deletion.

The unchanged focused command `cd back-end && bash scripts/run-blackbox-tests.sh browser-provider` failed with `no managed proxy candidate for source kernel_mobile_city` before the helper fix and passed `browser-provider` (92.124 seconds) after it. The full backend coverage gate then passed all 170 blackbox domains, including `browser-provider` in 102.181 seconds, and all 233 unit files. These changes run only in the test harness; they add no production channels, queries, or per-agent state at 10,000 agents.

## Human feedback

None recorded.

## Reusable lesson

Carry the current session's provider metadata through every post-rotation test leg, and build test fixtures from that tier rather than a default tier.
