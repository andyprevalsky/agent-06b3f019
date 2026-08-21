---
id: 2026-08-11-eventim-recovery-requires-stripe-js
date: 2026-08-11
title: Recovery re-verify must be failure-driven, not Stripe/URL-hardcoded
surface: cross
component: browser-challenge-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: challenge recovery live verify — success equated to CF clear / URL looks like payment, without re-checking the blocked third-party URL that triggered recovery
symptoms:
  - Challenge recovery reported success after CF clears while Stripe.js still blocked
  - 'ERR_BLOCKED_BY_ORB'
  - 'requirePaymentCdn'
  - browser-1015-eventim-request-card
tags:
  - browser-agent
  - eventim
  - challenge-recovery
  - stripe
  - payment-cdn
sources:
  - agent 5d59430b-8c5c-4b93-98ab-da7b77a46af7
  - agent 7f91554e-9cc5-4ea2-bf29-1dc75578511f
  - agent ce52f350-ec60-417a-89d1-ecef08a391ea
  - commit faa3a49cdab883816aa645545809942df85a8fb5
repro: none-recorded
status: fixed
---

## Problem

Challenge recovery reported success after CF clears while checkout still could
not load Stripe.js (ORB / tunnel). A Stripe-or-`/cart`-URL hard gate would also
false-negative non-Stripe recoveries.

Agents: `5d59430b-8c5c-4b93-98ab-da7b77a46af7`,
`7f91554e-9cc5-4ea2-bf29-1dc75578511f`,
`ce52f350-ec60-417a-89d1-ecef08a391ea` on
`browser-1015-eventim-request-card`.

## Diagnosis

Success was "challenge cleared" (and briefly "URL looks like payment ⇒ require
Stripe.js"). The correct contract is:

```
recovery_success =
  challenge_cleared
  AND (no blocked third-party URL that triggered this recovery
       OR that same URL now loads on the promoted tab)
```

Owning boundary: recovery re-verify was URL/Stripe-hardcoded instead of
failure-driven from the blocked resource that triggered the exit.

## Solution

1. Network recorder: critical third-party blocks (payment CDNs **or** non-analytics
   scripts) with tunnel/ORB/client-block errors → provider-exit carrying `url`.
2. Agent live verify: only re-check `blocked_resource_url` from that rejection;
   empty ⇒ CF-only (no false negatives on Blue Bottle / plain CF).
3. Backend: drop URL-based `requirePaymentCdn`; keep payment CDN probe as soft
   ranking only. Live matrix winner remains `steel_managed` for Eventim Stripe.js.

Working config (Eventim): `steel_managed` @ Dallas — Stripe.js loads. Kernel
clears fetch hosts but script onload fails.

## Human feedback

None recorded.

## Reusable lesson

Drive challenge-recovery re-verify from the blocked third-party URL that triggered the exit — never hard-require Stripe.js or cart-looking URLs for all recoveries.
