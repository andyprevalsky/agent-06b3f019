---
id: 2026-11-15-iframe-element-coordinates-missed-frame-offset
date: 2026-11-15
title: Humanized indexed clicks inside Stripe's offset cross-origin iframe used frame-local coordinates, so the live purchase timed out at 900s
surface: agents
component: browser-dom-coordinates
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/dom_service.py::DOMService.get_element_rect measured getBoundingClientRect() in the element's own iframe session and returned it as a top-level viewport point for the humanizer
symptoms:
  - 'Timeout after 905s (task timeout=900s) | Agent status: PAUSED (expected COMPLETED)'
  - agent-payment-production-purchase
  - Humanized click x=190 y=169 on checkout.stripe.com/g/pay/cs_live_ (iframe rect x=751.5 y=44)
  - Humanized click x=188 y=830 with a 625px viewport (Pay)
tags:
  - browser
  - iframe
  - oopif
  - coordinates
  - stripe
  - payment
sources:
  - agent b4466499-8297-4782-891a-3f0798c845a0 (prod run 24f0d4f8-54f0-43f5-bbf3-c2adff59204d, Render 48b03cb470)
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_dom_service_cross_origin_iframe_coordinates_include_frame_offset
status: fixed
---

## Problem

The live `agent-payment-production-purchase` run on 2026-11-15 (22:03-22:19Z)
ran out of its 900 s budget while the one browser agent was still on Stripe
Checkout. The harness paused the agent ("User paused the browser agent") about
20 s after the agent's final Enter key had submitted payment. The payment
lifecycle itself was correct: the purchase CLEARED and the live PI was captured.
The roughly 10 "spawn_browser_agent" rows were the single browser agent's
actions. The root agent never re-spawned anything.

The browser LLM dumps (R2, `fetch-agent-llm-dumps.ts`) and the worker
`Humanized click` logs show where the 12 minutes from 22:06 to 22:18 went.
Every indexed click and `input_text` into the `/g/pay/` Payment Element landed
at iframe-local coordinates. The `Secure embedded form frame` iframe sat at
x=751.5, y=44. Email clicks went to (190,169), Card to (191,278) and Pay to
(188,830) in a 625 px viewport. Each action reported success, but the email
and card values stayed empty. The agent burned 10 `evaluate` calls moving the
iframe to (0,0) with fixed positioning. After that the clicks landed, and Enter
finally submitted.

## Diagnosis

1. `get_element_rect` resolves the node through `cdp_client_for_node`, which is
   the iframe's own OOPIF session, and runs `getBoundingClientRect()` there.
   The result is relative to the iframe's viewport.
2. `BrowserHumanizer.click_at_coords` dispatches Playwright `page.mouse` events
   in top-page viewport coordinates. Nothing added the owning iframe's
   content-box origin. The visibility clip also used the iframe's own viewport,
   so (188,830) passed even though it was off-screen on the top page.
3. Why it surfaced now: Stripe's `/g/pay/` hosted layout renders the entire
   Payment Element in one offset `js.stripe.com` iframe. Case
   2026-11-12-hosted-checkout-gpay-iframe-layout-invisible-to-page-locators
   found the same layout breaking the test driver, but the agent coordinate
   path was not covered. The click-receipt check from 2026-10-02 skips iframe
   controls, so the misses were reported as success.

PR #2100 (owner account) is not the cause. Its only effect here was cosmetic:
Andy's email triggered Stripe Link's "Use your saved information" modal, which
cost about 30 s, plus an SMS OTP.

## Solution

`DOMService._rect_in_top_viewport` walks the node's browser-use
`parent_node` chain to each owning IFRAME/FRAME, whose `content_document` is the
child document. In each owner's own session it adds that owner's content-box
origin (`getBoundingClientRect` + `clientLeft/Top` + padding), and it clips to
every ancestor viewport. It returns None when nothing is visible on the top
page. Top-frame nodes have no owners and are unchanged. The fix costs one
resolveNode and one callFunctionOn per iframe level, only for iframe nodes. It
holds no shared state and does no per-agent fan-in, so it scales unchanged to
10k agents. It also fixes hover, typing and every other indexed humanized
action inside same-origin or cross-origin iframes.

## Human feedback

None recorded.

## Reusable lesson

Coordinates measured inside a frame are frame-local: translate them through
every owning iframe before dispatching top-page input, and treat
"success but value unchanged" inside an iframe as a coordinate bug, not a site quirk.
