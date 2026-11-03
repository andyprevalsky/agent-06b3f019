---
id: 2026-10-16-runtime-copy-failure-skipped-owned-pool-stop
date: 2026-10-16
title: Runtime evidence copy failure skipped STOP for safely shut-down claimed pool Machines
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cleanup treated runtime evidence retention as a reason to bypass the claimed-pool STOP and observed-STOPPED path
symptoms:
  - "retaining claimed pool machines and ownership claims: guest cleanup or runtime evidence is unconfirmed"
  - "runtime evidence is incomplete; retaining original fleet volumes"
tags:
  - cloudbench
  - teardown
  - pool-claims
  - billing
sources:
  - PR #1525
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py ClaimedPoolRetainedEvidenceStopTests
status: fixed
---

## Problem

A runtime evidence copy failure sets `runtime_evidence_failed` even when guest
shutdown and all owned process joins succeeded. The EXIT cleanup then retained
both the pool claim and the running Machine, bypassing its existing STOP request
and native-state polling. Retaining evidence custody needlessly retained compute.

## Diagnosis

The first bad boundary was the shared condition that treated missing runtime
files like unconfirmed guest shutdown. Searches for `runtime evidence incomplete
retaining pool machines` and `billing stop retain claims compute` found related
cancellation/ownership failures. This is a separate branch error: the guest is
already positively shut down, and the runtime evidence remains recoverable.

The final six owning-boundary tests were executed against the unchanged base
`622e12d4d`: four failures demonstrated the skipped STOP and the missing join
fence. The same cases passed five unchanged runs after the fix. The existing
12-case billing STOP/retain family also passed. Tests execute the actual
claimed-pool cleanup block with an isolated fake native boundary, including a
STOP acknowledgement that never transitions to STOPPED.

## Solution

Keep unconfirmed guest shutdown or unjoined owned processes fenced from STOP.
For positively shut-down guests with complete joins, verify each claim still
belongs to this controller, then use the existing STOP and observed-STOPPED
polling path even when runtime copying failed. In that case retain the claim,
all evidence latches, configuration, IDs and volumes. Do not destroy tainted
Machines while evidence is incomplete. Normal fully verified pool return still
releases its exact claim only after native STOPPED verification.

This does not weaken guest shutdown, invent idle evidence, change timeouts, or
claim that unrelated retained fresh allocations have become safe to stop.
Provider execution and deployment were explicitly excluded from this task.

## Human feedback

The user requires CLI teardown to stop verified idle owned Machines and query
Fly until STOPPED, while preserving IDs, volumes, data, protected warm capacity,
and Freedom. A STOP acknowledgement alone must never count as success.

## Reusable lesson

Evidence retention and compute shutdown require separate decisions. Positive
guest shutdown and joined producers can permit an exact owned STOP while
missing runtime files still require retaining the claim and all data. Poll the
provider to the actual terminal state before recording that compute stopped.
