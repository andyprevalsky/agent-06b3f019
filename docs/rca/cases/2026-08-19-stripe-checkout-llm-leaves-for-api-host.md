---
id: 2026-08-19-stripe-checkout-llm-leaves-for-api-host
date: 2026-08-19
title: After Steel Checkout recovery the LLM navigated to api.stripe.com and restarted merchant flow
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: other
first_bad_boundary: browser started on Kernel for agentcard-live-lifecycle; after preferSteel promote onto Checkout the LLM goto api.stripe.com / test_payment
symptoms:
  - Place order → checkout-session 200 → challenge recovery → steel_managed
  - Next action Navigating → https://api.stripe.com/ → ERROR
  - Then recover again → Navigating → test_payment (restart Place order)
  - purchase stayed HELD; 900s timeout
tags:
  - stripe
  - challenge-recovery
  - steel
  - production-purchase
sources:
  - agent cd0c2060-47fb-4ab4-aff2-17892b336427
  - agent 641444dc-7bf3-4eee-b57c-c58e364467c1
  - fleet run 20260819-002102-843616 ref e277cf645
  - fleet run 20260819-004041-887409 ref a239a2b36
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py (test_live_tab_looks_challenged_helpers, test_recovery_skips_when_live_tab_already_clear, test_url_looks_like_api_surface_and_navigation_pin, test_execute_goto_refuses_api_surface_urls, test_execute_navback_refuses_when_host_pinned, test_execute_navback_refuses_on_cross_origin_handoff, test_navigation_guard_has_no_endpoint_path_allowlists)
status: open
---

## Problem

Fleet `agent-payment-production-purchase` on `#988` (sticky Place order) reached
`POST /checkout-session → 200` twice and recovered to `steel_managed`, but never
CLEARED. After each recovery the browser agent navigated to
`https://api.stripe.com/` (ERROR) or back to `/test_payment` instead of filling
hosted Checkout.

Follow-up agents reached `checkout.stripe.com/c/pay/cs_live_*`, then spent the
900s budget looping challenge recovery invented from third-party network noise
(e.g. healthcheck flakes) instead of filling card fields.

Fleet `7c0cce61` / `d9bdf969` on harness-only refs: Place order → recovery →
Checkout, then **navback** away / `goto api.*` → more recovery; purchase stayed
HELD. Those fleets never executed the harness fix — `--prod` scheduled onto the
shared production Temporal queue, so cloudbench workers with the code under
test never received the workflow.

Fleet `ea340c81` after payment-document nav guards: API refuse worked, but
merchant `/test_payment` and hosted Checkout both matched loose payment-path
markers, so `goto` merchant←→checkout stayed allowed and the agent kept
restarting Place order.

## Diagnosis

1. Place order redirects to a Kernel-blacklisted challenge target → provider
   recovery (preferSteel for blacklisted *challenge targets* is correct).
2. Recovery correctly promoted `steel_managed` and verified the live tab.
3. The LLM then treated third-party network reads / flakes as a reason to
   navigate away or re-run `recover_from_challenge` on an already-clean page —
   burning the step budget.

## Solution

Do **not** special-case merchant/CDN endpoints, payment path markers, or hosted
checkout host labels. General harness rules only:

1. If `recover_from_challenge` is requested and the live tab does not look
   challenged (and this was not a hard `provider_exit_rejected`), skip recovery
   and tell the agent to continue on the current URL.
2. After successful recovery, keep an explicit host pin for `goto`/`navback`/
   `open_new_tab`.
3. **Cross-origin handoff pin:** when the live page's registrable domain differs
   from the session `start_url` origin, pin navigation to the live host. This
   covers Place-order / OAuth / 3DS redirects without `checkout`/`payment` path
   allowlists (those wrongly treated merchant `/test_payment` and hosted
   Checkout as interchangeable).
4. Refuse navigation to API/non-document URL *shapes* (`api.*`, `/v1/`,
   `/healthcheck`, …) — no vendor host names in the label list.
5. Keep existing provider-level preferSteel for Kernel-blacklisted *challenge
   targets* (host denylist), not merchant start-URL heuristics.
6. Pin `Current page URL` on successful recovery so the model stays oriented.
7. `agent-payment-production-purchase` is `--prod` / production workers — harness
   fixes must be deployed to Fly before fleet can prove them. Do not divert
   `--prod` onto an isolated queue (fleet 8bfe3691 STARTING_UP → FAILED).

## Human feedback

User rejected endpoint-specific logic (`alowed` to continue until purchase
CLEARED). Follow-up: payment-document path markers and hosted-payment host
label allowlists are also smelly — replace with origin≠live domain handoff pin.

## Reusable lesson

LLM-requested challenge recovery on an already-clean document is noise — skip
it unless `provider_exit_rejected` requires a real exit rotation. After leaving
the session origin domain, pin to the live host and refuse API-shaped URLs; do
not paper over model thrash with vendor/path special-cases.
