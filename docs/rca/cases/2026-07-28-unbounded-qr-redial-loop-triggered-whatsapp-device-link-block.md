---
id: 2026-07-28-unbounded-qr-redial-loop-triggered-whatsapp-device-link-block
date: 2026-07-28
title: An unbounded QR re-dial loop sent 831 pairing requests in 14 hours and got the WhatsApp account blocked from linking devices
surface: mac-app
component: whatsapp-pairing
classification: our-bug
problem_class: other
first_bad_boundary: mac-app/scripts/whatsapp-live.ts — an unbounded `while (!connected)` re-dial loop, one fresh device-link request per ~60s
symptoms:
  - '"Can''t link new devices right now, try again later" on the phone'
  - 831 pairing requests generated over 14 hours
  - re-scanning the QR code never succeeds until the block clears (hours)
tags:
  - whatsapp
  - pairing
  - rate-limit
  - unbounded-loop
  - anti-abuse
sources:
  - memory:project_whatsapp_pairing_rate_limit
repro: none-recorded
status: fixed
---

## Problem

On 2026-07-28 the WhatsApp live-pairing harness
(`mac-app/scripts/whatsapp-live.ts`) was left running unattended overnight. Its
unbounded `while (!connected)` re-dial loop generated **831 pairing requests over
14 hours** — roughly one per 60s. WhatsApp responded by temporarily blocking the account
from linking devices; the phone shows "Can't link new devices right now, try again later".

## Diagnosis

Every QR cycle is a **fresh device-link request**. A loop written to "keep a fresh code on
screen" therefore looks benign locally but is indistinguishable from a pairing
brute-force at the provider's scale, and it triggered an account-level anti-abuse
throttle.

The resulting block is not a bug in our integration and not a phone problem: it is
account-level, and no amount of re-scanning helps until it clears (hours). The owned
defect is the unbounded loop with no cycle cap and no backoff — a harness that only ever
holds a human-attended window was allowed to run as a background daemon.

## Solution

The loop is now capped by `MAX_QR_CYCLES` (default 10, roughly a 10-minute window,
overridable via `WHATSAPP_MAX_QR_CYCLES`), with linear backoff between re-dials (3s → 30s),
and it exits with a `gave_up` status instead of hammering.

Operational rule that comes with it: start the pairing harness only when a human is
actually at their phone ready to scan. It is a short attended window, never a background
daemon, and `WHATSAPP_MAX_QR_CYCLES` must never be raised for an unattended run.

## Human feedback

None recorded.

## Reusable lesson

Any loop that re-issues a third-party auth/pairing request must be cycle-capped with
backoff — an unattended "keep the code fresh" loop reads as brute-force and earns an
account-level block.
