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

(Proposed — awaiting approval; soft-rank reorder rejected.)

Configs are binary: they pass the hard requirements for **this** recovery or they
do not. No soft payment-CDN preference in `candidateScore`.

1. **Hard filter from the failure that triggered recovery**
   - CF-only / no blocked URL → require CF-stable only.
   - Blocked third-party / payment CDN URL (e.g. `js.stripe.com`) → require that
     resource clears (`paymentCdnOk` / URL probe). Wire
     `blocked_resource_url` into `recover-challenge` so
     `requirePaymentCdn` (or equivalent) is set true when the exit was a
     payment-CDN block — not from `/cart` URL heuristics.
   - Sticky on the task: once a payment-CDN block was observed, later config
     searches on that task keep the hard payment-CDN filter so a CF re-challenge
     cannot promote a Kernel that already failed Stripe.js.
2. **Among survivors:** drop `avoidConfigKey` if any other survivor remains;
   otherwise keep the avoided key (it is the only one that works).
3. **Among what remains:** pick by latency only (no `paymentCdnOk` soft tier).

Unit: failure-driven hard filter with `avoidConfigKey=steel_managed` + unique
`paymentCdnOk=true` must promote steel; CF-only with all `paymentCdnOk=false`
must still prefer non-avoided. Deploy gate: parallel k=4
`scripts/run-bench --local browser-1015-eventim-request-card`. Do **not** bump
provider-exit cap.

## Human feedback

Deploy-ready requires this task to pass at **k=4 in parallel** (not serial).
Rejected soft priority reorder (“either the config works or it doesn’t”).

## Reusable lesson

Challenge recovery selects among configs that hard-pass the failure that triggered
them; never soft-rank optional capabilities, and never avoid a config that is the
only survivor of that hard filter.
