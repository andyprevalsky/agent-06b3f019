---
id: 2026-11-06-outbound-caller-pool-overlaps-benchmark-callee-number
date: 2026-11-06
title: Outbound caller-ID pool contained the phone-call-payment benchmark callee number, so the call dialed itself
surface: back-end
component: vapi-outbound-call
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/vapi/config.ts OUTBOUND_PHONE_NUMBER_POOL listed +14159416744 (2fe93786), the phone-call-payment benchmark's answering line, as an outbound caller ID
symptoms:
  - "outboundPhoneCall from +14159416744 to +14159416744"
  - "inboundPhoneCall caller=+14159416744 on phone number 2fe93786 exceeded-max-duration"
  - "phone-call-payment caller ID equals the benchmark callee number"
  - "benchmark callee numbers must never be outbound caller IDs"
tags:
  - vapi
  - phone-callee
  - outbound-call
  - caller-id
  - exclusive-resource
sources:
  - benchmark run descend-failed-neverrun-20261106 batch 2 epoch 2 phone-call-payment r3 (cluster I-13)
  - task phone-call-payment
repro: back-end/src/tests/unit/vapi-outbound-number.test.ts
status: fixed
---

## Problem

In batch 2 epoch 2 `phone-call-payment` r3, Rose's outbound leg was placed from
`+14159416744`. That is also the callee number the benchmark had just attached
its florist persona to. Vapi's read-only call list for phone number `2fe93786`
shows the outbound leg at 2026-11-06T18:14:45Z and its own inbound leg one
second later. The inbound leg ended `exceeded-max-duration` at the persona's
150-second cap. The same number was the second entry in the hard-coded
`OUTBOUND_PHONE_NUMBER_POOL` (since #102) and the `phone-call-payment` entry in
`BENCHMARK_CALLEE_PHONE_NUMBER_IDS`. Since 2026-09-03, 17 benchmark calls dialed
the callee from itself. Production user calls draw from the same pool, so half
of them showed `+14159416744` as caller ID, and a recipient calling back reached
no assistant or a benchmark persona.

## Diagnosis

`service.ts:getRandomPhoneNumber` picks any `OUTBOUND_PHONE_NUMBER_POOL` entry.
`agents/benchmarks/phone_callee.py` reserves `2fe93786` as the
`phone-call-payment` callee through `BENCHMARK_CALLEE_PHONE_NUMBER_IDS` and
attaches a persona assistant to it for the session. Two roles of one exclusive
resource, outbound caller ID and inbound benchmark answering line, were
configured independently. The number is the benchmark's answering line, so it
should never have been a caller ID.

## Solution

`+14159416744` (`2fe93786`) is removed from `OUTBOUND_PHONE_NUMBER_POOL` in
`back-end/src/domains/vapi/config.ts`, with a one-line comment saying why. The
pool keeps `+14154498445`, whose inbound assistant is the intended callback
handler. Picking and placement are otherwise unchanged.

Regression: `back-end/src/tests/unit/vapi-outbound-number.test.ts` (backend
unit suite) asserts that no pool id is the known phone-call-payment callee id or
any id configured in `BENCHMARK_CALLEE_PHONE_NUMBER_ID(S)`, parsed as
`phone_callee.py` does. It fails on the previous pool. An earlier candidate
(reserved-callee filter plus a self-dial 409) was replaced by this simpler fix
at the owner's request.

## Human feedback

Andy (2026-11-08): remove the benchmark callee from the outbound pool instead of
adding exclusion and self-dial logic.

## Reusable lesson

A benchmark answering line must never also be a production caller ID; keep the two sets disjoint in configuration and pin that with a test.
