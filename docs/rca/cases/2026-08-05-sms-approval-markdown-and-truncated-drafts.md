---
id: 2026-08-05-sms-approval-markdown-and-truncated-drafts
date: 2026-08-05
title: Approval SMS showed raw Markdown asterisks and a mid-sentence truncated email draft
surface: cross
component: message-person-sms-approval
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: agents/domains/message_person approval text used Markdown labels that SMS/iMessage cannot render, and helpers.llm.call_llm (non-streaming) ignored finish_reason=length so max_tokens-truncated drafts reached approval/SMS
symptoms:
  - "Approval needed: Rose wants to send an **Email**"
  - "**To:**"
  - "Please share the"
  - double asterisks not bolding in iMessage
  - truncated email draft in approval SMS
tags:
  - sms
  - imessage
  - markdown
  - approval
  - message-person
  - truncate
  - max-tokens
  - finish-reason
  - write-lock
sources:
  - agent eab955b6-54bd-498a-a115-632851a2bddd
repro: back-end/src/tests/unit/sms-approval-plain-text.test.ts + agents/tests/blackbox/message_person.blackbox.py + agents/tests/blackbox/llm.blackbox.py + back-end/src/tests/blackbox/send-sms.blackbox.ts
status: fixed
---

## Problem

A Rose agent asked for approval to send an email. The SMS/iMessage read:

```
Approval needed: Rose wants to send an **Email**
**To:** sr-team@a16z.com ...
**Message:**
Hi Speedrun Team,
...
Please share the
Reply to approve, or say "no" to cancel.
```

Two user-visible defects:

1. Literal `**` markers (Markdown bold) showed in iMessage instead of bold text.
2. The drafted email body was truncated mid-sentence (`Please share the`).

Runtime evidence (prod DB):

- `AgentAttentionRequest` `cmsfh58mn00l1ljkky1jbqus0` for agent `eab955b6-54bd-498a-a115-632851a2bddd` stored `question` length 630 with `**` markers and Message ending at `Please share the` — so truncation happened **before** SMS formatting.
- A post-deploy retry of the same tool produced a second truncated draft ending at `Please`.

Archive searches run:

- `approval needed email asterisks bold SMS truncate`
- `double asterisks iMessage markdown approval message truncated`
- `SMS markdown formatting approval email message`
- `markdown SMS approval plain text asterisks`
- `message_person approval SMS formatting`

Result: **novel** (related SMS/approval cases exist; none cover Markdown-on-SMS or non-streaming `call_llm` length escalation).

## Diagnosis

Critical path:

`message_person.generate_message_activity` → `call_llm(max_tokens=1024)` → `_request_approval` Markdown question → `request_user_approval_direct` → write_lock SMS notify → `formatPaymentApprovalBody` → Surge → iMessage

Binary search:

1. **DB attention question already truncated + Markdown** → not a carrier truncate; not FE-only.
2. **Approval formatter** hardcodes `**Email**` / `**To:**` in `handler._request_approval` — first-bad for asterisks at the agent source; SMS sink also failed to strip Markdown.
3. **`call_llm` (non-streaming)** returns `finish_reason` but unlike `call_llm_structured_streaming` did **not** escalate on `finish_reason=length`. With `max_tokens=1024`, drafts truncated mid-sentence twice. `generate_message_activity` ignored `finish_reason` and shipped the truncated body to approval.

Deepest owned cause: harness contract mismatch — user-facing SMS path assumed Markdown/FE rendering and assumed non-streaming LLM calls never truncate, while the streaming path already had length escalation.

## Solution

1. **Plain-text SMS sink** — `stripMarkdownForSms` in `writeLockBody.ts`; apply in `formatPaymentApprovalBody` so every write_lock SMS (message_person, browser locks) drops `**`/`*` emphasis. Tool-approval natural-language path still never uses the 900-char payment truncate budget.
2. **Plain-text approval source** — `build_message_approval_question` emits `To:` / `Email` labels without Markdown (SMS-bound string).
3. **Non-streaming length escalation** — `call_llm` retries once at `max_tokens=32768` when `finish_reason=length` (parity with streaming), before caching.
4. **message_person guard** — raise `max_tokens` to 4096; refuse to return a draft when `finish_reason` is still `length` after escalation.

Cemented repros (fail pre-fix / pass post-fix):

- `npx tsx back-end/src/tests/unit/sms-approval-plain-text.test.ts` — pre-fix 3/3 FAIL (missing strip + leaked `**`); post-fix 3/3 PASS
- message_person + llm blackbox cases above
- send-sms blackbox `notify write_lock strips markdown and keeps full draft`

10k-agent behavior: per-approval SMS formatting is O(1) string work on the notify path; no new fan-in, subscriptions, or shared mutable state.

## Human feedback

None recorded beyond the original report: no incompatible stylings for text messages (no visible `**` unless bold works — iMessage does not render Markdown, so strip); message-to-send must not be truncated; cement regression tests.

## Reusable lesson

Never emit Markdown into SMS/iMessage sinks, and never ship LLM output to user approval without honoring finish_reason=length escalation on every call_llm path (streaming and non-streaming).
