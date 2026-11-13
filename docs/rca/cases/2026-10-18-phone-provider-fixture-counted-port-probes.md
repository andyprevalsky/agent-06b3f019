---
id: 2026-10-18-phone-provider-fixture-counted-port-probes
date: 2026-10-18
title: Phone provider fixture counted unrelated HEAD port probes as authenticated API calls
surface: back-end
component: iphone-control-blackbox
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: back-end/src/tests/blackbox/iphone-control.fixtures.ts provider HTTP request routing
symptoms:
  - Fake provider observed a wire/auth contract violation
  - HEAD / Provider authorization isolation
tags:
  - phone-harness
  - test-fixture
  - http-probe
sources:
  - agent 01a146e7-f644-7c41-a0b1-83dc6e5018b0
repro: back-end/src/tests/blackbox/iphone-control.blackbox.ts
status: fixed
---

## Problem

The production-route suite passed its operation assertions but intermittently
reported a fake-provider authorization failure in different cases. Diagnostic
capture identified an unauthenticated `HEAD /` request, outside the provider API
paths. Its external initiator was not identified. No provider account or control
credentials were used by that request.

## Diagnosis

Critical path: local HTTP listener -> incoming path -> fake-provider auth check
-> shared fixture error counter -> case failure. The listener classified every
request as provider traffic before checking its path. An unrelated port probe
could therefore fail a case even though all actual provider requests used the
correct credentials. An explicit `HEAD /` reproduction made the failure
deterministic, preserving all physical-operation and authorization assertions.

Command from back-end: `bash scripts/run-blackbox-tests.sh iphone-control`.
Run `1792350838-2311344-32042` failed with `Unrelated port probes must remain
outside the provider contract` before the routing fix. The unchanged regression
passed in run `1792350864-2316248-6946` with all 16 cases.

## Solution

Give the injected HTTP transport a per-fixture random path prefix. The fixture
returns 404 for traffic outside that prefix before recording provider calls or
checking provider authorization. All injected production-client traffic crosses
the prefix and retains the existing exact authentication assertions. Keep the
explicit HEAD regression in the existing normal backend blackbox suite.

This changes test isolation only. It creates constant state per fixture and no
production queues, channels or shared locks at 10k agents.

## Human feedback

None recorded.

## Reusable lesson

Route local fake-provider traffic through a fixture-specific namespace before asserting provider contracts on a shared machine.
