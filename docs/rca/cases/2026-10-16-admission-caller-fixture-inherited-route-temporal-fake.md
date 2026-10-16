---
id: 2026-10-16-admission-caller-fixture-inherited-route-temporal-fake
date: 2026-10-16
title: Admission caller fixture inherited coverage's route-level Temporal fake
surface: back-end
component: workflow-queue-admission-callers-test
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: actual-SDK caller fixture left BLACKBOX_TEST_FAKE_TEMPORAL enabled so getTemporalClient bypassed its injected Connection.connect service
symptoms:
  - Missing expected rejection (isWorkflowStartAdmissionPending)
  - manual native failure leaves actual agent active and retryable
  - SMS native failure preserves actual created agent without false FAILED/adoption
tags:
  - coverage
  - temporal
  - fixture-isolation
  - admission
sources:
  - PR #1518 fresh deployment verification
  - commit 11dd68fc7387738f4c69e516708b37bf30cfb3b3
repro: back-end/src/tests/unit/workflow-queue-admission-callers.test.ts under canonical backend coverage
status: open
---

## Problem

The full backend coverage gate reported 280 unit files passing and one failing.
Four assertions in the admission caller fixture failed. The log showed
`Using in-memory Temporal client for blackbox route contracts`, followed by
successful starts where this fixture's injected native service was supposed to
throw. Isolated earlier executions had not inherited the coverage environment.

## Diagnosis

Coverage deliberately sets `BLACKBOX_TEST_FAKE_TEMPORAL=1` for ordinary HTTP route
contracts. This fixture patches public `Connection.connect` to exercise the real
SDK with a controlled native service. The production client factory correctly
chooses its route fake before opening a connection when the flag is enabled, so
the fixture's service and failures were bypassed. Direct helper tests that pass
their own SDK client were unaffected. This was a fixture isolation failure, not
evidence that production admitted an unjournaled native start.

Archive searches used `BLACKBOX_TEST_FAKE_TEMPORAL actual SDK fixture
Connection.connect` and `coverage injected fake temporal caller assertions bypass
service`. The retired-queue admission case is related feature context, with a
different first bad boundary. Listener and worker-port fixture cases reinforce
preserving the actual boundary rather than replacing failed assertions.

## Solution

Save the flag, disable only that route fake inside this actual-SDK fixture, and
restore it in `finally`. Leave the coverage runner, production client factory,
native service faults, and every existing assertion unchanged. Remove the touched
file's console-lint suppression and retain stack output through stderr.

The same caller file now reports twelve PASS when launched with the coverage
flag enabled. Its native service, encoded payload/interceptor, immutable
replacement policy, pending outcomes and liveness races are exercised. The
before failure remains in the full canonical gate receipt; the complete coverage
macro must pass again before deployment.

The same integration batch completes the private route's required domain layers
and refreshes only the canonical transaction wrapper's exact raw-call fingerprint.
The wrapper cannot delegate to itself. Its deadline bounds, pre-body-only retry
policy and owning deadline assertions remain unchanged. The unchanged full
backend structural suite passes after these corrections; no allowlist expansion
or structural assertion was removed.

## Human feedback

The user asked to finish deployment, retaining the private credential behavior
and existing-Machine constraint. No test, coverage or native verification gate
was waived for these development corrections.

## Reusable lesson

A fixture that owns an actual SDK boundary must isolate ambient alternate-client
flags; passing a direct injected-client test does not prove caller integration.
