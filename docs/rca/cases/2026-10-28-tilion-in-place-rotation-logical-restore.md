---
id: 2026-10-28-tilion-in-place-rotation-logical-restore
date: 2026-10-28
title: Tilion rotate-proxy on a logical browser demanded a checkpoint restore and PAUSED-to-ACTIVE flip that its same-browser or ACTIVE-row result cannot satisfy
surface: back-end
component: back-end/src/providers/browserSessionResume.ts assembleResumeResponseWithTransport; browser/tilion.ts replaceSession
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: browserSessionResume.ts assembleResumeResponseWithTransport required result.validationBrowser for every logical row, but Tilion in-place rotate-ip returns no validation client (worker owns the only CDP socket); then required status PAUSED, which Tilion replacement/reattach never left (they wrote ACTIVE, Kernel writes PAUSED for logical rows)
symptoms:
  - "FAIL live Tilion provider parity: /rotate-proxy 500: {\"error\":\"Logical browser restore requires validated transport\"}"
  - "Logical browser lost readiness ownership"
tags:
  - tilion
  - rotate-proxy
  - logical-browser
  - browser-provider
sources:
  - PR #1604 (3beb2abb4) merged Tilion provider onto main's logical-browser refactor (#1613)
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts case "live Tilion provider parity" (cd back-end && bash scripts/run-blackbox-tests.sh browser-provider)
status: fixed
---

## Problem

`browser-provider` blackbox failed on clean main: the first Tilion rotate-proxy on a logical session returned 500 "Logical browser restore requires validated transport". Production hits the same path: a logical Tilion browser whose first rotate_ip rung (residential rotate-ip, in place) succeeds.

## Diagnosis

1. In-place rotation (`tilionRotateInPlace.ts`) returns the same session with no `validationBrowser` by design (Tilion admits one CDP client; the worker holds it). `assembleResumeResponseWithTransport` throws for any logical row without one. The restore is also meaningless there: the browser never changed.
2. After skipping that, the next gate failed: "Logical browser lost readiness ownership". The readiness flip expects PAUSED. Kernel replacement writes PAUSED for logical rows (kernel.ts), Tilion replaceSession/reattachLiveSession wrote ACTIVE, so Tilion replacement and resume of logical rows would also fail. In-place rotation never leaves ACTIVE.
Rung: contract mismatch between the provider's row-state/transport and the logical-restore contract, not the test.

## Solution

- `BrowserProviderResumeSession.ipRotation` (moved from the Tilion type) marks a same-browser result; resume assembly skips the checkpoint restore and readiness flip for it.
- Tilion replaceSession and reattachLiveSession write PAUSED for logical rows, as Kernel does; the resume assembly flips them ACTIVE after restore.
10k agents: no new queries or channels; one conditional per resume.

## Human feedback

None recorded.

## Reusable lesson

When a provider returns a different transport shape (no replacement browser, no PAUSED row), make the shared logical-restore contract conditional on a replacement existing instead of requiring every provider to fake one.
