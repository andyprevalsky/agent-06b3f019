---
id: 2026-08-16-payment-cdn-ok-beats-avoid-when-unique
date: 2026-08-16
title: avoidConfigKey beat unique paymentCdnOk=true (steel Stripe.js) and promoted Kernel
surface: back-end
component: browser-challenge-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/browser/challengeRecovery.ts::candidateScore — isAvoided ranked before paymentCdnOk
symptoms:
  - 'Challenge recovery promoting stable winner configKey=kernel_isp'
  - 'requirePaymentCdn=false avoidConfigKey=steel_managed'
  - 'Critical resource block ignored: provider-exit cap reached'
  - 'Expected payment_approval attention request (to ignore) but none was triggered'
  - 'js.stripe.com/v3 blocked by proxy; window.Stripe undefined'
tags:
  - browser-agent
  - eventim
  - antibot
  - challenge-recovery
  - payment-cdn
  - steel
sources:
  - agent f1ba73c2-8387-4571-9912-b17f22816a64
  - agent 0c2c66d9-1932-44b7-8f9a-4fd1ea81754d
  - commit 1b3a0448d
repro: cd back-end && npx tsx src/tests/unit/browser-challenge-recovery-payment.test.ts
status: fixed
---

## Problem

Deploy gate for `browser-1015-eventim-request-card` requires **k=4 parallel**
passes. Serial reliability check: run 1 PASS (`0c2c66d9`, steel_managed →
payment_approval); run 2 FAIL (`f1ba73c2`, 945s, cost limit) with
`Expected payment_approval attention request (to ignore) but none was triggered`.

Backend promotion log at 22:58:59Z (identical matrix later at 23:03:19Z):

```
promoting ... configKey=kernel_isp ... paymentCdnOk=false ... stripe.js:false
  requirePaymentCdn=false avoidConfigKey=steel_managed
```

while the same search probed:

```
steel_managed ... paymentCdnOk=true ... stripe.js:true latencyMs=12380
kernel_isp ... paymentCdnOk=false ... stripe.js:false latencyMs=6518
```

Live tab verified CF-clean on Kernel; Stripe.js never initialized; provider-exit
cap then ignored further `js.stripe.com` blocks; agent burned cost without
`request_payment_card`.

## Diagnosis

Critical path:
`spawn_browser_agent_v3` → Eventim checkout → CF challenge →
`recover_from_challenge` → `POST recover-challenge` →
`runParallelBrowserConfigSearch` → `candidateScore(…, avoidConfigKey=steel_managed)`
→ promote `kernel_isp` → CF-only live verify passes → Stripe undefined at
payment → cost limit / no `payment_approval`.

Binary search on backend.log for `f1ba73c2`:

1. First recovery (no avoid) correctly promoted `steel_managed` (`paymentCdnOk=true`).
2. Second recovery set `avoidConfigKey=steel_managed` after CF re-challenge on that exit.
3. Soft payment-CDN ranking never applied: `candidateScore` puts `isAvoided`
   **before** `paymentCdnOk`, so Kernel wins despite being the only CF-stable
   candidates with `stripe.js=false`.
4. A later Stripe-triggered recovery did promote steel once (blocked-resource
   verify); a subsequent CF recovery with `avoid=steel` again promoted Kernel.
5. `Critical resource block ignored: provider-exit cap reached` stranded checkout.

Owning boundary: `candidateScore` order
`stablePasses → isAvoided → paymentCdnOk → …`.

Relatives (not closed by citing alone):
- `2026-08-10-eventim-avoid-config-beats-partial-stripe` — correctly made avoid
  beat **partial** host clears when both `paymentCdnOk=false`; over-applies when
  the avoided key uniquely has `paymentCdnOk=true` (stripe.js script load).
- `2026-08-11-eventim-recovery-requires-stripe-js` — soft ranking + failure-driven
  live verify; soft rank is ineffective when avoid sits above `paymentCdnOk`.

## Solution

Hard failure-driven filter (no soft payment-CDN ranking):

1. `blocked_resource_url` / sticky `require_payment_cdn` on recover-challenge →
   `requirePaymentCdn` hard filter (only `paymentCdnOk` survivors).
2. Agent sticky: once a payment-CDN block is seen on the task, later CF recoveries
   keep `require_payment_cdn=true`.
3. `candidateScore` is CF-stable → avoid → latency only.

Cemented by unit + challenge-recovery blackbox. Deploy gate: parallel k=4
`scripts/run-bench --local browser-1015-eventim-request-card`.

## k=4 evidence (in progress)

- Hard filter + CF probe retry: promotes `steel_managed` with `requirePaymentCdn=true`
  even when `avoidConfigKey=steel_managed` (attempt6 run2 @ 03:43:56Z / 03:47:38Z).
- Attempt6 parallel: **2/4 PASS** (runs 1+3); runs 2+4 timed out at 900s without
  `payment_approval` after repeated Steel re-promotes under full 6-candidate probes.
- Follow-up: `recoverySearchPlan` focuses Steel-only first when `requirePaymentCdn`
  (cuts concurrent Kernel probes that never clear Stripe.js) and clears avoid under
  the payment-CDN hard filter.

## Human feedback

Deploy-ready requires this task to pass at **k=4 in parallel** (not serial).
Rejected soft priority reorder (“either the config works or it doesn’t”).
Approved hard-filter fix if it fixes the issue.

## Reusable lesson

Challenge recovery selects among configs that hard-pass the failure that triggered
them; never soft-rank optional capabilities, and never avoid a config that is the
only survivor of that hard filter.
