---
id: 2026-11-02-live-steel-waiver-leaked-into-mock-rotation-test
date: 2026-11-02
title: A live Steel outage override interrupted the offline rotation fixture
surface: harness
component: browser-proxy-rotation-unit
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The synthetic ladder inherited live outage controls and threw before its second mocked Steel response
symptoms:
  - browser-proxy-rotation.test.ts exited one
  - Steel call-4 profile-persistence rotation and dependent exhaustion assertions skipped
tags:
  - fixture-isolation
  - environment
  - steel
sources:
  - commit 55e86d4b85240654797187d423a50862216edaab
  - plan:/project/rose-speed-comparison-20261028/nov2-proxy-unit-override-rca/HANDOFF.md
repro: cd back-end && node --experimental-test-module-mocks --import tsx src/tests/unit/browser-proxy-rotation.test.ts
status: fixed
---

## Problem

The full backend coverage unit phase failed its offline rotation test while the explicit live Steel persistence override and its native evidence path were inherited. The synthetic ladder reached the live exception helper before its second fake Steel response, so the existing two-label assertion never executed. The live provider incident is separate and remains disclosed.

## Diagnosis

Gate: INTRODUCED. The current fixture with current shared support reproduces the exact error under the retained environment (exit1, 2.657s). Changing only the shared support to main6f3 makes that same fixture pass (2.116s); this is a controlled support-boundary comparison, not a full-main test claim. The unit runner inherits process.env, while the mock fixture did not isolate the operator controls added to the live ladder. A no-DB guard and dummy local connection prove the isolated reproduction made no database queries. All provider responses were mocked.

## Solution

Save and remove DEPLOY_GATE_OVERRIDES and STEEL_PROFILE_PERSISTENCE_OUTAGE_EVIDENCE only around the existing mocked ladder, then restore exact values or absence in its finally. Keep every original assertion. A new registered regression seeds both override tokens and a deliberately nonexistent evidence path, runs the complete original fixture, and checks exact restoration. The same isolated owning command passes with this change (exit0, 2.125s). Production outage, readiness, custody and retry behavior remain unchanged. Integrated full backend validation is still required; the failed original run is retained.

## Human feedback

The user authorized fixing issues and completing deployment, while preserving original failure evidence, Freedom, native leases and existing coverage thresholds. Do not waive offline assertions as provider failures.

## Reusable lesson

Mocked provider tests must own their operator-environment inputs as well as their fake clients. Explicit live incident exceptions must not short-circuit deterministic fixture assertions.

## Integrated verification

The actual shared-checkout owner, after formatting, passed under the original inherited live override and retained evidence path with a no-query guard. The receipt is `plan:/project/rose-speed-comparison-20261028/nov2-proxy-unit-override-rca/integrated.json`. Full combined-source gates follow.
