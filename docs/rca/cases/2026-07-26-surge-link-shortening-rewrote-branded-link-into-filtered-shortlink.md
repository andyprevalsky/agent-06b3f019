---
id: 2026-07-26-surge-link-shortening-rewrote-branded-link-into-filtered-shortlink
date: 2026-07-26
title: Surge's default link shortening rewrote our branded deep link into a srgv.co shortlink that carriers filtered
surface: back-end
component: sms-surge-provider
classification: configuration-error
problem_class: other
first_bad_boundary: `sendSms`/`sendMms` — they left Surge link-shortening at the account default instead of disabling it per request
symptoms:
  - "Surge dashboard shows Failed / message_filtered"
  - agent_started, completion, auth, and agentcard link SMS never arrive
  - branded `roselabs.ai/?agent-id=…` link rewritten to a generic `srgv.co` shortlink
  - sendSms reports success while the message is silently dropped
tags:
  - sms
  - surge
  - link-shortening
  - carrier-filtering
  - deliverability
sources:
  - PR #902
  - memory:project_surge_link_shortening_carrier_filter
repro: back-end/scripts/repro-surge-link-shortening.ts
status: fixed
---

## Problem

Every outbound SMS containing a link failed to arrive: `agent_started`,
completion, auth, and AgentCard link messages all went missing. The Surge
dashboard showed the true disposition — `Failed / message_filtered`. Our own logs
showed nothing wrong, because `sendSms` returned `success` as soon as Surge
accepted the POST.

## Diagnosis

Surge's account-level default rewrites links in outbound bodies through its own
shortener, so our branded `roselabs.ai/?agent-id=…` deep link was transmitted as a
generic `srgv.co` shortlink. Carriers treat generic shortener domains as
potentially unwanted or malicious and silently drop those messages, so the failure
was invisible at the send boundary and complete at the handset. Two owned causes
stack here: we never overrode a provider account default that mutates our payload,
and our send path equated "provider accepted the HTTP POST" with "message
delivered", so there was no signal at all between accept and non-arrival. A live
A/B on the exact failed body confirmed the mechanism: the `srgv.co` variant was
filtered, the branded variant delivered.

## Solution

`sendSms`/`sendMms` now send `settings: { link_shortening: "disabled" }` so the
branded link is transmitted verbatim, cemented by `assertLinkShorteningDisabled`
in `send-sms.blackbox.ts` and by
`back-end/scripts/repro-surge-link-shortening.ts` (fails pre-fix, passes
post-fix). Paired with delivery-receipt ingestion so a future filtering event is
observed rather than inferred from user reports.

## Human feedback

None recorded.

## Reusable lesson

Explicitly override provider account defaults that rewrite your payload, and never
treat a provider's POST acceptance as delivery — check the dashboard/receipt
disposition when messages "send" but never arrive.
