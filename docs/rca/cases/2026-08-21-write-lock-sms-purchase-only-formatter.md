---
id: 2026-08-21-write-lock-sms-purchase-only-formatter
date: 2026-08-21
title: Write-lock SMS formatter only rendered purchase fields
surface: back-end
component: sms-write-lock-body
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/providers/smsSupervisor/writeLockBody.ts::formatWriteLockNotificationBody — purchase-only items/totals path ignored generic_write/message/social_post/payment
symptoms:
  - 'Rose needs your approval for Amazon checkout.'
  - 'generic_write'
  - 'formatWriteLockNotificationBody'
tags:
  - sms
  - write-lock
  - returns
sources:
  - commit 674d04d7313e82938d93aaa2adfbead1d52fc8b0
repro: back-end/src/tests/unit/sms-approval-plain-text.test.ts
status: fixed
---

## Problem

Non-purchase write-lock approvals (returns/`generic_write`, email/`message`,
social_post, payment) texted a hollow body:

```
Approval needed
Rose needs your approval for Amazon checkout.
```

even when the in-app `question` had refund/drop-off, recipients, or payment
details.

## Diagnosis

`formatWriteLockNotificationBody` always used a purchase "checkout" header and
only read `notification.purchase.items` / totals. When `writeLockNotification`
was present for any other `trigger_type`, the rendered approval `question` was
ignored. Secondary: `sanitizeSmsText` mangled emails via domain→label rewrite.

## Solution

Render SMS per `trigger_type`, preserve emails in `sanitizeSmsText`, fall back
to the rendered question when structured details are sparse. Cemented in
`sms-approval-plain-text.test.ts` and send-sms blackbox.

## Human feedback

Andy: fix so all SMSes look right (not purchase-only).

## Reusable lesson

When write-lock notifications gain new trigger_types, update every sink that renders them (approval UI and SMS) — do not leave SMS on a purchase-only formatter.
