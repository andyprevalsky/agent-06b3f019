---
id: 2026-10-15-coverage-backend-missed-supervisor-default-fixture
date: 2026-10-15
title: Instrumented coverage backend missed the supervisor fixture initialized by its child
surface: harness
component: backend-blackbox-startup
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: The independent coverage backend started before its child runner initialized the deterministic supervisor response
symptoms:
  - "new-user reaction must inherit the launcher fixture before backend boot"
  - "loadBlackboxSupervisorResponseFixture returned null for a fresh user"
tags:
  - coverage
  - fixtures
  - sms
  - whatsapp
sources:
  - task PR1520 main sync with WhatsApp media ingress
  - task .context/deploy-shared-fixture-before.log
  - task .context/deploy-shared-fixture-after.log
repro: cd back-end && node --import tsx src/tests/unit/coverage-script.test.ts
status: fixed
---

## Problem

The standalone blackbox runner supplied a deterministic default supervisor response,
but coverage started its instrumented backend before that child runner set the
variable. A fresh user's reaction fixture was therefore null in the server.
Combining mandatory reaction-first handling with the incoming media-only test
would make its one-second media-fetch boundary depend on an unconfigured model
path. The startup contract failure was reproduced; no unobserved full media-test
failure or production outage is claimed.

## Diagnosis

Path: coverage process -> shared fixture initializer -> independent backend ->
child blackbox runner. A child cannot update its parent's or an already-running
server's environment. Both launchers already source `blackbox-auto-rca-env.sh`
before backend boot, making that the existing owner for the shared default.

Archive searches covered coverage startup and shared fixture initialization.
The October 1 benchmark-share secret case and July 25 Stripe fixture case are
relatives; this first bad boundary is a supervisor default initialized too late,
rather than a missing signing key or an unmocked payment call.

## Solution

Move the existing default response unchanged from `run-blackbox-tests.sh` into
the shared initializer. Its capture/replay guard keeps this test configuration
out of production. Explicit response settings and per-user fixtures still win.
No media deadline, provisioning assertion, reaction ordering or model behavior
in production changes.

The existing coverage-script unit launches a real shell child, sources the
same initializer used before both backend launches, then executes the actual
supervisor fixture loader for an unknown user. It checks default reaction and
reply values and preservation of an explicit override. Before the move the
same command fails with the literal new-user assertion above; afterward the
full coverage-script contracts pass, including six launcher controls. Proof is
retained in the listed before/after logs. Full coverage and the merged media
suite still run as deployment gates; this focused proof does not replace them.

## Human feedback

The user authorized deployment. The repair preserves the existing deterministic
test boundary instead of relaxing the media test or bypassing reactions.

## Reusable lesson

Initialize shared test configuration before the process that consumes it starts.
