---
id: 2026-11-16-opaque-frame-click-reads-container-prose-as-purchase
date: 2026-11-16
title: Coordinate click into a cross-origin Stripe address frame read the checkout subtitle as a purchase write lock
surface: agents
component: browser-write-lock-probe
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/write_lock_probe.py probe_click_target (opaque_frame left unresolved: the probe never saw the text field inside the cross-origin frame) -> agents/domains/spawn_browser_agent_v3/service_actions.py::_click_write_lock_result coordinate fallback (dom_service.get_text_at_coordinates reads innerText of every element in the z-stack, including <body>)
symptoms:
  - "Expected attention kind payment_approval, observed write_lock"
  - "Expected payment_approval attention request (to ignore) but none was triggered"
  - "Write-lock probe left the click target unresolved (point): opaque_frame"
  - "Enter your personal information to complete your purchase."
  - "Secure address input frame"
tags:
  - write-lock
  - cross-origin-iframe
  - stripe
  - eventim
  - false-positive
  - browser-agent
sources:
  - agent b93df823-5d99-4c0e-b109-a8e7378b94c4
  - PR #2175 deploy occurrence 1a300d2aa77e422d967712eebe2f5768 (source 78861efa12)
  - commit 83bca4a37e (introduced the opaque_frame -> page-signal fallback)
repro: agents/tests/fixtures/write_lock_misfire_corpus.json cases opaque-frame-click-reads-container-prose + same-site-frame-field-click-reads-page-prose (run by agents/tests/blackbox/write_lock_misfire.blackbox.py)
status: fixed
---

## Problem

Smoke task `browser-1015-eventim-request-card` failed (FLAKY; the same-source
rerun passed) with "Expected attention kind payment_approval, observed
write_lock". In the PR #2175 deploy, agent b93df823 coordinate-clicked (223,114)
into the cross-origin Stripe "Secure address input frame" on
checkout.eventim.us. According to the deploy RCA's read of runtime-evidence
worker.log 9316-9321 (the evidence directory lives on the deploying devbox and
was not readable from this one), the probe returned `opaque_frame`, after which
the gate raised a purchase
write_lock before the agent called request_payment_card. The task requires the
payment_approval boundary to come first.

## Diagnosis

1. `PROBE_JS` (write_lock_probe.py) hits an `<iframe>` whose document is
   cross-origin, so it returns `{ok:false, reason:'opaque_frame'}`, and
   `probe_click_target` returns `None` (unresolved).
2. `_click_write_lock_result` (service_actions.py) treats an unresolved
   coordinate click as "keep the previous signal" and calls
   `dom_service.get_text_at_coordinates`. That joins the innerText of every
   element in `document.elementsFromPoint`: the iframe's title, the section
   container, and `<body>`.
3. The container subtitle "Enter your personal information to complete your
   purchase." matches the purchase phrase "complete your purchase" in
   `is_purchase_button`, so the gate raises a purchase write_lock on a click
   into an address field.

Local repro: the new corpus case served in headless Chromium logged
`element_text='Secure address input frame Personal details\n\nEnter your
personal information to '` and `expected none, got purchase`.

Why-ladder: (1) Why was page prose a label? The opaque-frame branch deferred to
the legacy z-stack text (commit 83bca4a37e, "keep page signal for opaque
frames"), a deliberate choice so wallet-button frames (PayPal, Stripe Express)
on order pages still lock. (2) Why could a *field* click reach that fallback?
The probe never saw inside the frame, so it could not apply its own existing
rule that a click into an editable field never commits. The deepest owned rung
is the probe's blindness to cross-origin frames, so the fix is there.

Archive searches: "complete your purchase write_lock opaque_frame cross-origin
frame", "eventim write lock purchase false positive request_payment_card",
"coordinate click elementsFromPoint body text write lock whole page", and a grep
for opaque_frame. Result: a relative, not a recurrence.
2026-08-10-eventim-terms-buy-now-false-purchase-write-lock is the same class
(page prose read as a commit label). Its lesson, "only the actual submit button
label", applies directly. Its phrase-exclusion fix could not catch this entry
point, because this subtitle is not consent prose. The corpus case
coordinate-click-reads-whole-page fixed the same mistake for same-origin
targets; cross-origin frames were the remaining hole.

## Solution

`write_lock_probe.probe_click_target`: when PROBE_JS reports `opaque_frame`
for a click, `_cross_origin_field_click` asks PROBE_JS (`intent='frame_owner'`)
for the hit frame element and reads its frame id and viewport content quad over
CDP. It then runs PROBE_JS at frame-local viewport coordinates inside the
frame's own context: its out-of-process target, or an isolated world for an
in-process frame (up to 4 hops, 5 s cap). A hit on an editable field resolves to
`commits=False` ("focuses an editable field"), the same rule as same-origin
pages, so page prose is never consulted. Any other hit (a wallet button, an
unloaded frame, an error or timeout) returns None, and the gate keeps the
83bca4a37e page signal.

A first attempt labelled the frame by its own accessible name only. The
independent verify-handoff review rejected it as BLOCKING: real wallet frames
("PayPal", "Secure express checkout frame", "Secure payment request button
frame") would no longer lock on a "Place order" page, and the replacement guard
was weaker. A second version hit-tested with `DOM.getNodeForLocation`; the
re-review showed that call takes document (scroll-inclusive) coordinates while
the click point and box model are viewport coordinates, so scrolled pages tested
the wrong point. The shipped version uses viewport coordinates throughout, and
the regression page is scrolled (it fails on HEAD and on that second version).

Regression: corpus case `opaque-frame-click-reads-container-prose`, a
cross-site (out-of-process) Stripe-style address frame inside a container whose
subtitle reads "...complete your purchase."; it expects no lock. A second
case, `same-site-frame-field-click-reads-page-prose`, covers the in-process
(same-site, cross-origin) path. Negative
controls: the unchanged guard `guard-click-into-cross-origin-frame-keeps-page-signal`
and the new `guard-click-on-cross-site-wallet-button-keeps-page-signal` (a
button inside an out-of-process frame still locks as purchase).

CodeRabbit review on PR #2338 found two more fail-open mappings, both fixed fail-closed
(return None, keep the page signal): a rotated or skewed frame (non-axis-aligned content
quad), and a hop after an in-process frame (its box model is in root-viewport
coordinates). Guards `guard-click-into-skewed-cross-site-frame-keeps-page-signal` and
`guard-click-through-in-process-frame-into-nested-frame-keeps-page-signal` misfired
(expected purchase, got none) on the earlier probe and pass now.

10k-agent behavior: extra CDP round trips (at most 4 hops, 5 s cap) only on
coordinate clicks that land in a cross-origin frame; per-browser, no shared
state.

## Human feedback

The repair goal asked that, when the probe returns opaque_frame, surrounding
container or subtitle prose not be used as purchase evidence. That holds
wherever the click is proven to land in a field. Wallet-button frames keep the
page signal that commit 83bca4a37e deliberately added (see Solution).

## Reusable lesson

When the write-lock gate cannot see the control (cross-origin frame), look
inside over CDP before falling back to page text: a field click never commits,
whatever the surrounding prose says.
