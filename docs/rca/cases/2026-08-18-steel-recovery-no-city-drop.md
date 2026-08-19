---
id: 2026-08-18-steel-recovery-no-city-drop
date: 2026-08-18
title: createSteelRecoverySession had no city-drop retry so Stripe challenge recovery failed closed
surface: back-end
component: browser-challenge-recovery
classification: our-bug
problem_class: other
first_bad_boundary: createSteelRecoverySession — single steel.sessions.create without Invalid-proxy city-drop retry
symptoms:
  - Browser challenge recovery failed
  - Challenge recovery candidate create/probe failed steel_managed 400 Invalid proxy configuration
  - kernel_direct still challenged text:provider_blacklisted
  - agent-payment-production-purchase Timeout after ~900s with purchase HELD
tags:
  - steel
  - challenge-recovery
  - stripe
  - proxy
  - production-purchase
sources:
  - agent dc9cc4c9-6a76-44b5-8c6c-ba408e8a8484
  - agent 158e7db5-a104-46e1-b23c-c81c5633bfc4
repro: back-end/src/tests/unit/browser-challenge-recovery.test.ts (testSteelRecoverySessionDropsUnsupportedCity)
status: fixed
---

## Problem

After held-checkout last4 disambiguation shipped, `agent-payment-production-purchase`
reached Stripe Checkout (`cs_live_…`) then burned the 900s timeout on repeated
`Browser challenge recovery failed`. Place order / checkout-session no longer 409'd.

## Diagnosis

Prod Render logs for Stripe recovery:

1. Prefer Steel for Kernel-blacklisted `checkout.stripe.com`
2. Phase configs: `kernel_direct`, `steel_managed`, `steel_fixed`
3. `steel_managed` → `400 Invalid proxy configuration` (city-level geo; DEFAULT/DALLAS unsupported)
4. `steel_fixed` → `400 No active fixed IP proxies are available for this organization`
5. `kernel_direct` probes → `text:provider_blacklisted` / title `proxy error` (stablePasses=0)

`createSessionWithContext` already drops city and retries on Invalid proxy. Challenge
recovery's `createSteelRecoverySession` did a single create with no retry, so Steel
never reached country+state and the search failed closed.

## Solution

Retry `createSteelRecoverySession` with city dropped (and remember rejected city),
matching the normal session path. Cemented in unit test with injected createSession.

10k-agent behavior: O(1) extra Steel create only on first unsupported-city miss per
process (rejection cache); no fan-in.

## Human feedback

User approved continuing deploy/gates (`alowed`) after held-disambiguation
merged; fleet purchase still red on Stripe challenge recovery.

## Reusable lesson

Any session-create path that builds Steel geolocation proxies must share the
city-drop retry used by the primary create path — recovery/candidate factories
are not exempt.

## Outcome

Shipped in PR #983 (`f4cec5975`). Prod recovery now drops unsupported
city and promotes `steel_managed` with `stablePasses=2` / title Stripe Checkout.
Purchase still timed out because parallel search also waited ~93s for
`kernel_direct` (still blacklisted) each cycle — follow-on fix removes it from
preferSteel candidates.
