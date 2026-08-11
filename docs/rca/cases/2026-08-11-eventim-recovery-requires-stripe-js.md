# Eventim recovery succeeded without Stripe.js loading

status: fixed
cluster: Broken Tool
date: 2026-08-11
agents: 5d59430b, 7f91554e, ce52f350
task: browser-1015-eventim-request-card

## Symptom

Challenge recovery reported success after CF clears while checkout still logged
`Failed to load Stripe.js` / `ERR_BLOCKED_BY_ORB`. Agent never reached usable
payment fields / `request_payment_card`.

## Evidence (Step 0)

1. Recovery ranked/promoted on `fetch(js.stripe.com)` (+ historically
   `api.stripe.com`) — not on `<script src=js.stripe.com/v3>` defining
   `window.Stripe`.
2. Live matrix against `https://checkout.eventim.us/?afflky=1015Folsom`:
   - **steel_managed @ Dallas:** stable=2, `stripe.js=true`, `js=true`,
     `m.stripe.com=true`, `api.stripe.com=false` (real `Failed to fetch` even
     with `mode:'no-cors'`).
   - **kernel_isp:** fetches to js/api/m/r succeed (opaque), but Stripe.js
     script `onerror` — `stripe.js=false`.
3. Default-cors `fetch(api.stripe.com)` from Eventim origin also false-negatives
   via missing ACAO; probe now uses `no-cors` for host tunnels.

## Root cause

Recovery treated payment-CDN *fetch* as success. Checkout needs Stripe.js to
load. `api.stripe.com` tunnel is not a reliable hard gate on current Steel
(loads Stripe.js, blocks api) vs Kernel (reaches api, blocks script).

## Fix

- `paymentCdnOk` = `js.stripe.com` fetch + Stripe.js script load.
- Checkout URLs set `requirePaymentCdn` so CF-only winners are not promoted.
- Agent live verify fails recovery if Stripe.js still missing after promote.
- Cemented in `browser-challenge-recovery-payment.test.ts` +
  `challenge_recovery.blackbox.py`.

## Local repro

```bash
cd back-end && npx tsx src/tests/unit/browser-challenge-recovery-payment.test.ts
cd back-end && PROBE_CONFIG_KEY=steel_managed npx tsx scripts/probe-stripe-js-configs.ts
# expect paymentCdnOk=true, stripeJs=true on steel_managed
```
