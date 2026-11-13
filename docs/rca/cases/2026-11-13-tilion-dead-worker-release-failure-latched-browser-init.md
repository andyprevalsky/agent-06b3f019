---
id: 2026-11-13-tilion-dead-worker-release-failure-latched-browser-init
date: 2026-11-13
title: Dead Tilion east worker (sess_993d70) failed CDP and DELETE; unconfirmed release skipped the retry create and latched the browser-init receipt so every worker retry failed
surface: back-end
component: tilion-browser-provider
classification: third-party-failure
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/tilion.ts createRemote threw on an unconfirmed release before its second create; back-end/src/providers/browser/initialization.ts initializeLogicalBrowser then marked the receipt FAILED for that untyped error
symptoms:
  - "Tilion session sess_993d70... failed validation and cleanup"
  - "Browser initialization failed before readiness"
  - "Browser session init failed after 5 transient-proxy retries"
  - "Tilion HTTP 503 on DELETE /v1/session/sess_993d70"
  - "browserType.connectOverCDP: WebSocket error: 503 Service Temporarily Unavailable"
tags:
  - tilion
  - browser-provider
  - session-init
  - smoke
  - retry
  - dead-worker
sources:
  - PR #1975 r7/r8 smoke (sess_993d70aa, sess_993d7010, sess_993d70a1, sess_993d707b, sess_993d7042)
  - PR #1981 r11, PR #2005 r2, PR #2008 smoke (2026-11-13 02:00-05:30Z)
  - task local probe east.back.tilion.dev 2026-11-13T05:16Z and 05:20Z (create X-Request-ID 4b75055ec1144521)
repro: back-end/src/tests/blackbox/browser-session-tilion-dead-worker.fixture.ts
status: fixed
---

## Problem

On 2026-11-13 from about 02:00Z, deploy smoke browser and payment tasks failed with
`Tilion session sess_993d70… failed validation and cleanup` (HTTP 500 from
`POST /api/browser-session/init`), then `Browser initialization failed before
readiness` on each of the worker's five "fresh-proxy" retries, then `Browser
session init failed after 5 transient-proxy retries`. The browser agent ended with
0 steps. Every failing session id began `sess_993d70`.

Runtime evidence (local, our real `createRemote` with
`TILION_BASE_URL=https://east.back.tilion.dev`): 2 of 6 creates landed on
`sess_993d70*`. CDP validation got `503 Service Temporarily Unavailable` from
`Server: awselb/2.0`, and DELETE got the same 503 four times. The other 4 landed on
`sess_c3d0eb*`/`sess_98241c*` and passed. A raw capture repeated this (4/15 east
creates dead; 11/11 others healthy). `back.tilion.dev` is AWS Global Accelerator:
Fly `iad` smoke guests and prod reach the east pool. The devbox reaches oregon
(`sess_c41189*`, `sess_a651ef*`), where 4/4 passed, which is why local probes had
looked clean.

Prod (Render, 2026-11-06..13): 0 `failed validation and cleanup`, 0 `before
readiness`. The last prod Tilion allocation was 2026-11-12 20:17Z, so prod had no
browser traffic during the outage. Prod uses the same east pool (`sess_993d70`
served prod normally on 11-06..08), so each new prod browser agent had about a 1/3
chance of landing on the dead worker on its first create.

## Diagnosis

1. Provider: Tilion's scheduler kept placing sessions on worker `993d70`, whose ALB
   target had no healthy backend. CDP, GET and DELETE all returned the ALB 503
   with no X-Request-ID.
2. Ours, adapter: `createRemote` already makes a second create after a CDP
   validation failure, but only when DELETE succeeded. On a dead worker DELETE
   never succeeds, so it threw `AggregateError(... failed validation and
cleanup)` without trying another worker.
3. Ours, init coalescer: `initializeLogicalBrowser` keeps the receipt only for
   typed definite rejections (rate limit, 4xx). Everything else is marked
   `FAILED` permanently, and the next `initSession` throws
   `Browser initialization failed before readiness` from
   `waitForBrowserInitialization`. The worker classified the 500 as transient and
   retried five times, but none of those retries could create a session.

Repro: `browser-session-tilion-dead-worker.fixture.ts` drives real `initSession`,
the receipt coalescer, the Tilion adapter, `tilionClient` HTTP and Playwright
`connectOverCDP` against a loopback replay of the captured ALB 503 bytes. On the
buggy revision, scenarios `dead-then-healthy` and `dead-dead-then-healthy` each
made 1 create and saw `failed validation and cleanup` plus 5× `before readiness`.

## Solution

- `tilion.ts` + `tilionCreateValidation.ts`: a CDP-validation failure moves on to
  the next create even when its release was unconfirmed (the id was already
  logged at allocation for exact cleanup). Once every create has failed
  validation and every allocated session is identified, it throws
  `BrowserSessionValidationError`. A create that returned no session id stays
  untyped and ambiguous.
- `initialization.ts`: `BrowserSessionValidationError` joins the definite
  rejections. Under the row lock, and only when no binding exists, the receipt is
  released so the worker's retry creates afresh. Ambiguous allocations stay
  latched, and the fixture's `unidentified-allocation` scenario asserts that.
- The regression runs from `runLogicalBrowserCases` in the `browser-session`
  blackbox domain (`--logical-browser-only`).
- 10k agents: no new shared state. Per failed create there is at most one extra
  provider create (bounded at 2 per init call) and one receipt delete on that
  agent's own row. Retries stay inside the worker's existing bounded loop.
- Not taken: pointing prod `TILION_BASE_URL` at oregon. The measured CDP p50 was
  75.7/77.3 ms east vs 13.9/15.0 ms oregon from the devbox, so prod's iad workers
  would pay about 62 ms more on every CDP round trip. Skipping workers by
  session-id prefix would be a string-matching classifier. Tilion support received
  the dead-worker evidence.

## Human feedback

None recorded.

## Reusable lesson

When a provider create fails validation, make the next create even if releasing the bad session is unconfirmed. Only latch the init receipt for allocations whose outcome is genuinely unknown, and probe Tilion from the region the failing runners use (east via Global Accelerator), not from the devbox.
