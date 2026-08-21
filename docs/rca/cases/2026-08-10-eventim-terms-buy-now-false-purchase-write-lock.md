---
id: 2026-08-10-eventim-terms-buy-now-false-purchase-write-lock
date: 2026-08-10
title: Eventim Terms of Purchase prose falsely triggered purchase write lock
surface: agents
component: browser_tools.write_lock.is_purchase_button
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/write_lock.py::is_purchase_button — substring "buy now" matched Terms of Purchase consent copy
symptoms:
  - "Write lock triggered: purchase button detected"
  - "By clicking \"Buy Now,\" you agree to our"
  - "product_url host must match a page the browser actually visited"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "Timeout after 1202s"
tags:
  - eventim
  - write-lock
  - purchase-button
  - terms-consent
  - browser-1015-eventim-request-card
sources:
  - agent e20e5a4e-dbb6-408a-bd83-c8cace5c536c
  - PR #948
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_write_lock_purchase_button_excludes_terms_consent_prose
status: fixed
---

## Problem

After fixing the marketing opt-in email_send false positive, Eventim still failed
(timeout / no `payment_approval`). Agent `e20e5a4e-dbb6-408a-bd83-c8cace5c536c`
reached checkout, successfully unchecked marketing, then clicked Terms copy
containing `By clicking "Buy Now," you agree…`. Worker logged
`Write lock triggered: purchase button detected`, then
`generate_write_lock_notification` failed with
`product_url host must match a page the browser actually visited`, and the run
never reached `request_payment_card` before the 1200s cap.

## Diagnosis

1. Runtime element_text was legal consent prose quoting the purchase verb, not
   the Buy Now control itself.
2. `is_purchase_button` substring-matches `buy now` after whitespace stripping,
   so consent copy matched.
3. The forced purchase write-lock notification path then failed host validation
   and stalled the browser agent.
4. Relative of the same-day marketing opt-in email_send false positive — same
   problem class (write-lock classifier over-matching non-action labels).

Local owning-boundary repro (pre-fix True, post-fix False on terms prose):

```bash
cd agents && source venv/bin/activate
python -c "from browser_tools.write_lock import is_purchase_button; print(is_purchase_button('By clicking \"Buy Now,\" you agree to our Terms of Purchase'))"
```

## Solution

Exempt consent/legal prose patterns (`by clicking`, `you agree`,
`terms of purchase`, `privacy policy`, …) in `is_purchase_button` before
phrase matching. Real `Buy Now` / `Place Order` / `Pay Now` labels still lock.

Cemented in
`test_write_lock_purchase_button_excludes_terms_consent_prose`.
10k-agent behavior: O(1) substring checks per click label; no shared state.

## Human feedback

None recorded. User asked to focus on getting Eventim to pass via `/sync` +
bench rerun after aborting full daily `/descend`.

## Reusable lesson

Never treat legal/consent copy that merely quotes a purchase verb as a purchase
write-lock control — only the actual submit button label.
