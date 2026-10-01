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

### Follow-up: real-browser misfire corpus (21 distinct mistakes)

The resend bug was one instance of a wider problem: the gate classified
whatever text it could scrape near the action, not the control the action
actually commits. `agents/tests/blackbox/write_lock_misfire.blackbox.py`
drives the real `_execute_*` gate paths against headless Chromium pages from
`agents/tests/fixtures/write_lock_misfire_corpus.json`. Each of the 21 cases
exposes a different mistake, and all 21 misfired before the fix. Fixes, grouped
by root cause:

- **Resolve the committed control, not nearby text**
  (`browser_tools/write_lock_probe.py`).
  - Index clicks use Chrome's accessible name, so hidden descendants, inline
    markup and machine ids no longer change the label.
  - Coordinate clicks and Enter run a live CDP probe that hit-tests through
    shadow roots.
  - Clicking into an editable field never commits. A hyperlink cannot post
    or send, but it still gates purchase and return, because page script can
    turn a link click into a charge. A nameless control reads its own ids and
    wrapper only, not a neighbour's label.
  - Enter follows HTML implicit submission: an input inside a form submits
    the form's default button, and a textarea or contenteditable never
    submits.
  - A typed `\n` in `input_text` is gated the same way as pressing Enter.
- **Grammar** (`browser_tools/write_lock.py`).
  - Purchase phrases and submit verbs match whole words, so
    `Marketplace orders` and `Show 12 posts` stay unlocked.
  - `Pay <amount>` counts as a purchase commit.
  - `Cancel send` / `Undo send` are not sends.
  - Auth-flow URLs are detected by word, so `r/AuthorsGuild` is not `auth`.
- **Payment fields**: matched on card tokens plus the accessible label.
  Billing-address fields and non-card expirations are no longer treated as
  card fields; a card field named only by its `<label>` now is.
- **Approval scope** (`service_actions.py`).
  - Registrable domains are ccTLD-aware, so a grant on `argos.co.uk` does
    not unlock `sainsburys.co.uk`.
  - A site purchase unlock never covers `return`.

The suite also runs guard cases that must still lock (link-styled purchase
and return commits, a nameless icon button, Enter into a field whose form's
default button is `Place order`). It checks held-out grammar and domain
probes, and fails if any corpus label or id appears in classifier source code.

The full agents blackbox run also exposed a cross-suite leak. A benchmark
test exported `ROSE_DISABLE_CODE_AGENT_VERIFIER=1` and never restored it, so
`spawn-claude-code-agent` failed only when run after it. The runner now
restores `os.environ` after each domain (`agents/tests/unit/test_blackbox_runner.py`).

## Human feedback

User reported the resend-verification-code approval as a false trigger, and
asked to add it to the classifier tests, expand the classifier corpus with 100
more differentiated likely-failure cases, and iterate until fixed.

## Reusable lesson

Never substring-match an action verb against DOM identifiers. Split ids into
words and require the verb at a word start, or `send` inside `resend` fires.
