---
id: 2026-09-09-ai-composer-submit-false-email-send-write-lock
date: 2026-09-09
title: ChatGPT Send prompt after an image upload falsely triggered email_send write lock
surface: agents
component: browser_tools.write_lock.is_email_send_button
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/browser_tools/write_lock.py::is_email_send_button — leftover substring "send" classified ChatGPT "Send prompt" as outbound email
symptoms:
  - "Clicking <button \"Send prompt\">"
  - "send a chat message with an uploaded image to ChatGPT requesting an image edit"
  - "Write lock triggered: email send detected"
  - "Rose wants to send a chat message with an uploaded image to ChatGPT"
  - "https://chatgpt.com/"
tags:
  - write-lock
  - email-send
  - chatgpt
  - ai-composer
  - send-prompt
sources:
  - agent 37b7bb31-8db5-4c7e-806d-d31b7891106f
repro: agents/tests/blackbox/spawn_browser_agent_v3.blackbox.py::test_write_lock_email_send_excludes_ai_composer_submit
status: fixed
---

## Problem

Agent `37b7bb31-8db5-4c7e-806d-d31b7891106f` was editing three photos on
ChatGPT. After uploading `sms-inbound-0.png` and typing the tattoo-edit
prompt, it clicked `<button "Send prompt">` at `https://chatgpt.com/`. The
harness parked the run on write_lock approval:

`Rose wants to send a chat message with an uploaded image to ChatGPT
requesting an image edit`.

The user had to approve a prompt submit that is not an outbound email,
purchase, return, or social post.

Archive searches: `write lock ChatGPT image send approval`,
`false write lock email_send image upload`, `heartbeat timeout killing early
browser`. This is a relative of
`2026-08-10-eventim-marketing-opt-in-false-email-send-write-lock` (same
classifier, leftover `"send"`), not a recurrence — the Eventim exemption was
marketing opt-in, not AI composers.

## Diagnosis

1. Runtime: message 497 `Clicking <button "Send prompt">` on chatgpt.com,
   then message 500 `request_user_approval` with
   `writeLockNotification.action = send a chat message with an uploaded
   image to ChatGPT requesting an image edit`.
2. Classifier: `is_email_send_button` treats any leftover label containing
   `"send"` as outbound mail after OTP / resend / marketing exemptions.
   Local pre-fix: `is_email_send_button("Send prompt")` is `True`.
3. ChatGPT is not a social domain, so the click did not take the
   `social_post` path. The email_send contract is "message to a third
   party"; an in-product AI composer submit is not that.
4. Step 5a: why was this possible? The classifier is label-only and has no
   concept of in-product AI composers. Siblings: Claude "Send message",
   Gemini "Submit", ChatGPT bare "Send".
5. Next-deeper unifies that failed to be coherent: (a) drop leftover
   `"send" in normalized` — existing fail-closed positives
   (`Send hotpot photos`, `Send new message`, CRM `Send`) require it;
   (b) lock leftover send only on mail hosts — the CRM compose test
   (`https://crm.example.com/outreach/compose`) must still lock. The
   designed pattern is fail-closed leftover send plus content exemptions
   (OTP, resend, marketing). AI composer is the next exemption in that
   pattern, not a host-positive rewrite.

Local owning-boundary repro (pre-fix True / AssertionError, post-fix False):

```bash
cd agents && source venv/bin/activate
PYTHONPATH=".:tests/blackbox" python -c "
from browser_tools.write_lock import is_email_send_button
print(is_email_send_button('Send prompt'))
"
```

## Solution

Content exemption for `send prompt` / `submit prompt` (never email), plus a
host-scoped exemption for generic composer labels (`Send`, `Send message`,
`Submit`) on the four assistant hosts this class actually uses
(chatgpt.com, chat.openai.com, claude.ai, gemini.google.com). `Send email`
still locks, including on chatgpt.com. `_evaluate_element_text_write_lock`
now passes `current_url` into the classifier. Worker logs for the exact
`Write lock triggered: email send detected` line were not recoverable
(ClickHouse DNS NXDOMAIN from this environment); the click title, approval
payload, and local classifier repro close the boundary.

Cemented in `test_write_lock_email_send_excludes_ai_composer_submit`.
10k-agent behavior: O(1) substring / host suffix checks per click; no
shared state.

## Human feedback

User asked to RCA agent 37b7bb31 and add a new test case that sending an
image to ChatGPT must not trigger write lock.

## Reusable lesson

Never classify an in-product AI composer submit ("Send prompt", "Send" on
chatgpt.com / claude.ai) as outbound email — leftover substring "send" is
not a third-party send.
