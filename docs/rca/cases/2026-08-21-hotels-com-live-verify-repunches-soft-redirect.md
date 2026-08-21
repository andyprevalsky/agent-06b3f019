---
id: 2026-08-21-hotels-com-live-verify-repunches-soft-redirect
date: 2026-08-21
title: hotels.com live verify re-punched poisoned deep link after soft-redirect probe clear
surface: cross
component: browser-challenge-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/challenge_recovery.py::_probe_page — every live-verify attempt re-navigated the original challenged URL
symptoms:
  - 'Promoted kernel_residential_city passed candidate probes but the live tab is still challenged'
  - 'Bot or Not?'
  - browser-hotel-booking Timeout after 903s
  - stripped lane stablePasses=2 then live verify 429
tags:
  - browser-agent
  - challenge-recovery
  - hotels-com
  - soft-block
  - soft-redirect
sources:
  - agent 3a1423a0-baa4-4f06-8786-955b7da79f30
repro: agents/tests/blackbox/challenge_recovery.blackbox.py::live_tab_verify_same_site_soft_redirect
status: fixed
---

## Problem

After cookie-lane recovery, `browser-hotel-booking` on agent
`3a1423a0-baa4-4f06-8786-955b7da79f30` promoted `stripped` +
`kernel_residential_city` (2/2 clean probes) then failed live verify:
`Promoted kernel_residential_city passed candidate probes but the live tab is
still challenged`. Timeout at 903s with no `payment_approval`.

## Diagnosis

Backend probes navigated the challenged Hotel Kabuki deep link; Hotels.com
soft-redirected to a city-search results URL (HTTP 200, classifier clean). Live
verify then called `_probe_page(current_url=Kabuki)` twice. Attempt 1 also
settled clean on city search; attempt 2 re-hit Kabuki and got HTTP 429 /
Bot or Not.

Critical path: recover-challenge lane search → promote preloaded session →
`verify_live_page_cleared_challenge` → `_probe_page` always `goto(target_url)`.

Owned contract bug: stability checks must re-nav the settled same-site document
after a clean soft-redirect, not re-punch the poisoned deep link.

## Solution

- `_probe_page` / backend `probeCandidateBrowser`: after a clean settle, follow-up
  attempts navigate `same_site_navigation_url(target, page.url)`.
- `searchAndPromoteBrowserConfig` returns `saved_url` as that settled URL.
- Handler live verify prefers `config_result.saved_url`.

## Verification

```bash
cd agents && python tests/blackbox/challenge_recovery.blackbox.py
# live_tab_verify_same_site_soft_redirect
cd back-end && npx tsx src/tests/unit/browser-challenge-recovery.test.ts
```
