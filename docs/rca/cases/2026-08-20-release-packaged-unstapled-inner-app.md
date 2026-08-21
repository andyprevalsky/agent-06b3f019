---
id: 2026-08-20-release-packaged-unstapled-inner-app
date: 2026-08-20
title: Release packaging ran before inner-app notarization and stapling
surface: mac-app
component: mac-release-workflow
classification: our-bug
problem_class: other
first_bad_boundary: .github/workflows/release-mac-app.yml packaging step
symptoms:
  - immediately got detected as malware and sent to trash
  - Rose.app does not have a ticket stapled to it.
tags:
  - macos
  - notarization
  - stapling
  - gatekeeper
  - release-order
sources:
  - commit e8a928f59
repro: mac-app/tests/blackbox/mac-app-release-config.blackbox.ts
status: fixed
---

## Problem

The user reported that the downloaded Mac app was "immediately got detected as
malware and sent to trash." The exact macOS security event was no longer
retained, so that wording was not independently reproduced. The owned release
defect was reproduced against the public v1.1.136 artifact: the outer DMG
passed `xcrun stapler validate`, while the `Rose.app` mounted from that DMG
failed with exit 65 and `Rose.app does not have a ticket stapled to it.` The
installed v1.1.134 app had the same missing-ticket result.

The permanent workflow regression test was run before the fix with:
`cd mac-app && npx vitest run tests/blackbox/mac-app-release-config.blackbox.ts`.
It failed at `the signed .app must be submitted for notarization` with
`expected -1 to be greater than -1` because the first packaging command
preceded every inner-app notarization command.

## Diagnosis

The release path was `signed Rose.app -> updater ZIP and DMG packaging -> DMG
notarization/stapling -> publication`. The first-bad boundary was the packaging
step in `.github/workflows/release-mac-app.yml`: it ran
`electron-builder --prepackaged "$APP" --mac dmg zip` before any submission of
`Rose.app` to Apple's notary service. The later submission, wait, and staple
steps named only `dist/Rose-mac.dmg`; therefore the container had a ticket but
the app copied into both published artifacts did not.

`git show e8a928f59^:.github/workflows/release-mac-app.yml` shows the preceding
workflow delegated notarization to electron-builder. Commit `e8a928f59` set
`SKIP_NOTARIZATION=true` and split only DMG submission and stapling into explicit
steps. The deepest owned cause was an absent release-order invariant: neither
the workflow nor its blackbox suite required the signed inner app to be
notarized, stapled, and validated before it became packaging input. This also
left updater ZIP contents unverified even when the DMG itself passed validation.
Archive searches for the exact stapler error, Gatekeeper/malware behavior, and
inner-app versus DMG notarization found related updater/notarization incidents
but no case with this first-bad boundary, so this is a new case rather than a
recurrence.

## Solution

Make inner-app trust a prerequisite instead of a post-package assumption.
`mac-app/scripts/notarize.js` now submits a ZIP containing the signed app,
requires an `Accepted` result, staples and validates `Rose.app`, and fails closed
unless notarization is explicitly skipped. The release workflow signs and
verifies the app, runs that notarize/staple stage, then builds the updater ZIP
and DMG. It extracts the final ZIP and validates the app inside it before
publication; the existing outer-DMG notarization remains in place.

The unchanged permanent test now passes 10/10. A production-shaped local build
was accepted by Apple as submission
`85ee8d1d-ddde-4d32-ba01-de9572bdad1b`; `codesign --verify`, `spctl -a`, and
`xcrun stapler validate` all passed for the resulting app. With a quarantine
attribute and an isolated profile, its packaged executable remained alive for
the full 20-second launch-health window and loaded `.env.production`. An earlier
full package build also proved both the inner app and outer DMG acceptance and
that the app extracted from the updater ZIP retained its ticket. The pipeline
operates once per release artifact, so agent population size, including 10,000
agents, does not change its cost or behavior.

## Human feedback

The user insisted that the Mac app must open and reported that the current
download was classified as malware and moved to Trash.

## Reusable lesson

Notarize, staple, and validate the signed inner app before using it as input to any distributable container, then revalidate the app extracted from every updater artifact.
