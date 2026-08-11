# Recovery re-verify must be failure-driven, not Stripe/URL-hardcoded

status: fixed
cluster: Broken Tool
date: 2026-08-11
agents: 5d59430b, 7f91554e, ce52f350
task: browser-1015-eventim-request-card

## Symptom

Challenge recovery reported success after CF clears while checkout still could
not load Stripe.js (ORB / tunnel). A Stripe-or-`/cart`-URL hard gate would also
false-negative non-Stripe recoveries.

## Root cause

Success was "challenge cleared" (and briefly "URL looks like payment ⇒ require
Stripe.js"). The correct contract is:

```
recovery_success =
  challenge_cleared
  AND (no blocked third-party URL that triggered this recovery
       OR that same URL now loads on the promoted tab)
```

## Fix

1. Network recorder: critical third-party blocks (payment CDNs **or** non-analytics
   scripts) with tunnel/ORB/client-block errors → provider-exit carrying `url`.
2. Agent live verify: only re-check `blocked_resource_url` from that rejection;
   empty ⇒ CF-only (no false negatives on Blue Bottle / plain CF).
3. Backend: drop URL-based `requirePaymentCdn`; keep payment CDN probe as soft
   ranking only. Live matrix winner remains `steel_managed` for Eventim Stripe.js.

## Working config (Eventim)

`steel_managed` @ Dallas — Stripe.js loads. Kernel clears fetch hosts but script
onload fails.
