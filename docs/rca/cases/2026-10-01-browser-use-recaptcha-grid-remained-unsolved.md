---
id: 2026-10-01-browser-use-recaptcha-grid-remained-unsolved
date: 2026-10-01
title: Browser Use auto solver left a live reCAPTCHA image grid unresolved
surface: back-end
component: browser-provider-browser-use
classification: third-party-failure
problem_class: other
first_bad_boundary: Browser Use Cloud solveCaptchas session left Google's visible image challenge unresolved after the checkbox was clicked
symptoms:
  - live provider blackbox timed out waiting for reCAPTCHA aria-checked=true
  - screenshot shows a crosswalk image grid still awaiting tile selection
  - earlier Browser Use live smoke completed the same Google demo successfully
tags:
  - browser-use
  - captcha
  - recaptcha
  - live-test
  - handoff
sources:
  - task browser-provider live blackbox 1790890952-46440-14933
  - task focused Browser Use reCAPTCHA probe 2026-10-01T21:47Z
repro: back-end/src/tests/blackbox/browser-provider.blackbox.ts
status: open
---

## Problem

The paid Browser Use provider blackbox once completed Google's reCAPTCHA demo,
then a later isolated run timed out waiting for the checkbox to become checked.
The full later run successfully traversed the Kernel residential → Kernel mobile
→ Steel → Browser Use proxy ladder, but its separate CAPTCHA assertion failed.
The focused probe clicked the checkbox with a real CDP mouse action and waited
45 seconds. A screenshot in `.context/browser-use-recaptcha-failure.png` showed
the crosswalk image grid still open and unselected.

## Diagnosis

The observed failure is at the provider solver outcome: the V4 session was
created with `solveCaptchas: true`, the browser reached the verifier, and the
image challenge remained unresolved. Browser Use's published guidance says
automatic solving is not guaranteed; it advises waiting, then using live human
control if the challenge remains. The app's generic Browser Use sign-in handoff
was separately proven, but this exact reCAPTCHA grid has not been completed
through that viewer in a test.

This is an **open provider coverage finding**, not a claim that every CAPTCHA
fails. The unchanged `browser-biometrics-webdecoy` FCaptcha benchmark passed
1/1, with a visible `Verified` checkbox and `0.00` form score. That benchmark
and the Google image grid exercise different mechanisms.

## Solution

Keep the Browser Use rollout flag off by default. Preserve the live outcome
assertion in the provider blackbox; successful token population or a CDP click
alone is insufficient. An unresolved challenge requires live-view human control
or a different browser configuration. The exact image-grid handoff remains to
be verified.

## Human feedback

The user asked for deeper CAPTCHA validation and a feature flag so Browser Use
can be disabled if unstable.

## Reusable lesson

Report CAPTCHA behavior per challenge type and verifier outcome. A pass on a
behavioral biometrics demo does not prove automatic image-grid solving.
