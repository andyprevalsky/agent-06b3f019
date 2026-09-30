---
id: 2026-09-30-camelcase-resend-id-false-email-send-write-lock
date: 2026-09-30
title: Target "Didn't get a code?" link id showResendMessageLink falsely triggered email_send write lock
surface: agents
component: browser_tools.write_lock.is_email_send_button
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/write_lock.py::is_email_send_button — leftover substring "send" matched inside the camelCase DOM id showResendMessageLink
symptoms:
  - "Clicking <a \"Didn’t get a code?\">"
  - "Rose wants to resend the Target account verification code on Target"
  - "Resend account verification code"
  - "Write lock triggered: email send detected"
  - "showResendMessageLink"
tags:
  - write-lock
  - email-send
  - resend
  - otp
  - target
  - dom-identifier
sources:
  - agent f1ef359f-823f-44ac-9753-b6894d328836
  - agent eaa41165-59c2-5cec-b75b-f17d84c7ac99
repro: agents/tests/blackbox/write_lock_email_send.blackbox.py::test_prod_incident_target_resend_link_passes_click_gate
status: fixed
---

## Problem

Agent `f1ef359f-823f-44ac-9753-b6894d328836` ("buy me a tray from target")
created a Target account and landed on the OTP dialog. Its browser agent
clicked `<a "Didn’t get a code?">` and the run parked on an approval:
`Rose wants to resend the Target account verification code on Target`
(`trigger_type: generic_write`). The user rejected it, which killed the
browser (`write_lock_rejected`).

## Diagnosis

1. Runtime: message 241 `Clicking <a "Didn’t get a code?">`, message 244
   `request_user_approval` with the resend notification.
2. The archived write-lock notification LLM call (`llm/1875317e22b4`, R2
   trace archive) records the click-gate result:
   `approval_type: email_send`, `element_text: "Didn’t get a code?\nshowResendMessageLink"`.
   The id attribute is part of the click signal.
3. `is_email_send_button` exempts a resend only when a line *starts* with
   `resend`, then locks on any leftover substring `send`.
   `showresendmessagelink` contains `send`, so it locked. Local pre-fix:
   `_evaluate_element_text_write_lock(...)` returned `needs_write_approval`.
4. Why was this possible? The classifier matched raw substrings against
   machine identifiers and visible labels alike. Siblings in the same class
   (45 of 50 new FP-risk corpus cases locked pre-fix): `resendCodeLink`,
   `resend_sms_code`, `Didn't get the email? Resend message`, `Godsend`,
   `Send code`, `Send magic link`, `Send password reset email`,
   `Send me a text when my order ships`.

Worker logs were not recoverable: `CLICKHOUSE_ENDPOINT`
(`szzib43yjj.us-east-1.aws.clickhouse.cloud`) is NXDOMAIN on public DNS.
The R2 LLM dump closed the boundary instead.

## Solution

`is_email_send_button` now classifies a word-split form of each signal
(`_action_words`: camelCase / snake / kebab split, `re-send` → `resend`). A
send is a word *starting* with `send` (`send`, `sendBtn`, `compose-send`), so
`resend` / `godsend` / `showResendMessageLink` are not sends. Same class,
same fix:

- one-time-code exemption also covers bare `code` requests (`Send code`,
  `Text me a code`, `Send code to •••-7432`) with a bounded tail, so
  `Send code snippet` and `Send discount code to a friend` still lock;
- sign-in / reset / verification deliveries to the account (`magic link`,
  `password reset`, `verification email`);
- `send me …` is removed before the leftover-send test (replaces the
  enumerated marketing opt-in list), so `Send me a copy and send` still locks.

Cemented in `agents/tests/blackbox/write_lock_email_send.blackbox.py` +
`agents/tests/fixtures/write_lock_email_send_corpus.json` (incident + 50
FP-risk + 50 FN-risk + generated held-out ids). The old assertion
`is_email_send_button("alt-action-resend")` was the same bug class and now
asserts `False`, with `alt-action-send` asserting `True`.

10k-agent behavior: O(signal length) regex per click, no shared state.

## Human feedback

User reported the resend-verification-code approval as a false trigger, and
asked to add it to the classifier tests, expand the classifier corpus with 100
more differentiated likely-failure cases, and iterate until fixed.

## Reusable lesson

Never substring-match an action verb against DOM identifiers. Split ids into
words and require the verb at a word start, or `send` inside `resend` fires.
