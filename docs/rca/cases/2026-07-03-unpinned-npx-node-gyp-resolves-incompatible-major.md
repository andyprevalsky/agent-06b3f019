---
id: 2026-07-03-unpinned-npx-node-gyp-resolves-incompatible-major
date: 2026-07-03
title: Unpinned `npx --yes node-gyp` resolved a new major that needs a newer Node than the release runtime
surface: mac-app
component: mac-app-release
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: mac-app postinstall — `npx --yes node-gyp` resolved latest (13.0.1) instead of a pinned version
symptoms:
  - mac-app v1.1.75 release failed in the "Install dependencies" step
  - "webidl.util.markAsUncloneable is not a function"
  - release aborted before the updater-feed guard could run
tags:
  - mac-app
  - release
  - node-gyp
  - undici
  - dependency-pinning
  - ci
sources:
  - PR #687
repro: mac-app/tests/blackbox/mac-app-release-config.blackbox.ts
status: fixed
---

## Problem

The mac-app v1.1.75 release run failed during `Install dependencies`, before the
updater-feed guard step could execute, so the release never produced an artifact.
The workflow log showed `npx --yes node-gyp` resolving to `node-gyp@13.0.1`,
which pulled in `undici@8` and called `webidl.util.markAsUncloneable` — an API
that does not exist in the Node 20.10.0 runtime the release workflow pins.

## Diagnosis

The postinstall native rebuild invoked `npx --yes node-gyp`, which resolves the
_latest_ published version at install time. That makes the release install
non-hermetic: the workflow pins Node (20.10.0) and Electron (31), but left the
build tool floating. When node-gyp published a major that assumes a newer Node,
the previously-green release began failing with no change on our side. The
deepest owned cause is a transitively-unpinned tool on a pinned runtime — the
`--yes` flag hid it by silently installing whatever npm offered.

## Solution

Pinned the postinstall rebuild command to `node-gyp@10.2.0`, restoring a
reproducible install for the Electron 31 / Node 20 release environment. The pin
also protects every future release from the same class of break: any tool fetched
ad hoc by `npx` inside a version-pinned CI job must itself be version-pinned. The
release-config blackbox (`mac-app-release-config.blackbox.ts`) covers the release
configuration surface.

## Human feedback

None recorded.

## Reusable lesson

If CI pins the runtime, pin every tool it fetches — an unpinned `npx --yes <tool>`
turns an upstream release into an unannounced break of your build.
