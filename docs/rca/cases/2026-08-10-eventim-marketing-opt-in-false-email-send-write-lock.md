---
id: 2026-08-10-eventim-marketing-opt-in-false-email-send-write-lock
date: 2026-08-10
title: Eventim marketing opt-in checkbox falsely triggered email_send write lock
surface: agents
component: browser_tools.write_lock.is_email_send_button
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/write_lock.py::is_email_send_button — substring "send" matched marketing opt-in checkbox labels
symptoms:
  - "Write lock triggered: email send detected"
  - "Send me info about other shows by this organizer"
  - "Expected attention kind payment_approval, observed write_lock"
  - "approval_type\": \"email_send\""
tags:
  - eventim
  - write-lock
  - email-send
  - marketing-opt-in
  - browser-1015-eventim-request-card
sources:
  - agent 317bd635-7f07-4afb-acee-cab8e99e3413
  - commit bafc05068
  - PR #948
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_write_lock_email_send_excludes_marketing_opt_in_controls
status: fixed
---

## Problem

`browser-1015-eventim-request-card` failed with
`Expected attention kind payment_approval, observed write_lock` after ~461s.
Agent `317bd635-7f07-4afb-acee-cab8e99e3413` reached Eventim checkout payment
fields, then clicked the marketing checkbox label
`Send me info about other shows by this organizer`. Worker logged
`Write lock triggered: email send detected` and
`approval_type=email_send`, parked the agent on write_lock approval, and never
called `request_payment_card`.

## Diagnosis

1. Runtime: write-lock click check on
   `element_text="Send me info about other shows by this organizer"` at
   `https://checkout.eventim.us/?afflky=1015Folsom`.
2. Classifier: `is_email_send_button` treats any label containing `"send"` as an
   outbound email send (after OTP/resend exemptions only).
3. Marketing opt-in asks the merchant to email the shopper later; it is not an
   agent-composed outbound send. The false positive returned the browser agent
   to the workflow for write_lock approval, so the payment-boundary bench saw
   `write_lock` instead of `payment_approval`.
4. Archive search for these symptoms found no prior case (novel relative of the
   OTP/resend email_send exemptions).

Local owning-boundary repro (pre-fix True, post-fix False):

```bash
cd agents && source venv/bin/activate
python -c "from browser_tools.write_lock import is_email_send_button; \
print(is_email_send_button('Send me info about other shows by this organizer'))"
```

## Solution

Added content-based `MARKETING_OPT_IN_PATTERNS` / `_is_marketing_opt_in_action`
exemption in `is_email_send_button`, parallel to the one-time-code exemption.
Ordinary `"Send"` / `"Send email"` / `"Send message"` controls still lock; a
neighbouring real send in a multi-line label still locks.

Cemented in
`test_write_lock_email_send_excludes_marketing_opt_in_controls`.
10k-agent behavior: O(1) substring checks per click label; no shared state.

## Human feedback

None recorded. User redirected from full daily `/descend` to focus on getting
Eventim to pass via `/sync` + bench rerun.

## Reusable lesson

Never classify receive/opt-in labels ("Send me info…", "Email me about…") as
outbound email_send write locks — only agent-composed send controls.
