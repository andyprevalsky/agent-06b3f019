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
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py (test_live_tab_looks_challenged_helpers, test_recovery_skips_when_live_tab_already_clear, test_url_looks_like_api_surface_and_navigation_pin, test_execute_goto_refuses_api_surface_urls, test_execute_navback_refuses_when_host_pinned)
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

## Diagnosis

1. Place order redirects to a Kernel-blacklisted challenge target → provider
   recovery (preferSteel for blacklisted *challenge targets* is correct).
2. Recovery correctly promoted `steel_managed` and verified the live tab.
3. The LLM then treated third-party network reads / flakes as a reason to
   navigate away or re-run `recover_from_challenge` on an already-clean page —
   burning the step budget.

## Solution

Do **not** special-case merchant/CDN endpoints by name. General harness rules:

1. If `recover_from_challenge` is requested and the live tab does not look
   challenged (and this was not a hard `provider_exit_rejected`), skip recovery
   and tell the agent to continue on the current URL.
2. After successful recovery (or clean-page skip), pin `goto`/`navback`/
   `open_new_tab` to the recovered host so the model cannot leave for network
   thrash.
3. Refuse navigation to API/non-document URL shapes (`api.*`, `/v1/`,
   `/healthcheck`, …) — vendor-agnostic.
4. Keep existing provider-level preferSteel for Kernel-blacklisted *challenge
   targets* (host denylist), not merchant start-URL heuristics.
5. Pin `Current page URL` on successful recovery so the model stays oriented.
6. `agent-payment-production-purchase` is `--prod` / production workers — harness
   fixes must be deployed to Fly before fleet can prove them. Do not divert
   `--prod` onto an isolated queue (fleet 8bfe3691 STARTING_UP → FAILED).

## Human feedback

User rejected endpoint-specific logic; `alowed` to continue until purchase
CLEARED with general harness rules only.

## Reusable lesson

LLM-requested challenge recovery on an already-clean document is noise — skip
it unless `provider_exit_rejected` requires a real exit rotation. After a
successful recovery, pin navigation to that host and refuse API-shaped URLs;
do not paper over model thrash with vendor/path special-cases.
