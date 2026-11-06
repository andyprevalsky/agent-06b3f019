---
id: 2026-10-27-custody-fixture-commonjs-mock-missed-esm
date: 2026-10-27
title: Custody fixture mocked CommonJS Playwright but Kernel imported its real ESM module
surface: back-end
component: browser-session-resume-custody-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Worker Module._load Playwright interception covers require while Kernel saved-URL restoration uses native import and evaluates the real dependency outside the fixture CDP seam
symptoms:
  - 'fixture timeout: {"provider":"kernel","scenario":"fresh-concurrent"'
  - 'creates1 hydrations0 stops1'
  - 'module:loaded without module:evaluated before the ten-second deadline'
  - 'custody fixture must own Playwright ESM as well as CommonJS'
tags:
  - custody
  - playwright
  - esm
  - module-mock
  - test-fixture
sources:
  - commit 04333dbbdea0b8b3b8d8cc9aa3b75475b53384c6
  - plan:.context/deploy-fresh-20261027/rca-custody-batch6/REPORT.md
  - plan:.context/deploy-fresh-20261027/rca-custody-batch6/v2/FINAL.json
  - plan:.context/deploy-fresh-20261027/custody-esm-independent-review/review-v2.txt
repro: browser-session.blackbox.ts --resume-custody-only, same native Kernel fresh-concurrent scenario
status: open
---

## Problem

Batch6 failed its ordinary Kernel fresh-concurrent owner after ten seconds. The source-scoped observer names owner17951 and captures create completion, old-session DELETE completion, real Playwright module resolution/load, and no evaluation or hydration before the deadline. The earlier two timeout rows are intentional owner-timeout controls, not additional failures.

## Diagnosis

The fixture already supplies a fake browser and validation connection. Its CommonJS Module._load interceptor covers require('playwright'), but native Kernel saved-URL restoration dynamically imports Playwright. That import bypasses the fixture seam and evaluates the real package even though its native/CDP effects are deliberately fixture-owned.

The actual timeline is fork04:18:00.352, create completed08.045, old DELETE completed08.065, Playwright resolved08.066/loaded08.067, timeout10.353 with creates1/hydrations0/stops1. This proves the current post-binding phase; it does not retrospectively identify the older batch5 incompatible case's missing await or attribute time to generic host load.

## Solution

Register the same existing fake Chromium object through node:test mock.module for ESM and CommonJS, and enable its experimental flag only in the fixture child argv. Production resume, provider, database and custody code remain unchanged. The repository already uses this native module seam in sibling browser tests. Official versioned Node22.13 documentation supports the API/flag; no22.13 execution is claimed, and no registerHooks dependency is added to shipped tests.

All49 existing assertion ASTs, timer/retry calls, ten-second deadline and twelve-second intentional fault remain unchanged. One boolean identity assertion inside the existing worker try/finally proves that an actual ESM import reaches the fixture export. Removing only the ESM mock produces that exact assertion failure even when the real module evaluates quickly; restoring it passes the identical native argv. The initial object-equality prototype could spend time formatting a real Chromium object and is retained as rejected evidence, not a successful assertion-red experiment.

The earlier controlled twelve-second real-module evaluation reproduces the original ten-second failure; the corrected same-command fixture passes in5.013s. A real stalled hydration still fails after10001ms. Final exact V2 patch SHA256c1d32125e684bb28ab9db6b8c7d3a4f34d7146adcbc29f8c24b5eb3886eaeeb4 passes the native full entrypoint:34 ordinary cases, both existing expected-timeout controls and preludes,94.615s. Exact-owned rows were zero and77 recorded child PIDs absent before supervisor cleanup. Independent exact-byte review approves this fixture scope. Root applied the patch; full combined acceptance remains pending.

## Human feedback

None recorded for this failure. Repository/coordinator requirements retain every original assertion and timer and require a permanent native regression for the demonstrated dependency-ownership mismatch.

## Reusable lesson

Mock a fixture-owned dependency through every module-loading mechanism used by its real consumer and verify the actual imported export identity.
