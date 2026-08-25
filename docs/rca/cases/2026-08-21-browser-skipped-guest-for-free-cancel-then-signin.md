---
id: 2026-08-21-browser-skipped-guest-for-free-cancel-then-signin
date: 2026-08-21
title: Browser skipped I'll reserve (free-cancel chase) then Sign-in auth_assistance
surface: agents
component: spawn_browser_agent_v3 / browser_use auth waterfall
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browser-use loop on booking.com/hotel miyako.html — never clicked submit [8848] I'll\xa0reserve while task requires free cancellation and all visible rates said Total cost to cancel; later goto homepage then Sign in
symptoms:
  - Expected attention kind write_lock, observed auth_assistance
  - I'll reserve
  - Total cost to cancel
  - Refusing to leave pinned page host
tags:
  - browser
  - auth-assistance
  - guest-checkout
  - booking-com
  - navigation-pin
  - free-cancellation
sources:
  - agent b78986e4-5b42-4e1e-8b37-87f8e5d09d52
  - PR #1032
  - commit 283e38a81
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_text_indicates_guest_completion_option_matches_booking_cta
status: open
---

## Problem

`browser-hotel-booking` ended with `auth_assistance` instead of `write_lock`.
Agent `b78986e4-5b42-4e1e-8b37-87f8e5d09d52` (model `openai/gpt-5.6-sol`) reached
Booking.com Hotel Kabuki (`miyako.html`) with rooms and an
`[8848]<button type=submit>I'll\xa0reserve</button>` CTA ("You won't be charged
yet"), never clicked it, later `goto https://www.booking.com/`, clicked
`[18726] Sign in`, then `request_user_assistance_for_authentication`.

Dump evidence:
- `/opt/cursor/artifacts/culprit_auth_assist_before_guest/1787275089547-656310017ed4-browser_use_step_25.json` (Sign in click)
- `…/1787275115507-656310017ed4-browser_use_step_28.json` (auth assistance)

An early theory blamed `guest_unavailable=True` for "skipping guest." That flag
only explains why the hard gate *allowed* assistance after Sign in — it did not
cause the model to skip `[8848]`.

## Diagnosis

Critical path: task prompt (free cancellation required) → hotel DOM (all rates
`Total cost to cancel`) → LLM never clicks `[8848]` → Expedia escape attempts
blocked by navigation pin → `goto booking.com/` → Sign in → auth assistance.

1. Task `browser-hotel-booking` requires free cancellation and forbids
   nonrefundable rates (`agents/benchmarks/tasks.json`).
2. On the hotel page, every visible rate policy line was `Total cost to cancel`
   (msg 46 DOM). Model thinking at step 10–11 explicitly chased free cancel /
   Expedia.
3. Action history: clicks were 2876, 8817 (policy details), 18363 — **never
   index 8848**. Verifier twice said proceed through `I'll reserve` / checkout;
   model still did not click it.
4. Pin refused Expedia `goto` / `open_new_tab` / `evaluate` / injected link
   clicks. Model then navigated to the Booking homepage (same host, allowed),
   where `I'll reserve` was gone and `Sign in` was in the header.
5. Separate gate bug (not the skip cause): `AuthRuntimeState.guest_unavailable`
   defaulted True so step 8 was not blocked after Sign in. Also the guest CTA
   regex used a regular space and missed Booking's `I'll\xa0reserve` NBSP, so
   even the corrected "option_seen" gate would not have observed the real CTA
   until the regex was fixed.

Archive searches: `guest checkout auth_assistance`, `auth_assistance write_lock
browser-hotel-booking`, `I'll reserve guest_unavailable` — related hits
(Expedia captcha misroute, Steel auth) but **novel** for this free-cancel →
skip-reserve → Sign-in chain.

## Solution

Partial (gate, not the skip itself):
- Auth assistance numbered as waterfall step 8; guest hard-gate requires an
  observed guest CTA attempt (`283e38a81` and follow-up NBSP regex fix).
- Dump-faithful check: `observe_page_text(msg46)` now sets `guest_option_seen`
  and blocks assistance until guest is attempted.

Still open for the skip/derail:
- When pinned on-host and free-cancel inventory is missing, the agent must not
  treat Sign in as recovery; it should filter/search refundable rates on the
  same host (or fail without auth_assistance). Needs prompt/harness fix + exact
  `scripts/run-bench --local browser-hotel-booking` outcome proof before closing.

## Human feedback

User rejected framing that `guest_unavailable` was why the agent skipped guest
checkout — asked for `/rca` of why the agent did not attempt guest checkout.
Correct: `guest_unavailable` is a gate default, not the model's skip cause.

## Reusable lesson

Do not blame an auth hard-gate default for a model skip — reconstruct the dump
and prove whether the guest CTA was visible and which tool the LLM called instead.
