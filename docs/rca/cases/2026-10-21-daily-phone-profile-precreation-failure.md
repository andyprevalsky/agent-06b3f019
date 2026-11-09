---
id: 2026-10-21-daily-phone-profile-precreation-failure
date: 2026-10-21
title: DAILY phone fixture submitted exception authorization before configuring identity
surface: harness
component: phone-daily-fixture
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: Daily fixture combined a new Google identity and exception grant in one setup-profile request
symptoms:
  - "isolated setup-profile endpoint returned 409 before root creation"
  - "browser-auth-doordash-cloud-iphone pre-creation failure"
tags:
  - phone
  - benchmark
  - fixture
  - setup-profile
sources:
  - commit 4f27bf98c
  - benchmark run 2aabb446-046c-4561-bf72-ec1016aa5ee4
  - benchmark run a94eaed8-c5e2-4a2f-8feb-9b99ac28583d
repro: none-recorded
status: mitigated
---

## Problem

# DAILY phone profile initialization failed before live authentication

Status: fixed locally; unchanged live benchmark retry pending.

The new `browser-auth-doordash-cloud-iphone` task failed before root creation in run `2aabb446-046c-4561-bf72-ec1016aa5ee4`. The isolated setup-profile endpoint returned 409. The fixture submitted a new Google identity and its exception authorization in one request, while the server intentionally requires that identity to be configured first. The backend restriction remains unchanged.

The fixture now first configures the identities without an exception, then uses the returned profile revision to authorize the requested exception. Existing matching profiles are untouched. A failed or malformed first receipt cannot authorize the second request. The owning regression reproduced the 409 before the change and passes with both ordered requests.

The same pre-creation error exposed a cleanup classification gap: the batch treated every missing root as an unknown creation outcome even when create was never attempted. The runner now records whether creation was attempted; only an explicit false on an ERROR result permits rootless cleanup. True or missing evidence still fails closed. The owning regression failed on the prior code and passes unchanged after this correction. The failed isolated database independently had zero newly created agents, zero phone leases and zero phone operations; its exact stack was stopped through the existing ownership-checked cleanup function.

Validation: 36 focused tests pass, including both new regressions, existing DAILY checks and the new auth catalog tests. Ruff and diff checks pass. These tests do not establish DoorDash authentication or live phone use.

Earlier startup attempts also lacked the current canonical database fixture. A reviewed prior canonical dump was migrated only with the current ImessageQueue migration, all existing row fingerprints were preserved, schema drift was zero, and dump/restore plus canonical WhatsApp validation passed. No production database was modified. Local private provenance records the source and derived dump hashes.

The unchanged task was rerun on `133893d87` as run `a94eaed8-c5e2-4a2f-8feb-9b99ac28583d`, root `ad03d093-5864-462a-a628-9b067563de59`. Initialization and cleanup completed successfully. The actual live authentication task failed after 499.3 seconds: Google rejected sign-in in the browser, DoorDash remained password-required, and no cloud-phone challenge was reached. Thus this is a valid negative live task result, not proof of automatic phone handling. The browser was closed, its recording attached and verified through the durable viewer, the exact stack cleanup receipt was clean, and the owned database was removed. Recorded agent cost: $0.05. Do not relabel this task as passing because the fixture bugs were fixed.

## Diagnosis

The historical evidence above establishes the ordered profile-write mismatch
and the independent rootless-cleanup classification gap. The original record
reported executed failing and passing owning regressions but omitted their
exact test identifiers and commands; this metadata repair does not invent them.
The later Google rejection is a separate unresolved live-authentication outcome.

## Solution

The fixture submits the identity first and grants the exception with the returned
revision. Explicit evidence that root creation was never attempted permits the
existing rootless cleanup path. The historical live rerun demonstrated that the
pre-creation failure was removed, but did not pass the full authentication task.
This case is therefore retained as mitigated rather than claiming end-to-end success.

## Human feedback

The user required a real authentication benchmark with the phone enabled;
fixture-only passing tests do not satisfy that outcome.

## Reusable lesson

Configure identity before authorizing an identity-bound exception, and distinguish fixture repair from successful live authentication.
