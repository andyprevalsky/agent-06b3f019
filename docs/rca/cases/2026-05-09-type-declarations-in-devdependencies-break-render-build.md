---
id: 2026-05-09-type-declarations-in-devdependencies-break-render-build
date: 2026-05-09
title: Type-declaration packages needed by prod imports sat in devDependencies, so the Render build failed at tsc
surface: back-end
component: build-config
classification: configuration-error
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/package.json — declaration packages were devDependencies, absent from Render's production install before tsc runs
symptoms:
  - Render backend production build fails
  - missing declaration errors for "mime-types", "node-cron", and "adm-zip"
  - build passes locally but fails on Render
tags:
  - render
  - typescript
  - build-failure
  - devdependencies
  - prod-only
sources:
  - PR #578
repro: none-recorded
status: fixed
---

## Problem

The Render backend production build failed while compiling with `tsc`, reporting
missing type declarations for `mime-types`, `node-cron`, and `adm-zip`. The same
build succeeded locally.

## Diagnosis

Render installs production dependencies only, then compiles. The declaration
packages for modules imported by production code were declared as
devDependencies, so `npm install --omit=dev` never placed them on disk before
`tsc` ran — the compile had no types for imports it was required to check. Local
builds installed dev and prod dependencies together and therefore could never
expose the gap: the difference between the local install set and the deploy
install set was the whole defect. The failure was reproduced deliberately by
running the exact production install in an isolated tree
(`.context/render-build-repro`) rather than inferred from the Render log alone.

## Solution

Moved the declaration packages required by production imports into
`dependencies` in the backend manifest, so any install that can run the build
also has the types. Validated with `NODE_ENV=production npm install --omit=dev
--package-lock=false --no-audit --no-fund --workspaces=false` against the repro
tree plus `npm run build`, then `cd back-end && npm run build`. This prevents the
same class of failure for every future prod-imported module whose types would
otherwise only exist in a dev install.

## Human feedback

None recorded.

## Reusable lesson

When a build fails only on the deploy host, reproduce it with the host's exact
install command (`--omit=dev`) before touching code — anything the compile needs
must live in `dependencies`, not devDependencies.
