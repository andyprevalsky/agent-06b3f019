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


## 2026-10-13: credential setup reconnect after successful validation

A later PR #1473 deployment exposed a different connection boundary. Full
backend coverage passed 192 of 193 domains and all 266 unit files, but the
unchanged live browser-provider domain failed during rotation. A standalone
run also failed. Successful provider creation, CDP validation, navigation and
publication preceded an 18-second credential-setup reconnect timeout. The
coverage failure occurred on a Kernel rotation; the standalone failure occurred
on the Kernel-to-Steel switch. This was not the earlier missing error reason,
and the theory that Kernel validation leaked its handle was disproved: that
handle was already closed before credential injection requested another one.

The first bad boundary was discarding the validated connection before the
existing credential setup could borrow it. The existing initial-session path
already lends its validation connection to injection. Resume and rotation now
opt into the same transport handoff, with default behavior retained for direct
provider callers. Kernel, Steel and Browser Use retain the handle only until
the common response assembly owns it. That owner encloses the first database
lookup, navigation, fingerprint and credential preparation and closes in a
finally block on success or failure. Injection no longer prematurely closes a
borrowed handle on its two early errors. Failed provider handoffs close their
own transport, and uncommitted Steel replacement sessions retain their existing
release path. The Browser object is excluded by the explicit HTTP response map.

The existing steel-fingerprint owning suite reproduces both unwanted reconnect
and premature borrower closure on the original code. The unchanged assertions
pass on the fix, alongside CAS loss, lookup failure, cookie-selection race and
nonfatal publication/release cases: 13 cases pass in the actual checkout. The
unchanged live browser-provider command then passes in 122.168 seconds, with
ten validated-connection reuse observations and no 18-second credential
reconnect timeout. An independent review verified exact patch readback, cleanup
ownership and zero P2 overlap. Full backend coverage remains a separate required
gate; this focused result is not its substitute.

At 10,000 agents this retains one already-open per-request connection through
bounded setup instead of opening another. Ownership remains local to that
request, with no shared mutable state, additional provider allocation, fan-in
or polling. Existing timeouts, retry limits, models, schemas, LLM text and
benchmark assertions are unchanged.
