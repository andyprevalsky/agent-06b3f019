---
id: 2026-11-15-tilion-capacity-retries-exhausted-keyed-create-latched-browser-init
date: 2026-11-15
title: Tilion capacity_unavailable retries used up the keyed create's 3 attempts, so a final 15 s timeout latched the browser-init receipt for the whole task
surface: back-end
component: tilion-browser-provider
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/tilionClient.ts tilionRequestWithMeta gave POST /v1/session one 3-attempt budget shared by definite capacity rejections and lost-reply settling, and typed 503 capacity_unavailable as an untyped 5xx; initializeLogicalBrowser then marked the receipt FAILED
symptoms:
  - "Tilion HTTP 503 capacity_unavailable on POST /v1/session: no session capacity in this region right now; please retry"
  - "Tilion POST /v1/session timed out after 15000ms"
  - "Browser initialization failed before readiness"
  - "Tilion HTTP 409 idempotency_key_in_use on POST /v1/session"
tags:
  - tilion
  - browser-provider
  - session-init
  - smoke
  - retry
  - capacity
  - idempotency
sources:
  - PR #2110 round-1 smoke, source 091ab4e0e4ef, task agent-payment-test-shop (FLAKY 21815f3c), root agent cf2f2f5d-6054-4f1f-bf17-37399f231f2f, browser task 5da61f13, 2026-11-15T02:42:43-02:43:24Z
  - PR #2005 smoke, source 47eeada6ba51 (pre-fix), task agent-payment-test-shop FLAKY 1c280e1e, run 20261115-025606-917426, 2026-11-15T03:06:54-03:21:00Z
  - PR #2125 smoke, 4 recovered capacity_unavailable creates (2026-11-15 parallel deploy wave)
  - PR #2154 (fix, merged e21c7633a9)
  - commit 5cc808dfa5 (agent-payment-test-shop quarantine marker, repair pending-handoff:21815f3c6d454cecacbf0c74d5e7ee28)
repro: back-end/src/tests/blackbox/browser-session-tilion-dead-worker.fixture.ts
status: fixed
---

## Problem

During the 2026-11-15 parallel deploy wave, Tilion answered `POST /v1/session` with
`503 capacity_unavailable` (`Retry-After: 5`, each answer after about 5 s). PR #2125's
smoke saw it 4 times, and each recovered on a retry. In PR #2110's round-1 smoke,
`agent-payment-test-shop` failed instead (FLAKY 21815f3c). The guest `backend.log`
showed this sequence for one `POST /api/browser-session/init`:

| Time (Z) | Line |
|---|---|
| 02:42:49.251 | `POST /v1/session status=503 durationMs=5143 attempt=1`, then `attempt 1/3 failed, retrying in 5034ms … capacity_unavailable` |
| 02:42:59.321 | `status=503 durationMs=5035 attempt=2`, then `attempt 2/3 failed, retrying in 5034ms` |
| 02:43:19.358 | `Tilion request failed before a response … attempt=3 durationMs=15001 … timed out after 15000ms` |
| 02:43:19.361 | `Failed to init browser session error=TilionTimeoutError`, then init returned 500 after 35428 ms |
| 02:43:24.410 | first `Browser initialization failed before readiness` (134 in total, until the 900 s task timeout) |

A second occurrence, PR #2005's smoke (FLAKY 1c280e1e, source 47eeada6ba51, which
predates the fix), took the capacity-only path. `POST /v1/session` returned
`503 capacity_unavailable` on all 3 attempts (03:06:54–03:07:14Z, X-Request-ID
410dc09367824994). The untyped `TilionApiError` latched the receipt for task 6cfe8669,
and `Browser initialization failed before readiness` followed 29 times until 03:21:00Z.
The regression scenario `capacity-exhausted-then-healthy` replays that sequence.

## Diagnosis

1. Two capacity rejections used 2 of the client's 3 attempts (`DEFAULT_MAX_ATTEMPTS`)
   for the keyed create. The third attempt's reply was lost, and the 15 s timeout ended
   the call with `TilionTimeoutError`.
2. A timeout on a create is ambiguous, because Tilion may have started a browser.
   `initializeLogicalBrowser` therefore marked the receipt `FAILED`, as designed. Every
   later worker init got `before readiness`. This is the path the 2026-11-13
   dead-worker case listed as still open ("a create call that fails outright … still
   latches").
3. Why was this possible? The create sends an `Idempotency-Key`, and Tilion documents a
   same-key retry as safe: a replay answers 201 with the same session, or 409
   `idempotency_key_in_use` while the first create is still running. The timeout was
   therefore resolvable by another same-key attempt. The client had none left, because
   definite "no capacity" rejections spent the same budget.
4. A second rung: `503 capacity_unavailable` was typed as a plain `TilionApiError`
   (5xx). When capacity lasted through all 3 attempts, init latched as well, even
   though Tilion allocated nothing.
5. A same-class site: a same-key retry that got 409 `idempotency_key_in_use` was not
   retried. It surfaced as a 4xx, and `nativeRequestRejected` reads any 4xx as
   "allocated nothing", so the receipt was released. The worker then relaunched under a
   new key while the first create could still produce a browser. The repro showed 5
   keys for one logical init on main.

Local repro: the identical command below. On main 96419e3060's `tilion.ts` and
`tilionClient.ts`, with only the `TILION_SESSION_CREATE_MAX_ATTEMPTS` export added so
that the fixture compiles, it exits 1:

- `capacity-then-lost-replies-replayed`: 3 POSTs (capacity, capacity, hang), then
  `timed out after 15000ms` and `before readiness` ×4. This is the smoke signature.
- `capacity-exhausted-then-healthy`: 3 capacity answers, then `before readiness` ×4.
- `unsettled-keyed-create-stays-latched`: 5 Idempotency-Keys, so the ambiguous
  allocation was relaunched.
- `capacity-after-lost-reply-stays-latched` fails only on its POST count. Main latches
  after 3 POSTs. This scenario is the negative control that keeps a fix from
  over-releasing.

After the fix, the same command exits 0.

An independent adversarial review named the same first bad boundary:
`tilionRequestWithMeta`'s shared 3-attempt budget for the keyed create. It rejected a
first draft of this fix. That draft used one 45 s deadline, and a final capacity
answer after a lost reply would have released the receipt. The fix now tracks
unsettled attempts per call, and the fixture models a replay that is also lost.

`cd back-end && node --experimental-test-module-mocks --import tsx src/tests/blackbox/browser-session-tilion-dead-worker.fixture.ts`
(with `CONDUCTOR_WORKSPACE_NAME` and the local `victoria` database)

Archive searches: `capacity_unavailable Tilion create timeout latched browser init`,
`idempotency_key_in_use keyed create relaunch receipt released`, and a literal grep for
`capacity_unavailable|idempotency_key_in_use` in docs/rca/cases/ (no hits). The incident
is a relative of 2026-11-13-tilion-dead-worker-release-failure-latched-browser-init.
That case's lesson applies: latch only allocations whose outcome is genuinely unknown.
This case narrows "unknown" with the documented idempotency contract.

## Solution

The fix is backend only, at the Tilion client boundary (`tilionClient.ts`):

- `tilionErrorFromResponse` types `503 capacity_unavailable` as `TilionRateLimitError`,
  the provider-neutral `BrowserProviderRateLimitError`, and keeps its real `status`
  (503). Tilion documents this answer as "no capacity, nothing started", so
  `initializeLogicalBrowser` releases the receipt. The init and resume routes answer
  429, and the worker's existing "waiting for browser availability" loop retries.
- `postTilionSession` sends the keyed create through `retryWithBackoff`, with up to 8
  attempts under one Idempotency-Key. Retries continue in two windows:
  - within 45 s while every answer so far was a definite rejection;
  - within 90 s once any attempt is unsettled (a timeout, a network error, or 409
    `idempotency_key_in_use`).

  With the 15 s request timeout, one call ends within about 105 s. Capacity backoffs no
  longer use up the attempts that settle a lost reply. A lost reply is settled by
  replaying its key, never by a relaunch.
- Once an attempt is unsettled, no later answer is proof that nothing was allocated.
  If the call then ends, it ends untyped (`… is unsettled and may own a browser`), and
  the receipt stays latched. This holds for a final capacity rejection or 4xx too.
  Before this change, a final 409 was released as a 4xx.

Regression: the dead-worker fixture, run by the `backend-blackbox` `browser-session`
domain through `runLogicalBrowserCases`, adds four scenarios:

- `capacity-then-lost-replies-replayed`: capacity ×2, then two lost replies (the
  production 15 s hangs), 409, then a replay. It binds the one session under one key.
- `capacity-exhausted-then-healthy`: a typed release, then the worker's fresh create
  succeeds.
- Two negative controls, `unsettled-keyed-create-stays-latched` (a lost reply, then 409
  ×7) and `capacity-after-lost-reply-stays-latched` (a lost reply, then capacity ×7).
  Each stays latched under exactly one key, so an overbroad release fails them.

`tilion-client.test.ts` asserts the capacity typing, a same-key capacity retry, and an
untyped outcome after an in-flight 409.

Shipped in PR #2154 (merge e21c7633a9, 2026-11-15). Deploy gates 17/17 passed on
dc11332ecb48. That smoke run included `agent-payment-test-shop`, which passed with no
capacity rejection in its logs, so the live run did not exercise this path. The local
fixture is the recovery proof. Production lanes passed: Render (verified by the live
descendant 6e2977bc0), backend probes, and production semantics. CodeRabbit was at its
organization spending cap, so the PR merged unreviewed after the adversarial RCA review.
The `agent-payment-test-shop` marker from PR #2110 (5cc808dfa5) is released by its
5-pass streak.

Residuals, which are not part of this fix:

- A create whose replays stay unanswered for the whole 90 s window still latches the
  receipt, by design. The worker then spends the task budget on `before readiness`
  retries: any 5xx counts as transient in `agents/domains/spawn_browser_agent_v3/repo.py`.
  The receipt does not store the Idempotency-Key, so a later init cannot replay it.
  Storing the key, or failing fast on a FAILED receipt, would close this path. It
  changes initialization semantics and needs its own change.
- A validation-failed first create plus a second create can run past the worker's 180 s
  init request. The route's disconnect path then releases the created session.
- `providers/browser/index.ts` (the preferred-config fallback) still swallows any failed
  preferred Tilion create, including an ambiguous one, and allocates on the default
  provider. This predates the change and is off the incident path.

At 10k agents: the change adds no shared state. Each logical create sends at most 8
requests and finishes within about 105 s. During a capacity outage, every agent paces
on Tilion's `Retry-After` (5 s), then waits through the worker's existing rate-limit
loop.

## Human feedback

None recorded.

## Reusable lesson

A keyed create's retry budget must not be shared between definite rejections and
lost-reply settling. Type every documented "nothing allocated" answer, including 503
capacity, as a rejection. Keep 409 "still running" ambiguous.
