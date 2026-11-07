---
id: 2026-11-07-interrupted-custody-fixture-asserts-live-hub-port-quiet
date: 2026-11-07
title: Interrupted-custody fixture hard-codes Hub port 8765 and fails whenever a live benchmark Hub listens there
surface: infra
component: scripts/tests/deploy-test-plan.test.py
classification: test-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: InterruptedCustody fixture writes Hub port 8765 into its owner record, and deploy_test_interrupted_cleanup.namespace_quiet asserts the host-wide TCP table has no non-TIME_WAIT socket on that port
symptoms:
  - "interrupted custody: original Hub listener/socket consumer remains"
  - "ERROR: test_static_and_cloud_reconcile_preserve_originals_and_history (cloud=True)"
  - deploy-command-structural UNVERIFIED with failed deploy structural gates deploy-test-plan while a smoke gate runs in the same cycle
tags:
  - deploy
  - structural-gate
  - benchmark-hub
  - interrupted-custody
  - staged-deploy-cycle
sources:
  - PR #1721
  - commit ec1b265e7
repro: scripts/tests/deploy-test-plan.test.py
status: fixed
---

## Problem

Gate: NOT_INTRODUCED. On head 89186966c the staged cycle's
`deploy-command-structural` gate failed in `deploy-test-plan`:
`InterruptedCustody.test_static_and_cloud_reconcile_preserve_originals_and_history`
(cloud=True) raised `interrupted custody: original Hub listener/socket consumer
remains`. The suite had passed in earlier cycles before the test existed.

## Diagnosis

The fixture (added by ec1b265e7) names the original Hub `agent-link-server.8765`
and records `port=8765`. `namespace_quiet` then reads `/proc/net/tcp` and
`tcp6` for the whole host and refuses any socket on a listed port that is not
TIME_WAIT/closing. A staged cycle runs its smoke gate concurrently with the
structural gate, and the smoke gate's exact-owned central Hub listens on 127.0.0.1:8765, so the
fixture can only pass on a box with no live benchmark Hub.

Reproduction: with the live Hub on :8765 the unchanged
`InterruptedCustody` tests fail (7 run, 1 error); with the fix they pass (7 OK).

## Solution

The fixture asks the kernel for an unused loopback port (`unused_local_port`)
and uses it for the owner filename, the owner record and the retirement row.
The production check is unchanged. Sibling prevention: a fixture that asserts
host-wide socket state must not borrow a well-known service port. No runtime
behavior changes.

## Human feedback

None recorded.

## Reusable lesson

When a test asserts that a port is quiet on the whole host, give its fixture an unused port instead of the service's default.
