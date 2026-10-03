---
id: 2026-10-01-browser-use-passkey-assertion-not-allowed
date: 2026-10-01
title: Browser Use lists an injected passkey but WebAuthn assertion is not allowed
surface: back-end
component: browser-provider-browser-use
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: Browser Use provider parity validation checked CDP WebAuthn credential readback without requiring a real browser WebAuthn assertion
symptoms:
  - Browser Use WebAuthn.getCredentials reports one imported credential
  - Browser Use navigator.credentials.get returns NotAllowedError after a real click
  - Browser Use navigator.credentials.create also returns NotAllowedError
  - Kernel-created passkey successfully signs on Steel in the same live test
tags:
  - browser-provider
  - browser-use
  - passkey
  - webauthn
  - cdp
sources:
  - task browser-passkey-provider live blackbox 1790890726-5353-5863
  - task browser-passkey-provider live blackbox 1790890528-75899-8154
repro: back-end/src/tests/blackbox/browser-passkey-provider.blackbox.ts
status: open
---

## Problem

The user asked to verify passkey sync across Kernel, Steel, and Browser Use
before enabling the new browser provider. The app's account passkey reservation
and agent reseeding code are provider independent, but that is insufficient if
the browser cannot complete a WebAuthn ceremony. The live provider blackbox
created a passkey in Kernel, imported the same CDP credential into Steel and
Browser Use, and requested an assertion on `https://example.com`.

Steel signed with the imported credential and advanced its sign count. Browser
Use returned one credential from `WebAuthn.getCredentials`, but
`navigator.credentials.get` returned `NotAllowedError`. The same error followed
a real Playwright click on a visible Sign in with passkey button. A fresh
`navigator.credentials.create` on Browser Use also returned `NotAllowedError`.
The page reported a secure context, WebAuthn permission policy allowed create
and get, and the browser reported a user-verifying platform authenticator.
Using a USB virtual authenticator instead of the app's internal transport did
not change the outcome.

## Diagnosis

This is an **open capability gap**, not a completed provider-root-cause RCA.
The live failure is established at the browser WebAuthn ceremony boundary, after
CDP credential injection and readback. The evidence does not yet distinguish a
Browser Use Cloud browser constraint, a CDP transport/target mismatch, or a
Chrome virtual-authenticator configuration issue. It does disprove the weaker
claim that successful `WebAuthn.addCredential` and `getCredentials` alone prove
passkey support.

Archive searches: `WebAuthn NotAllowedError Browser Use virtual authenticator`
and `credential readback succeeds passkey assertion fails provider browser`.
The 2026-08-19 native UI case is a relative: it likewise warns that successful
target-local readback need not imply a working ceremony, but involves Kernel's
native modal rather than Browser Use's `NotAllowedError`.

Reproduce with:

```sh
cd back-end
RUN_BROWSER_PASSKEY_LIVE=1 BROWSER_AGENT_BROWSER_USE_ENABLED=true \
  bash scripts/run-blackbox-tests.sh browser-passkey-provider
```

The failing run `1790890726-5353-5863` printed `PASS Steel WebAuthn assertion
with transferred Kernel passkey`, then `FAIL live browser passkey transfer:
Error: NotAllowedError: The operation either timed out or was not allowed`.
The default Browser Use feature flag remains off.

## Solution

Pending. The opt-in live blackbox preserves the full ceremony requirement and
does not accept CDP readback as success. Browser Use must pass that test before
we claim passkey parity or deploy with the provider enabled.

## Human feedback

The user explicitly required checking passkey sync across Kernel and the other
browsers as part of Browser Use rollout proof.

## Reusable lesson

Passkey parity requires a real relying-party assertion on every provider. CDP
credential import and readback only prove the control plane accepted the data.
