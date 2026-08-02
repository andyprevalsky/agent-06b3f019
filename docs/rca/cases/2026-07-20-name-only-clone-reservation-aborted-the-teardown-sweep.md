---
id: 2026-07-20-name-only-clone-reservation-aborted-the-teardown-sweep
date: 2026-07-20
title: An id-less clone reservation left by an ambiguous clone failure aborted the teardown sweep and leaked every sibling machine
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: "run-bench-fleet provision loop — the name reservation written before `machine clone` is retained forever when the clone fails ambiguously, and teardown's Fly-list read on an id-less record hits the `*) return 1` reap arm"
symptoms:
  - teardown sweep aborts and leaves 7 already-provisioned clones running
  - clones must be reaped by hand from the ownership registry
  - a durable clone name record exists with no machine id
tags:
  - cloudbench
  - fly-io
  - teardown
  - resource-leak
  - reservation
sources:
  - commit ef0727d08
  - memory:project_ecommerce_slice_compute_token_gate
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

A real leak this session: the fleet's provision loop reserves each clone name
durably BEFORE calling `machine clone` (so a SIGKILLed controller can still find
its machines). One clone failed AMBIGUOUSLY — non-zero exit, no machine id
returned, and not the definitive `clone_failure_definitively_unallocated` — so the
name-only record was retained forever. At teardown, a transient Fly-list read on
that id-less record fell through to the `*) return 1` reap arm, which aborted the
whole sweep and **leaked all 7 already-id'd siblings**. They had to be reaped by
hand from the ownership registry
(`$GIT_COMMON_DIR/cloudbench-fleet-ownership/<owner>/clones/*`).

## Diagnosis

The reservation protocol had three real outcomes (bound to an id, definitely never
allocated, unknown) but the failure path only handled two, so "unknown" degraded
into a permanent record with no resolvable identity. Teardown then treated an
unresolvable record as a hard error rather than as a record to reconcile, and
because the sweep was all-or-nothing, one bad record converted into a fleet-wide
leak of paid resources.

## Solution

Fix at the source rather than in teardown: after a failed clone attempt, resolve
the reserved name authoritatively — bind the id if the machine did materialize,
RELEASE the reservation on definite absence, and retain it only when the read
itself was unsafe. Cemented as scenario 16 of
`scripts/tests/cloudbench-multi-workstream.test.sh`.

## Human feedback

None recorded.

## Reusable lesson

Reconcile an ambiguous resource reservation immediately at the point of failure —
never leave an id-less record for teardown to interpret, and never let one
unresolvable record abort a sweep that is holding paid resources.
