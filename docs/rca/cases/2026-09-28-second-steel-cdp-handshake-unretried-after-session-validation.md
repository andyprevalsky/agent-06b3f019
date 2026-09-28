---
id: 2026-09-28-second-steel-cdp-handshake-unretried-after-session-validation
date: 2026-09-28
title: A second Steel CDP handshake timed out after rotation had committed
surface: back-end
component: steel-credential-injection
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/steel/injection.ts injectUserData opened a fresh CDP connection without transport retry after Steel replacement had validated and committed
symptoms:
  - 'FAIL live Kernel provider parity: /rotate-proxy 500'
  - 'browserType.connectOverCDP: Timeout 15000ms exceeded'
  - '<ws connecting> wss://connect.steel.dev/'
tags:
  - steel
  - browser-provider
  - cdp
  - credential-injection
  - proxy-rotation
sources:
  - PR #1312
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts Steel credential injection retries a CDP handshake timeout before state mutation
status: fixed
---

## Problem

Backend coverage finished 159/160 blackbox domains. The live `browser-provider`
domain proved Kernel baseline, residential rotation, mobile rotation, and the
first Steel switch, then received `/rotate-proxy 500` on the final Steel
rotation. The response contained `browserType.connectOverCDP: Timeout 15000ms
exceeded` while connecting to `wss://connect.steel.dev/`.

`back-end/coverage/server.log` records the precise request: the new Steel
session was created at 17:57:58 UTC, its CDP connection validated at 17:58:00,
navigation completed at 17:58:02, and the replacement was committed at
17:58:02. A fresh CDP connection for `injectUserData` started at 17:58:03,
timed out at 17:58:18, and the backend closed the replacement and returned 500.

## Diagnosis

The route calls `rotateBrowserProxy`, which creates and validates a replacement
through `recreateSession`, then calls `assembleResumeResponse`. That second step
always invokes `injectUserData`, which creates another CDP connection even when
there are no cookies or saved state, because it also applies browser setup.
The second connection was the first bad boundary. Unlike replacement validation,
it had no transport retry. A single transient CDP handshake timeout failed the
whole rotation after the provider session had already been committed.

The deepest owned gap was that the postvalidation connection boundary had no
retry contract or captured-timeout regression. The external reason for this one
handshake delay is not known; the observed cause under our control is the
single-shot connection. This is related to, but not a recurrence of,
`2026-07-22-steel-parity-harness-injected-key-at-wrong-boundary`: that case was
credential injection at the wrong seam, while this call used the right Steel
host and key path and timed out after a successful prior CDP connection.

This case uses `other` because the current taxonomy has no transient provider
transport bucket. The candidate bucket is **transient external transport fault
at an owned retry boundary**. There is no evidence that concurrent load caused
the timeout, and the fixture, credentials, and endpoint were valid: the same
session had just passed its first CDP handshake.

Archive searches: `browserType.connectOverCDP Timeout 15000ms exceeded wss
connect.steel.dev rotate-proxy`, `live Kernel provider parity rotate proxy Steel
session timeout browser provider`, and `Steel credential injection CDP handshake
timeout session replacement rotation`.

## Solution

`connectCredentialCdp` retries only transient Playwright CDP connection errors
before any browser state mutation, with at most three attempts and 50/100 ms
backoffs. Authentication errors and cancellation propagate on the first attempt.
Each session retries independently; there is no global provider lock or replay
of cookies, localStorage, or other state. The same boundary serves browser
resume and proxy rotation, so both receive the fix.

The first full backend coverage rerun found that 250/750 ms retry delays broke
the existing `steel-injection` blackbox, which requires a permanently stalled
CDP endpoint to fail within 500 ms when its connect timeout is configured to
75 ms. Shortening only the retry delays preserved three attempts while keeping
that bounded failure contract. The unchanged focused
`bash scripts/run-blackbox-tests.sh benchmarks,steel-injection` command then
passed both domains, including the stalled-endpoint case.

The checked-in `browser-provider` blackbox replays the captured timeout followed
by a successful connection, and rejects retries for 401 and cancellation. The
unchanged command `cd back-end && npx tsx
src/tests/blackbox/browser-provider.blackbox.ts` failed before the fix with the
captured timeout (exit 1), then passed after the fix (13 tests, exit 0). The
unchanged live command `cd back-end && ROSE_USE_SYSTEM_PG=true bash
scripts/run-blackbox-tests.sh browser-provider` then passed (14 tests,
including `PASS live Kernel provider parity`; domain runner 1/1, exit 0).
The rerun also captured a separate Steel CDP timeout in the exit-IP read;
that existing pre-mutation retry succeeded on its second attempt. This confirms
the same intermittent handshake behavior on a second connection site.

## Human feedback

None recorded.

## Reusable lesson

Retry transient CDP handshakes at the connection boundary before mutating browser state, especially when a validated provider session is connected again for credential injection.
