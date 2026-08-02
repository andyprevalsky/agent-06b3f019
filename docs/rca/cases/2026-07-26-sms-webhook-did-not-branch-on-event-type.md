---
id: 2026-07-26-sms-webhook-did-not-branch-on-event-type
date: 2026-07-26
title: The SMS webhook ignored the Surge event type, so a delivery receipt was replayed to the supervisor as inbound user text
surface: back-end
component: sms-webhook
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the Surge SMS webhook handler — it processed every payload as an inbound message instead of branching on the event `type`
symptoms:
  - delivery receipt handled as an inbound SMS
  - SMS supervisor receives our own outbound body as user text
  - "message.sent / message.delivered / message.failed events are not classified or recorded"
tags:
  - sms
  - surge
  - webhook
  - delivery-receipt
  - event-routing
sources:
  - PR #902
repro: back-end/scripts/repro-surge-delivery-gap.ts
status: fixed
---

## Problem

Surge posts several event types to the same webhook. Our handler did not
distinguish them, so `message.sent` / `message.delivered` / `message.failed`
receipts were never recorded, and a receipt whose payload carried _our own
outbound body_ was misrouted into the SMS supervisor as if the user had just
texted us that text.

## Diagnosis

The webhook was written against one assumed payload shape — an inbound user
message — and read the body field unconditionally. Because a delivery receipt
echoes the message body, it is structurally indistinguishable from an inbound
message unless the handler reads the event `type` discriminator, which it never
did. Two consequences followed from the same omission: no delivery state was
persisted (so carrier filtering such as `message_filtered` was invisible), and the
agent conversation could be polluted by a self-echo of its own outbound SMS. The
deeper owned cause is consuming a multi-event webhook without dispatching on its
event type first.

## Solution

The webhook now branches on the event `type`, records delivery status for
`message.sent`/`delivered`/`failed`, and alerts on `message_filtered`; receipts no
longer reach the inbound-supervisor path. Cemented by
`back-end/scripts/repro-surge-delivery-gap.ts` (fails pre-fix, passes post-fix)
and by `message.failed`/`message.delivered` receipt-handling coverage in
`sms-webhook.blackbox.ts`. This also closes the observability gap that let
carrier-filtered link SMS go unnoticed.

## Human feedback

None recorded.

## Reusable lesson

Dispatch on a webhook's event-type discriminator before touching its payload — a
delivery receipt echoing your own body will otherwise be replayed as inbound user
input.
