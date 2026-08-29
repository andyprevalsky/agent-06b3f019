---
id: 2026-08-29-blue-bottle-guest-form-skipped-before-payment
date: 2026-08-29
title: Blue Bottle reached payment with Ferry+ASAP+item but skipped guest contact/card UI so the semantic judge failed guest checkout
surface: agents
component: spawn-browser-agent-v3 / browser_use.py
classification: our-bug
problem_class: uncaptured-user-preference
first_bad_boundary: agents/providers/rose/browser_use.py Authentication priority — guest/anonymous is priority 7 and does not require filling guest contact + new Credit/Debit before request_payment_card when the goal says guest checkout
symptoms:
  - guest checkout is not directly grounded
  - no tool output shows selection or use of merchant guest checkout
  - Score 0 because guest checkout is not directly grounded
  - Clicked <a "Checkout $12.00"> then Payment card requested without firstName/lastName
  - 'auth_source": "none"'
tags:
  - blue-bottle
  - guest-checkout
  - browser-agent
  - payment-approval
  - semantic-judge
sources:
  - fleet run 670cb9b0-5781-4c46-a4e8-9b93c3910842
  - agent 25a909af-4d4c-4afd-9911-ee5350c3e4de
  - agent 1cba6647-b233-42f2-aafe-40fd6729494b
  - PR #1069
repro: pending — owning-boundary prompt/routing test + unchanged scripts/run-bench --local browser-blue-bottle-challenge-recovery
status: open
---

## Problem

Post kill-switch k=5 (`670cb9b0`) scored **1/5**. Agent `25a909af` selected Ferry Building,
configured KSE Shakerato / Almond / $12.25 / ASAP 9–19 min, and stopped at one unresolved
`payment_approval`, but `blue_bottle_pickup_order_semantics` scored 0 solely because guest
checkout was not grounded in tool output.

Pass contrast `1cba6647` on the same stack did: `input_text` firstName/lastName → Toggle →
`Credit/Debit Card Add payment` → `request_payment_card`. Fail `25a909af` went Checkout →
wait → `request_payment_card` with no guest contact or new-card clicks.

`session_init` for both: `auth_source=none`, `cookies_injected=false` (kill-switch held).

## Diagnosis

**Relative** of `2026-08-22-alchemy-momence-login-blocks-guest-payment-terminal` (guest-first
preference not elevated) and post-fix sibling of
`2026-08-29-guest-checkout-saved-auth-killswitch-not-on-stack` (cookies fixed; UI path still
optional).

Archive searches: `guest checkout is not directly grounded`, `Ferry Building pickup time
payment approval blue bottle`, `Expected payment_approval attention request`.

Critical path: goal says guest checkout → browser reaches order.online checkout →
`request_payment_card` without demonstrating guest form / new-card path → tree-aware
semantic judge correctly fails criterion 3.

First-bad boundary: shared browser auth priority lists guest as step 7 and never requires
the guest-form actions the passing trial used when the goal explicitly requests guest checkout.

Not model-intelligence-classified yet — no model-only replay with all other variables held
constant (Step 3a gate unmet).

## Solution

**Proposed (needs approval — prompt/routing change):**

When goal text includes `guest checkout` / `guest details` / `book as guest`, elevate guest
completion and require grounded guest-path actions before `request_payment_card`:
fill guest contact fields when shown; choose new Credit/Debit over saved-payment shortcuts;
do not treat bare unauthenticated session as sufficient guest evidence.

Causal proof: prompt/routing unit or blackbox asserting guest-first guidance is present when
goal contains guest checkout; trajectory contrast vs `25a909af` action titles.

Outcome proof: unchanged `scripts/run-bench --local browser-blue-bottle-challenge-recovery`
k=5 with guest-grounding failures eliminated (kill-switch already on stack).

Do not relax the semantic judge to accept `auth_source=none` alone.

## Human feedback

User required k=5 alongside tree-aware semantic evidence and `/rca` of failing runs.
Payment language in spawn goals remains allowed; almond OR oat milk OK.

## Reusable lesson

Unauthenticated browser state is not guest-checkout evidence — require the same guest contact
and new-payment UI actions the passing trajectory used when the goal asks for guest checkout.
