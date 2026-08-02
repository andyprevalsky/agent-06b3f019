---
id: 2026-06-23-cdp-virtual-authenticator-sigaborts-electron-on-credential-create
date: 2026-06-23
title: A CDP virtual authenticator hard-crashes Electron with SIGABRT on navigator.credentials.create()
surface: mac-app
component: passkey-enroll
classification: third-party-failure
problem_class: new-tool-or-capability-required
first_bad_boundary: "Electron webContents.debugger WebAuthn domain — addVirtualAuthenticator succeeds but navigator.credentials.create() aborts the process"
symptoms:
  - "Electron dies with SIGABRT during navigator.credentials.create()"
  - "WebAuthn.enable / addVirtualAuthenticator / getCredentials all succeed first"
  - passkey enrollment window disappears with no JS error
tags:
  - electron
  - webauthn
  - cdp
  - passkey
  - sigabrt
sources:
  - PR #648
  - memory:project_passkey_model_a
repro: none-recorded
status: mitigated
---

## Problem

The mac-app passkey enrollment flow attempted to mint a passkey inside an Electron
`BrowserWindow` using a CDP virtual authenticator
(`webContents.debugger` → `WebAuthn.addVirtualAuthenticator`). `enable`,
`addVirtualAuthenticator`, and `getCredentials` all work, but
`navigator.credentials.create()` hard-crashes the Electron process with SIGABRT —
verified, not inferred.

## Diagnosis

The crash is in Chromium's native WebAuthn implementation as embedded in Electron,
not in our JS: the setup commands succeed and only the credential-creation call
aborts. The owned mistake was assuming a CDP debugging facility that works in
headless/Steel Chrome is safe to drive inside the desktop app's renderer, where a
native abort takes the whole process down instead of surfacing an error.

## Solution

Avoid native WebAuthn entirely for enrollment: `mac-app/main/domains/passkey-enroll/`
injects a pure-WebCrypto software-authenticator override
(`inject-script.ts`) via `executeJavaScript` on every `dom-ready`, the user clicks
"Add a passkey", and the app polls `window.__PASSKEY_CAPTURE` and uploads. The
override logic was verified in Node (mints a valid exportable P-256 key, sign/verify
round-trip passes) and is the same approach already proven by hand on Amazon. Two
verification constraints recorded alongside it: standalone `electron script.cjs`
harnesses cannot be used to verify in this sandbox because `app.whenReady()` never
fires for bare scripts, so verification must go through the real packaged app.

## Human feedback

None recorded.

## Reusable lesson

Do not drive CDP virtual authenticators inside Electron — `credentials.create()`
aborts the process; inject a WebCrypto software authenticator instead and verify
through the real packaged app.
