---
id: 2026-10-02-steel-startup-failure-hidden-behind-cdp-validation-retries
date: 2026-10-02
title: Steel's startup_failed verdict was discarded behind CDP validation retries, so a Steel outage failed the live parity gate as an opaque rotation error
surface: back-end
component: steel-session-validation
classification: third-party-failure
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/steel/sessionConnection.ts connectValidatedBrowser — returned null on failure, dropping both the CDP error and Steel's own session status
symptoms:
  - 'Failed to create Steel replacement after 5 attempts: Session validation failed on attempt 5'
  - 'FAIL live Kernel provider parity: /rotate-proxy 500'
  - 'browserType.connectOverCDP: WebSocket error: wss://connect.steel.dev/ 404 Not Found'
  - 'Steel session validation: attempt 2/3 failed, retrying in 400ms error=Connection timeout'
  - releaseReason startup_failed
tags:
  - steel
  - browser-provider
  - cdp
  - rotate-proxy
  - provider-outage
  - deploy-gate
sources:
  - PR #1354
repro: back-end/src/tests/unit/steel-session-startup-failure.test.ts
status: fixed
---

## Problem

The `/deploy` backend coverage lane failed one domain, `browser-provider`, with
`FAIL live Kernel provider parity: /rotate-proxy 500: {"error":"Failed to create
Steel replacement after 5 attempts: Session validation failed on attempt 5"}`
after 631s. The backend Steel code was byte-identical to the revision that had
passed 167/167 an hour earlier, and a standalone rerun of the domain reproduced
the failure.

Every replacement session Steel created logged three
`Steel session validation ... error=Connection timeout` retries, sometimes
followed by `wss://connect.steel.dev/ 404 Not Found`. Kernel sessions in the same
run connected normally.

## Diagnosis

- Steel's API showed every failed session as `status: failed`,
  `releaseReason: startup_failed`, `proxyBytesUsed: 0`, about 5s after creation.
  The browser never booted on Steel's side.
- A create matrix isolated the trigger. All of these failed with
  `startup_failed`: our exact replacement options, the pre-branch 15-minute
  timeout, no proxy, no captcha solver, no persisted profile, and a bare
  `sessions.create({})`. `iad` is Steel's only accepting region (`lax` and `ord`
  return "deprecated"), and the account had 0 live sessions. So this was a Steel
  outage, not this branch's lifetime change and not account capacity.
- Owned cause: `connectValidatedBrowser` returned `null` on failure, and its
  callers threw a bare `Session validation failed on attempt N`. That dropped
  both the CDP error and Steel's verdict. Validation also kept dialing CDP for
  all three 10s attempts against a session Steel had already declared dead, so
  each replacement attempt cost about 32s and each `/rotate-proxy` call about
  160s.
- The live parity gate already skips the Steel legs, loudly, on a genuine Steel
  outage. Its classifier needs to see the cause, and production never sent one.
  The contract between production's error and the gate's outage detection was
  inconsistent.

## Solution

- `validateBrowserConnection` (`sessionConnection.ts`) returns
  `{ browser, failure }`. Before each retry it calls an optional
  `startupProbe`. `steelStartupProbe` reads the Steel session and reports
  `Steel reported session <id> failed (<releaseReason>)` once Steel marks it
  `failed`, which stops the remaining connect attempts. Both Steel create sites
  (`createSessionWithContext` and `recreateSession`) append the failure to
  `Session validation failed on attempt N: <reason>`. The per-attempt connect
  timer is now cleared, so a fast failure no longer leaves a 10s timer pending.
- The parity gate no longer counts a validation failure as an outage based on
  the message alone, because our own create options could also stop Steel from
  booting. `shouldSkipSteelLegs` creates a session with only Steel's defaults
  (`steelDefaultSessionBoots`). It skips the Steel legs only when that control
  also fails to boot; if the control boots, the gate fails.
- Repro: the unit test covers the stop-early validation, the probe, and the
  control-gated skip. On the old revision the live domain failed in 631s with
  the opaque message. On the fix the same outage is reported as `startup_failed`
  and the control session confirms it.

10k agents: no change on the happy path, because the probe only runs before a
retry. During a Steel outage each failed attempt makes one extra Steel GET and
holds the request about 12s instead of 32s, so concurrent rotate and resume calls
hold connections about 60% less time.

## Human feedback

None recorded. Found while running the user-requested `/deploy` for PR #1354.

## Reusable lesson

When a provider reports a terminal state for a resource, read it before retrying
and carry it into the error. A gate cannot tell an outage from a defect by
looking at a cause that was thrown away.
