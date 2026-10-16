---
id: 2026-10-16-deployment-leases-trusted-controller-wall-clocks
date: 2026-10-16
title: Deployment lease ownership depended on the controller host clock
surface: infra
component: workflowDeploymentLease
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: lease acquisition compared a host-clock cutoff with a lease timestamp while managed admission validated expiry against the database clock
symptoms:
  - a fast controller could replace a lease still live by database time
  - a slow controller could reject an expired lease
  - an expired owner could renew before another owner acquired the lease
tags:
  - deployment
  - lease
  - concurrency
  - clock-skew
sources:
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
  - plan:.context/reusable-cutover-20261016/lease-clock-red.log
repro: cd back-end && node --import tsx src/tests/unit/workflow-deployment-clock.test.ts
status: fixed
---

## Problem

The reusable deployment queue requires independent controllers to agree on one
lease owner. The existing lease used the controller clock to decide expiry and
implicitly used its write timestamp when renewing. The new admission checks
use database time. Those clocks can disagree even when every individual check
looks correct.

This is a local source reproduction, not an attribution for a historical
production failure. No production lease or Machine was changed.

## Diagnosis

The registered owner replaces only the database boundary and supplies a fixed
database clock with a controller clock one hour ahead or behind. On the original
provider all four controls fail: a live lease is stolen, an expired lease is
refused, the timestamp is not explicitly bound to database time, and an expired
owner can renew. The exact failures are retained in the source artifact above.
An additional unchanged check then exposed that acquisition used the requesting
caller's lease duration to expire the incumbent. A request for a shorter lease
could therefore steal a still-valid longer lease. Its failure is retained in
`.context/reusable-cutover-20261016/lease-duration-red.log`.

The earlier custody case concerns a Machine image transition; it does not cover
lease expiry or competing controller clocks. The existing lease tests cover
ordinary contention and owner replacement without clock skew.

## Solution

Read database time inside the lease advisory-lock transaction for acquisition
and renewal. Persist that timestamp explicitly, and renew only while the same
owner's lease is still live by that clock and its saved duration. A late heartbeat
cannot revive an expired lease, and a new caller cannot shorten the incumbent's
lease. All five controls now pass without changing their assertions.

Whole-deployment and real-database integration checks remain required. The
mocked owner does not claim that a real deployment or native takeover succeeded.

## Human feedback

The user asked how concurrent deployers can safely reuse preallocated Machines
and authorized implementation of the updated cutover approach. No additional
operational authority is inferred from these tests.

## Reusable lesson

Use the same authoritative clock to acquire, renew, and validate a distributed lease.
