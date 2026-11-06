---
id: 2026-11-06-outbound-caller-pool-overlaps-benchmark-callee-number
date: 2026-11-06
title: Outbound caller-ID pool contained the phone-call-payment benchmark callee number, so the call dialed itself
surface: back-end
component: vapi-outbound-call
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/src/domains/vapi/service.ts:getRandomPhoneNumber picked any OUTBOUND_PHONE_NUMBER_POOL entry, including one reserved by BENCHMARK_CALLEE_PHONE_NUMBER_IDS and one equal to the destination
symptoms:
  - "outboundPhoneCall from +14159416744 to +14159416744"
  - "inboundPhoneCall caller=+14159416744 on phone number 2fe93786 exceeded-max-duration"
  - "phone-call-payment caller ID equals the benchmark callee number"
  - "outbound call used benchmark callee number +14159416744 as its caller ID"
  - "No outbound caller number other than the destination"
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
status: mitigated
---

## Problem

In batch 2 epoch 2 `phone-call-payment` r3, Rose's outbound leg was placed from
`+14159416744`. That is also the callee number the benchmark had just attached
its florist persona to. Vapi's read-only call list for phone number `2fe93786`
shows the outbound leg at 2026-11-06T18:14:45Z and its own inbound leg one
second later. The inbound leg ended `exceeded-max-duration` at the persona's
150-second cap. The same number is the second entry in the hard-coded
`OUTBOUND_PHONE_NUMBER_POOL` (since #102) and the `phone-call-payment` entry in
`BENCHMARK_CALLEE_PHONE_NUMBER_IDS`. Since 2026-09-03, 17 benchmark calls dialed
the callee from itself (`outboundPhoneCall` with `customer.number` equal to the
caller). Production user calls draw from the same pool.

The "87 of the last 100 calls are `twilio-failed-to-connect-call`" observation
is unrelated. In the latest 1,000 calls on each pool number, 913 and 948 failed
that way. Every failure targeted one `+4420…` London destination, from both pool
numbers alike, and none were self-dials. All 17 self-dials connected, and the
two legs conversed normally.

## Diagnosis

1. `prepareCall` called `getRandomPhoneNumber()`, which returned
   `OUTBOUND_PHONE_NUMBER_POOL[floor(random * 2)]` without consulting the
   destination or any reservation.
2. `agents/benchmarks/phone_callee.py` reserves `2fe93786` as the
   `phone-call-payment` callee via `BENCHMARK_CALLEE_PHONE_NUMBER_IDS` (also
   loaded by the backend from `back-end/.env`). It attaches a persona assistant
   to that number for the session.
3. So on average half of `phone-call-payment` runs place the call from the
   callee number to itself. The caller ID equals the callee, and that run's
   outbound and inbound legs share one Vapi number.
4. Deepest owned cause: two roles of one exclusive resource (the outbound
   caller ID and the inbound benchmark callee) were configured independently, in
   a code constant and an env mapping. Neither side checked the other. The
   2026-10-07 case enforced callee exclusivity between tasks only.

Production effect: half of real users' outbound calls show `+14159416744` as
caller ID. That number currently has no inbound assistant attached, and benchmark
sessions attach a persona to it. A recipient calling back therefore reaches no
assistant (2026-10-07 external inbound: `call.in-progress.twilio-completed-call`,
no assistant) or a benchmark persona. The other pool number's inbound assistant
("Jamie") is the intended callback handler. So "no pool number may have an
inbound assistant" is the wrong invariant. The correct one is "no pool number
may be a reserved benchmark callee".

Local repro: `cd back-end && DATABASE_URL=postgresql://none:none@127.0.0.1:1/none npx tsx src/tests/unit/vapi-outbound-number.test.ts`.
It drives the real `initiateCall` direct-placement path with `fetch` stubbed and
the random pick forced onto every slot. Pre-fix result: `outbound call used
benchmark callee number +14159416744 as its caller ID`, `# fail 1`. Re-adding
only the reservation, without the destination check, fails with `call dialed
itself: +14159416744`.

## Solution

`back-end/src/domains/vapi/config.ts:reservedCalleePhoneNumberIds` derives
reserved ids from `BENCHMARK_CALLEE_PHONE_NUMBER_IDS` and
`BENCHMARK_CALLEE_PHONE_NUMBER_ID`. `service.ts:selectOutboundPhoneNumber`
then picks randomly among pool numbers that are neither reserved nor equal to
the normalized destination. If no number remains, it refuses with a 409 before
any side-effect claim or provider request. The same choice feeds the direct Vapi
path and the hold-capable Twilio path. The regression is
`back-end/src/tests/unit/vapi-outbound-number.test.ts` (backend unit suite, run
by backend coverage). The `vapi` and `phone-hold` blackbox domains pass with the
local reservation active.

The work per call is O(pool size) plus one env-string split, with no network or
DB access and no shared state, so it is unchanged at 10k agents.

The guard does not reach production while Render lacks the benchmark mapping.
Remaining configuration action: move `phone-call-payment` to a dedicated
benchmark callee number outside the outbound pool, as for the IVR and hold
tasks. Update local `back-end/.env`, the managed project env and the bench app
`BACKEND_ENV_B64`. Otherwise keep the payment callee and remove `2fe93786` from
`OUTBOUND_PHONE_NUMBER_POOL`. Until either change, production calls can still
originate from a number whose callbacks reach a benchmark persona.

## Human feedback

None recorded.

## Reusable lesson

When one phone number can serve as both an outbound caller ID and an inbound benchmark callee, derive the outbound exclusions from the callee reservation and refuse any call whose caller equals its destination.
