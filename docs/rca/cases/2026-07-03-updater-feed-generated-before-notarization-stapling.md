---
id: 2026-07-03-updater-feed-generated-before-notarization-stapling
date: 2026-07-03
title: latest-mac.yml was generated before notarization stapled the DMG, publishing hashes and sizes that no longer matched the artifacts
surface: mac-app
component: mac-app-release
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: the mac-app release workflow — updater metadata was generated pre-stapling and afterwards only URLs were rewritten with sed
symptoms:
  - "latest-mac.yml lists Rose-mac.dmg with size 149945713 but the published artifact is 149947814 bytes"
  - mac app auto-update fails against the published feed
  - release feed hashes/sizes stale for v1.1.74
tags:
  - mac-app
  - auto-update
  - notarization
  - release-workflow
  - latest-mac-yml
sources:
  - PR #686
repro: mac-app/tests/blackbox/mac-app-release-config.blackbox.ts
status: fixed
---

## Problem

Production `latest-mac.yml` for v1.1.74 declared `Rose-mac.dmg` at size
`149945713`, but the artifact actually served from public Supabase storage was
`149947814` bytes — a 2,101-byte discrepancy. The updater feed therefore
described an artifact that did not exist, so the published metadata could not
validate against the installable download.

## Diagnosis

The release workflow generated updater metadata _before_ notarization stapled the
DMG. Stapling rewrites the DMG, changing both its size and its hash. After
stapling the workflow only rewrote URLs inside the feed with `sed`, so the
hashes and sizes stayed frozen at their pre-staple values. The deepest owned
cause is ordering plus a partial rewrite: the pipeline treated the feed as
URL-only text to patch rather than as metadata derived from the final artifacts,
so it was structurally capable of publishing metadata that no longer matched
what it shipped.

## Solution

Added `mac-app/scripts/prepare-updater-feed.mjs`, which regenerates
`latest-mac.yml` from the final local DMG/ZIP artifacts, and moved that step to
run _after_ DMG stapling with an immediate feed verification before the Supabase
upload. A mac-app blackbox guard reproduces the stale-metadata case by mutating an
artifact after the feed is generated, so any future reordering of generate-vs-mutate
fails the suite.

## Human feedback

None recorded.

## Reusable lesson

Derive release metadata from the final artifacts after every mutating step
(signing, stapling, compression) and verify it — never patch a pre-built manifest
in place.
