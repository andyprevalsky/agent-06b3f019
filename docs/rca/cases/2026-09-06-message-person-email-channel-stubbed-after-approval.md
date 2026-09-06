---
id: 2026-09-06-message-person-email-channel-stubbed-after-approval
date: 2026-09-06
title: message_person advertised email, got approval, then hard-failed delivery with a stub
surface: agents
component: message-person-email-delivery
classification: our-bug
problem_class: new-tool-or-capability-required
first_bad_boundary: agents/domains/message_person/handler.py _deliver_message — channel==email returned a hard-coded ERROR stub after approval instead of calling Gmail send
symptoms:
  - Email delivery is not available through message_person. The message was approved but was not sent.
  - Failed to send Email to office@toprentacar.bg
  - message_person channel=email
tags:
  - message-person
  - email
  - gmail
  - delivery-stub
  - tool-side-effect
sources:
  - agent 515c4894-62b4-40ae-b463-222608fe9ee2
repro: agents/tests/blackbox/message_person.blackbox.py::test_handler_cold_outreach_email_path
status: fixed
---

## Problem

Agent `515c4894-62b4-40ae-b463-222608fe9ee2` drafted an email via `message_person`
to `office@toprentacar.bg`, the user approved the send, then the tool returned
ERROR titled `Failed to send Email to office@toprentacar.bg` with body
`Email delivery is not available through message_person. The message was approved but was not sent.`

Archive searches (`Email delivery is not available through message_person`,
`message_person email Failed to send`, `gmail send email channel`) found related
cases about planner routing and approval SMS formatting, but **no prior case for
this stub**. Novel incident (relative to iMessage/SMS rewire that left email
unimplemented).

## Diagnosis

Critical path: LLM `message_person(channel=email)` → draft + approval →
`_deliver_message` → (should) Gmail send via `/api/integrations/email/send`.

Binary search: generation and approval succeeded; first wrong output is the
hard-coded stub in `_deliver_message` for `channel == "email"`. Backend
`POST /api/integrations/email/send` already existed and works for the FE.

Step 5a:
1. Why fail? `_deliver_message` returns a stub ERROR for email.
2. Why stub? Commit `325a6a3cb` rewired iMessage/agent_sms delivery but left
   email as unimplemented after earlier `send_email` ghost-tool deletion
   (`5dca2fec7`).
3. Why possible? The tool schema and prompt still advertise `channel=email`, so
   the agent/user path reaches approval with no send transport behind it.
   Deepest owned cause: missing email transport on the same boundary as SMS.

Classification: **our-bug** / **new-tool-or-capability-required** (restore the
deleted Gmail send activity onto `message_person`).

## Solution

- Add `send_email_activity` in `agents/domains/message_person/repo.py` posting to
  `/api/integrations/email/send` with `idempotency_key=tool_call_id`.
- Wire `_deliver_message` email branch to that activity (retry_policy max 1).
- Register activity on the Temporal worker.
- Backend: `sendEmailOnce` wraps Gmail send in `claimToolSideEffect` so Temporal
  completion-loss retries cannot double-send.
- Cement with blackbox tests that fail on the stub and pass after the fix.

10k-agent behavior: per-send HTTP + one ToolSideEffect row keyed by
user/agent/idempotency; no shared fan-in beyond existing Gmail credential lookup.

## Human feedback

None recorded.

## Reusable lesson

Never advertise a transport channel (or take user approval for it) unless the
same tool's delivery path actually calls the provider with Temporal-safe
idempotency.
