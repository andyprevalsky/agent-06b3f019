---
id: 2026-08-22-hotels-com-switch-tab-blocked-on-same-host-pin
date: 2026-08-22
title: Host pin blocked switch_tab back to hotels.com checkout after property-page evidence
surface: agents
component: spawn-browser-agent-v3
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/spawn_browser_agent_v3/service_actions.py — (1) navigation_leaves_pinned_host blocked all switch_tab on pinned host; (2) attempt_completion accepted at verifier 100% without request_payment_card when checkout card fields were visible
symptoms:
  - Refusing to leave pinned page host 'www.hotels.com'
  - browser-hotel-booking timeout after 1128s (dynamic cap=1125s)
  - Expected payment_approval attention request (to ignore) but none was triggered
  - request_payment_card never called after Reserve on Hotel Kabuki checkout
  - Payment card request required before completion
tags:
  - browser-agent
  - hotels-com
  - navigation-pin
  - switch-tab
  - payment-card
  - ecommerce
sources:
  - agent 7bdfd4bb-b069-4aa9-aafe-1455525480fa
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_execute_switch_tab_allows_same_host_while_pinned, test_attempt_completion_blocked_when_payment_fields_visible_without_card_request
status: fixed
---

## Problem

`browser-hotel-booking` reached Hotel Kabuki checkout, clicked Reserve, and
displayed payment fields, but timed out at 1125s without ever calling
`request_payment_card` (no `payment_approval`). After Reserve (~14:44:35 UTC)
the browser agent spent ~13 minutes looping: verifier scored `attempt_completion`
at 50% (missing non-smoking evidence), opened the property page tab to gather
rating/product URL for `request_payment_card`, then tried `switch_tab` back to
checkout and was refused:

```
Refusing to leave pinned page host 'www.hotels.com'. Current page URL: https://www.hotels.com/checkout/session/...
(do not go back, close/switch tabs, or navigate to another host until this page is done).
```

## Diagnosis

Critical path: challenge recovery sets `navigation_pin_host=www.hotels.com` →
agent reaches checkout and Reserve → verifier rejects `attempt_completion` at
50% for missing non-smoking proof → agent opens property tab for
`request_payment_card` line-item fields → `switch_tab` to checkout tab →
`navigation_leaves_pinned_host` returns True for every `switch_tab` on a pinned
host (same bucket as `navback`/`close_tab`) → agent cannot refocus checkout →
never calls `request_payment_card` → benchmark times out.

Relative to `2026-08-03-verifier-discarded-load-bearing-product-dom` (evidence
lifetime) and `2026-08-10-eventim-empty-shell-no-payment-card` (agent defers
card request). This incident's first-bad boundary is the pin guard, not model
reasoning alone: runtime messages show explicit `switch_tab` ERROR on the same
host while checkout payment fields were visible in other verifier passes.

Pre-fix local repro (simulated old blanket block):

```python
navigation_leaves_pinned_host(
    current_url="https://www.hotels.com/checkout/session/abc",
    target_url="https://www.hotels.com/checkout/session/abc",
    pin_host="www.hotels.com",
    action="switch_tab",
)  # True — blocked even for same-host checkout tab
```

Post-fix: resolve target tab URL via `session.get_tabs()` before the guard;
block `switch_tab` only when the target tab's host leaves the pin (same rule as
`goto`). Checked-in test
`test_execute_switch_tab_allows_same_host_while_pinned` fails pre-fix and
passes post-fix.

## Solution

1. **switch_tab pin guard** (`service_actions.py`): resolve target tab URL via
   `session.get_tabs()` before the guard; block `switch_tab` only when focus
   would leave the pinned host. Post-fix run `a5e573ae` showed multiple
   successful same-host `switch_tab` actions (stall eliminated; 920s vs 1128s
   timeout).

2. **attempt_completion guard** (`service_actions.py` +
   `handler.py`): `attempt_completion_blocked_pending_payment_card_request`
   rejects completion when semantic card inputs are visible and
   `request_payment_card` was never called — steers the agent to the tool the
   benchmark gates on (`payment_approval`).

Cross-origin handoff safety preserved for both fixes. 10k-agent: O(1) per
action; no shared mutable state.

## Human feedback

None recorded.

## Reusable lesson

When a navigation pin blocks tab switches, resolve the target tab's URL and only
refuse `switch_tab` when focus would leave the pinned host — never blanket-block
same-registrable-domain checkout ↔ product tabs.
