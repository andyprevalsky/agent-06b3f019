---
id: 2026-08-10-eventim-avoid-config-beats-partial-stripe
date: 2026-08-10
title: Eventim recover-challenge re-promoted avoidConfigKey=steel_managed on js.stripe.com-only probe
surface: back-end
component: browser-challenge-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/challengeRecovery.ts::candidateScore — avoidConfigKey ranked after partial paymentHostsOkCount
symptoms:
  - 'Challenge recovery will deprioritize current failing exit ... avoidConfigKey=steel_managed'
  - 'Challenge recovery promoting stable winner configKey=steel_managed ... avoidConfigKey=steel_managed paymentCdnHosts={"js.stripe.com":true,"api.stripe.com":false}'
  - 'Promoted steel_managed passed candidate probes but the live tab is still challenged'
  - customer-api.eventim.us net::ERR_FAILED
  - browser-1015-eventim-request-card Timeout after 1200s; Expected payment_approval
tags:
  - browser-agent
  - eventim
  - antibot
  - challenge-recovery
  - steel
  - payment-cdn
sources:
  - agent 48ef13f0-e777-4293-96bb-ae9ddfa0716d
  - commit 817c9195499a491f531cfa459f7e8356be34dba0
repro: cd back-end && npx tsx src/tests/unit/browser-challenge-recovery.test.ts
status: fixed
---

## Problem

Descend slice `browser-1015-eventim-request-card` (run
`eventim-20260810T172431Z`, agent `48ef13f0-e777-4293-96bb-ae9ddfa0716d`)
timed out at 1200s with `approvals_triggered=0` and no `payment_approval`.

Guest checkout reached Eventim payment surfaces, but `customer-api.eventim.us`
XHRs failed with `net::ERR_FAILED` while document GETs looked clean. Staged
`recover_from_challenge` correctly set `avoidConfigKey=steel_managed`, then
immediately re-promoted `steel_managed` because the candidate score preferred a
partial Stripe host clear (`js.stripe.com:true`, `api.stripe.com:false`) over
the avoid penalty. Live-tab verify then reported the tab still challenged.

Related prior art:
`docs/rca/cases/2026-08-05-eventim-cloudflare-recovery-exhaustion-false-stable.md`
(false-stable Steel promotions). This case is a distinct scoring-order bug in
`candidateScore`, not a live-tab verify gap.

## Diagnosis

Critical path:
`spawn_browser_agent_v3` → Eventim checkout → challenge / customer-api failure →
`recover_from_challenge` → `POST /api/browser-session/recover-challenge` →
`searchAndPromoteBrowserConfig` → `runParallelBrowserConfigSearch` →
`candidateScore(…, avoidConfigKey)` → promote winner → live tab still broken.

Binary search on backend logs for the 17:36Z recovery:

1. `avoidConfigKey=steel_managed` was set from the live Steel managed session.
2. Every Kernel candidate probed `paymentCdnOk=false` with both Stripe hosts false.
3. `steel_managed` probed `paymentCdnOk=false` but `js.stripe.com:true`.
4. Promotion chose `steel_managed` despite avoid.

Owning boundary: `candidateScore` ordered
`paymentHostsOkCount` **before** the avoid penalty, so a one-host Stripe probe
beat “leave this failing exit.” The Steel-managed rotation bias also still
boosted the avoided key.

## Solution

Reorder `candidateScore` so `isAvoided` is evaluated immediately after
CF-stable passes, before payment-CDN / partial-host tiers. Disable the
Steel-managed bias when the candidate itself is the avoided key.

Cemented by
`testAvoidConfigKeyBeatsPartialPaymentHostClear` in
`back-end/src/tests/unit/browser-challenge-recovery.test.ts`, using the exact
Eventim probe matrix from the failing run.

## Local proof

```bash
cd back-end && npx tsx src/tests/unit/browser-challenge-recovery.test.ts
```

- **Before fix:** `AssertionError` — winner `steel_managed` with
  `avoidConfigKey=steel_managed` (promotion log matched prod).
- **After fix:** `PASS staged browser challenge recovery`; same matrix promotes
  `kernel_isp`.

Benchmark outcome proof remains pending Andy's HARNESS_FIX_DECISION + exact
`scripts/run-bench --local browser-1015-eventim-request-card` rerun.

## Human feedback

None recorded.

## Reusable lesson

Rank `avoidConfigKey` ahead of partial payment-host clears in `candidateScore` so a one-host Stripe probe cannot re-promote the failing exit.
