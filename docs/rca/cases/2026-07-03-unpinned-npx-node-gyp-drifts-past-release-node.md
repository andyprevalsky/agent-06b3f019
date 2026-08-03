---
id: 2026-07-03-unpinned-npx-node-gyp-drifts-past-release-node
date: 2026-07-03
title: Unpinned `npx node-gyp` in the native bridge build resolved to a version requiring newer Node than the release runtime
surface: mac-app
component: native-user-activity-bridge
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: mac-app/native/user-activity-bridge/build.sh — unpinned `npx node-gyp` resolves at release time
symptoms:
  - v1.1.76 release fails in "Build and sign Electron app"
  - dependency install succeeds then the native user-activity bridge build fails
  - node-gyp@13.0.1 requires APIs absent from Node 20.10.0
tags:
  - mac-app
  - node-gyp
  - release-workflow
  - version-drift
  - native-build
sources:
  - PR #688
repro: none-recorded
status: fixed
---

## Problem

The v1.1.76 mac-app release got past dependency install and then failed in the
`Build and sign Electron app` step. The failing command was the native
user-activity bridge build script, which invoked `npx node-gyp` with no version
constraint.

## Diagnosis

At release time CI resolved the floating `npx node-gyp` to `node-gyp@13.0.1`,
which requires APIs that do not exist in the release workflow's Node 20.10.0
runtime. Nothing about the repo changed — the _registry_ did. This is the same
transient-tool drift already fixed for `mac-app/package.json`; the remaining
unpinned invocation was in a release-time native build script, a path that only
executes during a release and so was not covered by the earlier pin. The deeper
cause: a build script fetching a toolchain at execution time makes every release
depend on whatever the registry serves that day.

## Solution

Pinned `mac-app/native/user-activity-bridge/build.sh` to `node-gyp@10.2.0`,
matching the treatment already applied to `mac-app/package.json` so all
node-gyp entry points are now version-locked. Validated by running the script
directly (`bash native/user-activity-bridge/build.sh "$PWD/.context/native-test"`)
plus mac-app `format:check`, `type-check`, and `lint`.

## Human feedback

None recorded.

## Reusable lesson

A release that broke with no code change is almost always floating-tool drift —
pin every `npx <tool>` invocation, and audit the release-only scripts that
ordinary CI never executes.
