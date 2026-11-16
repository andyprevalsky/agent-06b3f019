---
id: 2026-11-06-blackbox-runners-loaded-real-vapi-key-and-dialed-real-numbers
date: 2026-11-06
title: Backend blackbox/coverage runs placed real Vapi/Twilio PSTN calls because the isolated backend loaded the real VAPI_PRIVATE_KEY
surface: back-end
component: blackbox-runner-phone-env
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/scripts/blackbox-phone-env.sh (sourced by run-blackbox-tests.sh and run-coverage.sh) never overrode VAPI_PRIVATE_KEY / VAPI_API_BASE_URL, so the isolated backend's domains/vapi/config.ts resolved https://api.vapi.ai with the real key from back-end/.env
symptoms:
  - "POST https://api.vapi.ai/call"
  - "+442079460958"
  - testCall_propertiesOnlySchemaAndInternationalPhone places a real call
  - blackbox tests pollute Vapi call history and hide real calls
  - "Refusing to place calls: backend Vapi/Twilio upstream is not the loopback fake"
tags:
  - vapi
  - twilio
  - blackbox
  - coverage
  - real-side-effect
  - fake-upstream
sources:
  - task descend-failed-neverrun-20261106 infra cluster I-14 (branch rca/i-14-20261106)
repro: back-end/src/tests/blackbox/vapi.blackbox.ts (guard -- backend Vapi/Twilio upstream is the loopback fake)
status: fixed
---

## Problem

Every backend blackbox and coverage run, on any devbox or deploy VM, sent
`POST https://api.vapi.ai/call` with the real `VAPI_PRIVATE_KEY`. The
`testCall_propertiesOnlySchemaAndInternationalPhone` case dialed
`+442079460958` (Ofcom drama range) for real: 1,861 such calls made up 93–95%
of both outbound pool numbers' Vapi history ($0, but it buried real calls
during another RCA and can hurt caller reputation). The `+10000000000` cases
and `GET /call/nonexistent-call-id` / `test-poll-id` also reached the real API.

Local repro without placing a call (a `NODE_OPTIONS=--import` probe that records
and blocks fetches to api.vapi.ai/api.twilio.com):
`I14_BLOCK_LOG=… NODE_OPTIONS="--import file:///tmp/i14-preload/block-real-phone.mjs" CONDUCTOR_WORKSPACE_NAME=rca-I-14 CONDUCTOR_PORT=4795 ROSE_USE_SYSTEM_PG=true bash scripts/run-blackbox-tests.sh vapi`
on the unchanged revision recorded 7 real-host attempts, including
`{"method":"POST","url":"https://api.vapi.ai/call","to":"+442079460958"}`.
The suite still passed (its assertions accepted 200/4xx/5xx), so nothing
flagged the side effect.

## Diagnosis

1. `domains/vapi/config.ts` resolves `VAPI_BASE_URL = VAPI_API_BASE_URL ?? 'https://api.vapi.ai'`
   and `VAPI_PRIVATE_KEY` at import.
2. The runners isolate DB, Temporal, SMS, WhatsApp and Twilio Verify, but
   `blackbox-phone-env.sh` (whose header claims no production credentials are used
   for phone fixtures) set only `CLOUD_IPHONE_*`. dotenv then loaded the real key.
3. Capture/replay (`fetchCapture.ts`) records but does not fake Vapi; each create
   body differs, so replay never hits and the request goes to the network.
4. The boundary cases filtered captures on `api.vapi.ai` and early-returned when
   absent, and status checks accepted any outcome, so the tests could neither
   detect a real dial nor fail without one.

Deepest owned cause: the test environment contract allowed a real provider
credential to reach a side-effecting provider; only `phone-hold` (in-process)
pointed Vapi at a fake.

## Solution

- `domains/vapi/routesBlackboxFakeUpstream.ts`: loopback fake Vapi/Twilio REST
  upstream mounted at `/api/test/fake-phone-upstream` only when
  `BLACKBOX_TEST_CAPTURE_OUTBOUND=1`; bounded request log (`/__requests`) and
  `/__status` reporting whether the effective Vapi/Twilio base URLs route to it
  with the fake key. Responses come from `fakePhoneUpstreamResponder.ts`, now also
  used by the phone-hold `FakeUpstream` (one fake, two harnesses).
- `blackbox-phone-env.sh: export_blackbox_phone_upstream_env <port>`, called by
  both runners once the backend port is known, sets `VAPI_API_BASE_URL`,
  `TWILIO_API_BASE_URL` to that fake and `VAPI_PRIVATE_KEY=vapi-blackbox-key`,
  overriding back-end/.env.
- `vapi.blackbox.ts`: a guard runs first and aborts the file before any call is
  attempted unless the backend's upstream is the fake (protects reused dev/deploy
  backends too). Call cases now require 200 + a fake call id and assert the exact
  request the fake received (normalized numbers, schema, Bearer auth); boundary
  cases no longer early-return.

Red/green: with the new guard and the old runner env, the guard failed with
`vapi=https://api.vapi.ai, twilio=https://api.twilio.com, fakeKey=false` and
no case ran; with the fix, vapi 18/18 and phone-hold pass with 0 blocked
real-host attempts. 10k-agent behavior: test-only route, absent in production
(capture flag off); request log bounded at 1,000 entries.

## Human feedback

None recorded.

## Reusable lesson

Point every side-effecting provider at a loopback fake in the test runner's environment and make the suite refuse to run unless the backend's effective upstream is that fake; recording or replaying outbound traffic does not stop a real side effect.
