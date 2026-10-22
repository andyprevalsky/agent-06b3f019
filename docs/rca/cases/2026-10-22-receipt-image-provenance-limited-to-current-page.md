---
id: 2026-10-22-receipt-image-provenance-limited-to-current-page
date: 2026-10-22
title: request_payment_card rejected a receipt image copied exactly from the event page because checkout does not render it
surface: agents
component: dom-service-page-image-urls
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/dom_service.py DOMService.get_page_image_urls returned only the current page's images, so _receipt_image_url_errors could not see an image this browser activity rendered on the product/event page before navigating to checkout
symptoms:
  - "image_url must be copied exactly from an image rendered on the current page, or omitted"
  - "request_payment_card receipt is incomplete: line_items[0].image_url"
  - browser-1015-eventim-request-card failed no_tool_failures after reaching payment approval
tags:
  - request-payment-card
  - receipt
  - image-url
  - purchase-approval
  - checkout
sources:
  - agent fe68bf12-2a1e-4b85-bf57-d67322480225
  - agent 2cf378ca-0771-4d46-b3ca-a89582d9a85e
  - commit 4ee9390b9
repro: test_receipt_image_rendered_on_an_earlier_page_of_the_activity_validates (handed to lane C for agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py)
status: open
---

## Problem

browser-1015-eventim-request-card (agent 2cf378ca, Steel session after
recovery, so provider-independent) reached the $27.48 payment approval but
failed the evaluator's `no_tool_failures` check. Its first `request_payment_card`
(call_3gDm9eOVJDTJ9QlRfzhiwdnC, 23:38:57Z) returned
`request_payment_card receipt is incomplete: line_items[0].image_url
https://prod-images.seetickets.us/eyJidWNrZXQ...ZWRpdHMiOnt9fQ==: image_url must
be copied exactly from an image rendered on the current page, or omitted.` The
retry without `image_url` succeeded.

## Diagnosis

Run record (lane F): on the event page `wl.eventim.us/event/yaego/707562` the
page rendered `<img src=https://prod-images.seetickets.us/eyJ...ZWRpdHMiOnt9fQ==>`
(plus a 600 px variant). The model copied that URL byte for byte. It then called
`request_payment_card` on `https://checkout.eventim.us/?afflky=1015Folsom`,
which renders other images but not the event image. Commit 4ee9390b9 (2026-10-02)
validates receipt images against `DOMService.get_page_image_urls()`, which reads
only the current page, to reject transcription drift. The provenance scope
(current page) is narrower than the rule's purpose (an image this browser really
rendered); checkout pages commonly omit the product image.

Local repro (real `DOMService.get_browser_state` then `get_page_image_urls` over
a fake browser-use session, real `validate_image_url_for_page`, the real URL
pair): on integration it raises exactly the production `ValueError`; the
event-page `media_candidates` shown to the model do contain the URL.

## Solution

Proposed (lane C owns `dom_service.py`; diff sent 2026-10-22): `DOMService`
remembers image URLs rendered by every page it observes in the activity
(`get_browser_state` and `get_page_image_urls`, insertion-ordered, capped at
400), and `get_page_image_urls` returns current-page images first, then earlier
ones. The validator is unchanged: an exact match is still required, and a
never-rendered or one-character-drifted URL is still rejected (both asserted).
After the fix the repro passes 5/5, and the existing fresh-snapshot test passes.
10k agents: per browser activity, in process, at most 400 URLs, freed with the
DOMService; no shared state. A resumed activity starts empty, which is the old,
stricter behaviour. The model-visible error text still says "current page";
changing it is an approval-gated text edit, queued. Outcome gate (exact
benchmark) pending; status stays open until it passes.

### 2026-10-22 recurrence: provenance lost on a session switch

The first fix (activity-wide memory on the DOMService) held within one browser
session but not across a switch. Agent fe68bf12 (af169f352): the event page
rendered the seetickets `edits:{}` image on the residential Tilion session
(~00:49:52-00:50:09); challenge recovery promoted a tilion_direct session at
00:53:26; `request_payment_card` ran at 00:54:55 on checkout. The model had copied
the URL from a `read_network_requests` result. `_reconnect_browser_stack_after_rotation`
(used by rotate_ip and challenge recovery) builds a new DOMService and copies only
the secret-redaction state, so the remembered images were dropped. Fix sent to
lane C: `DOMService.rendered_image_state()` / `restore_rendered_image_state()`
(same 400 cap), and the rebind carries them. Regression through the real rebind
fails on af169f352 with the production error and passes 5/5 patched. Separate gap
found locally: the tracker reads browser-use's pruned snapshot tree, so `<img>`s
far below the viewport are not recorded (9 of 12 on the eventim listing page).

## Human feedback

None recorded.

## Reusable lesson

Scope provenance checks to where the evidence can legitimately come from (the browser activity), not where the action happens (the checkout page).
