---
id: 2026-10-01-steel-cdp-timeout-lost-in-replacement-error
date: 2026-10-01
title: Steel replacement hid a CDP timeout behind a generic validation error
surface: back-end
component: steel-session-replacement
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/steel/sessionConnection.ts returned only false after a CDP Connection timeout
symptoms:
  - "Failed to create Steel replacement after 5 attempts: Session validation failed on attempt 5"
  - "browser-provider blackbox failed after 659790ms"
tags:
  - steel
  - browser-provider
  - deploy-gate
sources:
  - task backend coverage blackbox run 20261002-013846-63410
  - task backend coverage blackbox run 20261002-021934-49135
  - task Steel server log at 2026-10-02T01:47:25Z
repro: back-end/src/tests/blackbox/steel-fingerprint.connection-retry.behavior.ts
status: fixed
---

## Problem

The post-merge back-end coverage gate passed 165 of 167 blackbox domains. In the live browser parity domain, Kernel residential and mobile IP rotation passed, but the Kernel-to-Steel switch failed after four HTTP retries. The API returned a 500 with only `Session validation failed on attempt 5`, so the intentionally narrow Steel outage classifier correctly refused to skip the live Steel legs. The backend log showed the missing detail: each new Steel session was created, then its CDP connection validation ended in `Connection timeout` after the bounded retries.

## Diagnosis

The path was Steel session create → `connectValidatedBrowser` CDP check → `validateSessionConnection` boolean → `recreateSession` replacement error → `/rotate-proxy` 500 → live parity classifier. `connectValidatedBrowser` logged the connection timeout and returned `null`; the boolean adapter discarded the failure reason. `recreateSession` consequently emitted a generic validation error. The first bad boundary is the loss of the typed connectivity result, before the API response or classifier. An auth rejection must still fail the parity gate, so broadening the classifier to accept every validation failure would be wrong.

Archive searches for `Failed to create Steel replacement Session validation failed Connection timeout` and `Steel CDP validation timeout live parity outage` found earlier Steel parity and connectivity cases, but none established this reason-loss boundary.

## Solution

The Steel connection adapter now returns a bounded, non-secret failure category to the replacement path. `Connection timeout` and `Connection error` survive the final replacement error, while authentication rejection remains distinct and stops CDP retries. The browser parity classifier still requires a Steel 5xx with an explicit connectivity reason. One owning-boundary test injects raw connector failures and checks timeout and authentication categorization; another checks the final replacement error plus release of all five uncommitted sessions.

Before the production fix, this exact focused command exited 1 with `replacement lost the CDP timeout reason: undefined`:

```bash
cd back-end && npx tsx -e "import {testConnectionErrorRetriesOnReplacement} from './src/tests/blackbox/steel-fingerprint.connection-retry.behavior'; testConnectionErrorRetriesOnReplacement().then(()=>console.log('PASS')).catch(e=>{console.error('FAIL',e.message);process.exitCode=1})"
```

The unchanged command exited 0 after the fix and logged five `Session validation failed ... Connection timeout` retries. The raw-connector regression also passed, including a 403 followed by a potential timeout; only the 403 was attempted. The full backend coverage run then passed all 167 blackbox domains, including the live browser parity domain. Its Steel session failed CDP validation during the provider outage, and the server's final replacement error explicitly retained `Connection timeout`; the narrow outage classifier accepted only that diagnosed case.

## Human feedback

None recorded.

## Reusable lesson

An outage classifier can stay narrow only if the provider boundary preserves the safe failure category that the classifier needs.
