---
id: 2026-11-14-phone-device-view-idle-copy-during-setup-start
date: 2026-11-14
title: Phone app device view said "Phone is idle" under the setup card before the setup agent booted the phone
surface: front-end
component: phone-device-view
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: front-end/src/features/terminal-component-group/components/browser-status-bar/phone/PhoneDeviceLive.tsx stateCopy()
symptoms:
  - Phone is idle
  - Phone app shows idle while iPhone setup is starting
  - setup card visible but footer says Idle
tags:
  - iphone
  - phone-app
  - setup
  - device-view
sources:
  - prod user 1f85ff25 2026-11-14 18:06-18:08Z
repro: front-end/src/tests/blackbox/phone-device-view.blackbox.tsx
status: fixed
---

## Problem

In prod (user 1f85ff25, 2026-11-14 18:06-18:08Z), after the owner pressed Connect,
`GET /api/iphone/connection` returned `setting_up` for about 75 s, so PhoneDeviceView
showed the floating setup card. During the same window, `GET /api/iphone/device` returned
`providerState: IDLE, holder: null`, and the screen under the card said "Phone is idle"
with an "Idle" footer. That contradicts the setup card. Once READY, frames streamed
normally (75% 200 / 25% 409 busy).

## Diagnosis

PhoneDeviceView reads two independent sources: `/iphone/connection` (setup card) and
`/iphone/device` (screen + footer). The setup agent starts the phone session only after
it acquires its lease, so `providerState` is legitimately IDLE with no holder for the
first part of setup. `PhoneDeviceLive.stateCopy()` and `PhoneHolderLabel` saw only the
device model and mapped IDLE/null holder straight to "Phone is idle"/"Idle"; they had no
input for the connection's `setting_up` state. That is the first bad boundary. The
backend data is correct: the phone really is not booted yet.

## Solution

PhoneDeviceView passes `settingUp` (connection `setting_up`) into PhoneDeviceLive and
PhoneHolderLabel. While setting up and the provider is IDLE/CLOSING, the screen says
"Starting the phone for setup…" and the footer says "Starting". STARTING/READY are
unchanged, so live frames appear as soon as the phone is READY. The change is FE-only and
renders from existing polls, so there are no new requests and the 10k-agent load is
unchanged. Regression: `phone-device-view.blackbox.tsx` "says the phone is starting,
never idle, while setup runs before the phone session boots".

## Human feedback

None recorded.

## Reusable lesson

When one view combines two status sources, a resting state from one source ("idle")
must not be rendered while the other source reports that work toward it is in
progress. Gate the copy on both.
