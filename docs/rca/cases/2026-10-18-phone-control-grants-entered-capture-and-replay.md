---
id: 2026-10-18-phone-control-grants-entered-capture-and-replay
date: 2026-10-18
title: Phone control grants and input entered generic request capture and replay
surface: back-end
component: fetch-capture
classification: our-bug
problem_class: other
first_bad_boundary: back-end/src/providers/fetchCapture.ts isCredentialExchange
symptoms:
  - phone capabilities and credentials leaked into capture
  - physical phone operations must never replay from fixtures
tags:
  - phone-harness
  - credential-redaction
  - outbound-replay
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: back-end/src/tests/blackbox/phone-harness-capture.blackbox.ts
status: fixed
---

## Problem

Before live password testing, a synthetic canary passed through the real outbound
capture and capture HTTP endpoint. The captured response retained the control URL
and token, and the request retained typed input. The permanent regression failed
with `phone capabilities and credentials leaked into capture` on the old code.
No real password was used in this reproduction.

Command, from back-end: `bash scripts/run-blackbox-tests.sh phone-harness-capture`.
Pre-fix run: `1792350300-2224615-1003`, exit 1. The unchanged test passed after
the fix in run `1792350512-2257008-17980`, exit 0. Both logs are retained in the
workspace's gitignored `.context/phone-harness/` evidence directory.

## Diagnosis

Critical path: provider request and response -> installed fetch wrapper ->
credential-exchange classification -> capture HTTP endpoint and replay cache.
The provider response must retain the private grant for its authorized caller;
the test confirms that boundary is correct. The first bad boundary was the
capture classification: it recognized OAuth exchanges but not the new phone
provider. Consequently generic capture retained capability paths and bodies,
and generic replay could substitute an old result for a physical operation.

The owned failure class is capture policy for capability-bearing, stateful
provider traffic. It is not an observability gap: the capture itself disclosed
the private data. A provider-wide metadata-only policy fixes creation grants,
control input, screen reads, failures, and replay together. No prompt change is
required.

## Solution

Classify the configured HTTPS Phone Harness origin as a private exchange.
Record only timing, method, status and a constant metadata URL; exclude headers,
bodies, response bodies, exception details, opaque URL paths and query strings.
Reuse the existing private-exchange branch to disable replay, preserving live
operation execution. The test asserts a private response reaches its caller,
canaries do not reach capture or replay keys, and repeated inputs execute twice.

The normal backend runner discovers the test by its `.blackbox.ts` name; deploy
Step 4a runs that runner under coverage. Existing capture and provider unit
regressions also passed (81 tests). At 10k agents classification performs constant
work per exchange, stores no private payload, and introduces no shared lock,
subscription or per-user fan-in.

A follow-up exercised the Rose API hop with the same canary mechanism. Run
`1792351893-2491876-3382` failed because `/api/iphone/.../operations` retained
request and response bodies even though direct provider traffic was private.
The unchanged expanded test passed in `1792351933-2498388-20750` after classifying
the exact phone API path and subpaths as private too. It now asserts six real
upstream calls, including repeated first-party inputs, and private replay keys
for both hops. The existing capture unit regressions also passed (2 tests).

## Human feedback

None recorded.

## Reusable lesson

Exclude stateful capability-bearing provider exchanges from payload capture and replay before using real credentials.
