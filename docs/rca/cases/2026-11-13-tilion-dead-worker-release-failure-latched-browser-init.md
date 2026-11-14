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

The worker was out of rotation from about 05:46Z (0 of 28 east creates landed on
it) and came back by 06:14Z, so the failure is intermittent.

Prod impact, from ClickHouse prod worker logs (7-day retention) and Render backend logs:

- One production occurrence. At 2026-11-13T08:26:57Z root agent
  `83aef77e-ece7-598e-8837-dbbfe61678e8` got `sess_993d70b737a1…`, and Render logged
  `failed validation and cleanup`. Both of its browser spawns then failed all 10
  init calls with `Browser initialization failed before readiness`: 9 Render lines
  at 08:27:03–08:28:00Z, matching ClickHouse's 10 worker init attempts. The agent
  is PAUSED and its init receipt is still FAILED; releasing it waits on the owner.
- No other prod agent was affected in the retention window. Render logged exactly
  one `failed validation and cleanup` from 2026-11-06 to 2026-11-13.
- Prod made no Tilion allocations during the reported smoke failure window
  (04:34–04:58Z) on 11-13. Across 11-06..13 that window had one allocation (11-10)
  and no failures.
- Prod uses the same east pool, so each new browser agent was exposed until the fix.
  On 11-13 prod made one Tilion allocation before the fix (Render live 08:49Z), at
  08:26:54Z, and it landed on the dead worker. The only one after was 08:50:50Z, healthy.
- After the fix there were 0 failures. A 09:16Z probe of main against east created
  10 of 10 sessions; 5 landed on `sess_993d70` and all 5 recovered.

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

Exact task outcome (`scripts/run-bench --local browser-smoke`, unchanged task). The live
worker had been drained, so a local forwarder (an experiment script, not committed)
answered the first 4 creates the way the dead worker did. Each create was forwarded
to east and the real session released at once; the response was re-pointed at a
loopback plane returning the captured ALB 503 to CDP/GET/DELETE. Every other call
went to real east. With the same environment on both revisions:

- Buggy `fe09db83d`: FAIL in 399.9 s. Agent `d980de40-a5ed-48c7-932a-14d44b0179c3`:
  `Browser agent b1912235-… recorded 0 trajectory step(s)`, 1 create, then
  `Browser initialization failed before readiness` on every retry.
- Fixed `2f201dbe23`: PASS in 233.5 s. Agent `3f3f9e2f-8772-4510-948c-2eaaf226cb5b`:
  creates #1–#4 dead, #5 healthy within one browser agent.

The stacks were torn down after the runs, so the FE links could not be re-opened;
the run records are kept with the case evidence.

Resume path (PR #2010 round-1 smoke, `agent-payment-setup-resume`, agent
`172807c8-…`). The init fix recovered live at 06:15:02Z (`creating another` →
`sess_c3d0eb`). At 06:16:41Z the write-lock resume asked for a replacement session,
and both adapter creates landed on `sess_993d70`. The error was
`BrowserSessionValidationError … failed validation and cleanup` →
`Failed to resume session`. Resume replacements have no outer retry, so the agent
redid the purchase and raised the extra `write_lock` at 06:17:47Z that failed the
task. With the replacement bound forced back to 2, the fixture's `resume-dead-dead-then-healthy`
scenario reproduces this exact error; with 4 it passes.

## Solution

- `tilion.ts` + `tilionCreateValidation.ts`: a CDP-validation failure moves on to
  the next create even when its release was unconfirmed (the id was already
  logged at allocation for exact cleanup). Once every create has failed
  validation and every allocated session is identified, it throws
  `BrowserSessionValidationError`. A create that returned no session id stays
  untyped and ambiguous.
- `tilionCreateValidation.ts` sets the create budget per path. New task sessions
  keep `TILION_TASK_CREATE_ATTEMPTS = 2`, because the worker's init loop (5 calls)
  already retries them. Resume/rotation replacements and challenge recovery have no
  outer retry and get `TILION_REPLACEMENT_CREATE_ATTEMPTS = 4`: with one dead
  worker of three, about 1 in 81 calls fail instead of 1 in 9.
- A create that returns a session id but no `connect_url` (a key without raw CDP)
  is a permanent misconfiguration. It is released and fails at once with no second
  create, and the init receipt stays latched (fixture scenario `no-connect-url`).
- The golden-reference review of the first bound (4 on every path) came back
  MIXED: grounded for paths without an outer retry, too broad for init, and it
  retried a permanent error. Those three findings shaped this split.
- `initialization.ts`: `BrowserSessionValidationError` joins the definite
  rejections. Under the row lock, and only when no binding exists, the receipt is
  released so the worker's retry creates afresh. Ambiguous allocations stay
  latched, and the fixture's `unidentified-allocation` scenario asserts that.
- The regression runs from `runLogicalBrowserCases` in the `browser-session`
  blackbox domain (`--logical-browser-only`).
- 10k agents: no new shared state. Work stays per agent: one receipt delete on
  that agent's own row per typed failure.
- Worst-case creates when every create fails validation:
  - Init: 5 worker calls × up to 2 Tilion configs (a learned preference, then the
    default; `providers/browser/index.ts`) × 2 creates = 20. Before this change,
    one call made up to 4 creates and then the receipt latched.
  - Root browser: 2.
  - One resume or rotation: 4.
  - One challenge recovery or compute-grant CDP session (both use the recovery
    create): 4.
- Each failed create may leave an unreleased Tilion session that counts against
  the shared account until its idle timeout (3600 s). Because the orphan reaper only
  sees sessions with rows, a full Tilion outage can use account slots about five
  times faster per failing init than before. A durable record of unconfirmed
  releases is a follow-up.
- Not taken: pointing prod `TILION_BASE_URL` at oregon. The measured CDP p50 was
  75.7/77.3 ms east vs 13.9/15.0 ms oregon from the devbox, so prod's iad workers
  would pay about 62 ms more on every CDP round trip. Skipping workers by
  session-id prefix would be a string-matching classifier. Tilion support received
  the dead-worker evidence.

## Related benchmark outcome

`agent-payment-setup-resume` (FLAKY occurrence `9a4a72a77dab428bb30648ea04b25e6a`,
quarantined by `dd4b27a38`) shared this cause. In the PR #1972 smoke on `f93b9ad17f`,
agent `49ff2c32` ended `Timeout after 901s (task timeout=900s)` with the agent still
`ACTIVE`. Every one of its five browser agents (04:13–04:18Z) died with `Browser
session init failed after 5 transient-proxy retries: Browser initialization failed
before readiness`, and the root then retried and diagnosed until the cap.
`agent-payment-idempotent-abandonment` (`9a3babcc`) and `agent-payment-abandonment`
(`8d781844`) in the same round show the same signature (225 and 221
`before readiness` hits, respectively). Across the prod Hub, the setup-resume and
idempotent-abandonment failures cluster from 2026-11-13T00Z (0–1 per hour on
11-12, 3–10 per hour on 11-13 01–05Z).

Exact command `bash scripts/run-bench agent-payment-setup-resume --runs 1
--concurrency 1 --retry-infra 0 --ref <sha>`:

- Buggy main `5fecafd337` (fleet run `20261113-064551-4062264`, agent `21c99d70`):
  PASS but 530.7 s. The guest hit `sess_993d70` and logged `Failed to resume session`
  five times, then the root recovered checkout through a new browser agent. That is
  the same mechanism without crossing 900 s; the 2026-11-13 Hub sample of 510 runs had
  a p50 of 202 s.
- Fixed main `7d3fc34cac` (`--runs 5`, campaign `campaign-20261113-084219-1260968`):
  5/5 PASS in 249.0, 217.4, 224.9, 311.2 and 232.1 s, with cleanup verified on
  every fleet. Three of the five runs hit `sess_993d70`. In run
  `20261113-084241-1265574` (agent `b8d3f38c`), `POST /api/browser-session/resume`
  created on the dead worker twice (`failed validation; creating another
  released=false`), placed the third create on `sess_c3d0eb`, and returned 200 in
  36.4 s. A second resume did the same in 21.2 s.
- An east probe at 2026-11-13T09:05Z still placed 2 of 9 direct creates on
  `sess_993d70`: GET and DELETE returned 503 from `awselb/2.0`. The worker remained
  in rotation while the fixed runs passed.

### PR #2015 smoke occurrences (test repair, 2026-11-13)

The PR #2015 deploy smoke ran source `43a856b49`, which does not contain #2010. Both
failures there had this cause:

- `agent-payment-test-shop` (FLAKY `c59d68b1`, agent `23abff70`): at 08:53:37Z
  `Failed to resume session: Tilion session sess_993d7086… failed validation and cleanup`.
  The recovery browser then ran out the 900 s budget.
- `browser-smoke` (FAIL `19847867`, agent `2f7dbbee`): all three browser agents hit
  `Browser session init failed after 5 transient-proxy retries … before readiness`.

The test-shop resume failures in Hub group `deploy-018530dd` (09:24Z and 10:01Z) also
ran a source without #2010 (PR #2014 at `b6ed04d2d`).

An east probe at 12:22Z still placed 3 of 12 creates on `sess_993d70`, with GET and
DELETE returning 503 from `awselb/2.0`. On main `7f41708cd`, campaign
`campaign-20261113-122039-4162732` ran `browser-smoke` 3 times and all 3 passed, with
cleanup verified. Run `20261113-122112-4168998` landed on `sess_993d708272a5`, logged
`failed validation; creating another released=false` and recovered.

Hub group `deploy-8fe5aed…` failed `browser-smoke` with `before readiness` at 10:16Z
and again in its 11:35Z rerun. That group cannot be attributed: it has no source SHA,
it has no factory-ledger rows, and it was frozen before 10:43Z. Every attributable
source that contains #2010 passed `browser-smoke`. From 12:00Z the Hub shows no
`before readiness` or `failed validation and cleanup` failures.

## Human feedback

None recorded.

## Reusable lesson

When a provider create fails validation, make the next create even if releasing the bad session is unconfirmed. Only latch the init receipt for allocations whose outcome is genuinely unknown, and probe Tilion from the region the failing runners use (east via Global Accelerator), not from the devbox.
