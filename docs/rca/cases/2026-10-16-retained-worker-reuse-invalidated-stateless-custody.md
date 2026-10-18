---
id: 2026-10-16-retained-worker-reuse-invalidated-stateless-custody
date: 2026-10-16
title: Reusing a retained worker left stateless custody bound to its previous native configuration
surface: infra
component: retained-agent-machine
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: retained_agent_machine.py reuse updated the native image and instance while leaving the stateless custody record bound to the prior instance and configuration
symptoms:
  - an explicitly stateless reusable machine must return to the spare pool
  - Machine lacks an eligible stopped, drained custody record
  - stopped retained worker becomes ineligible after its first reuse
tags:
  - deployment
  - retained-worker
  - custody
  - native-identity
  - reuse
sources:
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
  - plan:.context/reusable-cutover-20261016/stateless-cycle-red.log
repro: python3 scripts/tests/retained-agent-machine.test.py RetainedWorkerTests.test_stateless_pool_custody_survives_a_complete_generation_cycle
status: fixed
---

## Problem

While implementing the user-requested reusable worker pool, the existing native
helper failed a complete reuse/retirement cycle. The first image update changed
the native instance and configuration fingerprint. The subsequent retirement
preserved a custody record for the old instance, so eligibility correctly
rejected the worker rather than returning it to the spare pool.

This was reproduced locally with the real helper and only its native HTTP
boundary replaced. It is not evidence that every historical CUTOVER failure
had this cause. No production Machine was changed to reproduce it.

## Diagnosis

The owning test above failed on the original helper with one assertion failure
in 0.002 seconds: `an explicitly stateless reusable machine must return to the
spare pool`. The retained output is
`.context/reusable-cutover-20261016/stateless-cycle-red.log`. An earlier test
selection matched no tests and is not counted as a reproduction.

The custody record intentionally binds app, Machine ID, native instance ID and
complete configuration fingerprint. Reuse changed the last two fields but
never renewed the explicit stateless grant after verifying the result. Dropping
the identity checks would conceal foreign updates or data-bearing changes.

Archive searches covered retained workers, custody, pool reuse, and cutover.
The shared-host autoscaler admission case concerns a different selector and
remains independent. The force-clear case concerns interrupted workflow work,
not custody renewal. Neither supplies the missing native-version transition.

## Solution

After the leased, compare-and-swap image update is verified against its complete
expected configuration, renew only an explicitly stateless custody record to
that exact native result. An archive of a prior runtime does not automatically
cover newly written data. Protected Machines and persistent root overlays
remain ineligible; volume mappings and unrelated configuration are preserved.

Managed reuse records the original source and expected target fingerprint.
If the native update committed but its response was lost, the next owner can
verify that same target and renew the original stateless grant before starting
the worker, without issuing another image update. A different job, source
instance, configuration or custody record cannot use that recovery path.

The unchanged owning reproduction now passes. The extended owner also covers
same-code deployments on distinct queues, two reservations competing for one
Machine, native-version changes, retained volumes, and rejection of archived
or persistent data. The controller owner covers loss of the image-update reply
before custody renewal. These are local component results; whole-deployment
qualification and actual fleet readiness remain separate gates.

## Human feedback

The user asked to implement reusable preallocated worker capacity and safe
concurrent deployment, permitting transfer of up to 100 benchmark-pool Machines
if needed. This does not establish that an arbitrary stopped Machine's data is
disposable. The implementation must preserve unfinished work and retain data
unless its transfer or retirement has an applicable, concrete disposition.

## Reusable lesson

Renew an explicitly stateless reuse grant only after verifying the exact new native identity, and never carry an old data archive forward as proof for newly written state.
