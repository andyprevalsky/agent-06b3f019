---
id: 2026-09-29-pending-fly-volume-detach-blocked-unrelated-fleet
date: 2026-09-29
title: A canceled Fly volume waiting for detach blocked an unrelated healthy fleet
surface: infra
component: cloudbench-fleet-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: run-bench-fleet reconcile_stale_fleet_registries failed startup when the only stale resource was an exact owned unattached waiting_for_detach volume
symptoms:
  - "destroy accepted for volume but exact absence has not converged"
  - "waiting_for_detach"
  - "new cloud fleet exited before any benchmark started"
tags:
  - cloudbench
  - fleet
  - volume
  - recovery
  - ownership
sources:
  - PR #1299
  - fleet run 20260929-194204-11550
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: open
---

## Problem

An unnecessary 40 GB replacement clone was canceled before startup. Its exact
Machine entered Fly's `destroyed` state, but Fly continued to expose the volume as
`waiting_for_detach` with no attached Machine, after accepting volume deletion.
The exact owner registry correctly retained the volume. The next proof slice
exited before any bench started because generic stale-owner reconciliation
required that unrelated transitional volume to reach terminal deletion first.
That slice has zero acceptance credit.

## Diagnosis

The path was canceled clone allocation → exact Machine destruction → accepted
volume destroy → Fly `waiting_for_detach` → dead-owner registry retention → next
fleet startup. The provider's slow detach is external; the first owned failure
was treating every retained dead-owner resource as a startup blocker even when
the only remaining resource was a known, unattached transitional volume with no
pool claim. The existing `reap_volume` terminal criteria are correct: the
volume is not deleted and must retain exact ownership. The new fleet does not
need that deleted Machine or volume.

Archive searches used `destroy accepted exact absence has not converged
waiting_for_detach` and `stale fleet registry blocks unrelated fleet provider
volume detach`. The September 9 default-list omission case is related, but
its strict exact-ID terminal-state rule remains intact. This incident is a
separate admission coupling, not a recurrence of false ownership release.

The local owning-boundary test on the prior script failed six cases with
`ValueError: substring not found` because no deferred-detach boundary existed.
The unchanged test passes all six cases on the fix. Its negative controls
reject a created volume, foreign attachment, live Machine, and outstanding
pool claim; the positive case leaves the exact registry record byte-identical.

## Solution

Before generic stale-owner reaping, admit a subsequent independent fleet only
when every remaining clone record is canonical, every exact Machine is absent
or `destroyed` with matching name and current mounted-volume identity,
there are no unconfirmed guest/runtime latches or pool claims, Fly accepts a
fresh destroy request for each exact volume, and an exact volume read reports
`waiting_for_detach` with no attachment. Keep the dead-owner registry and its
recovery lock discipline; future startups or exact-owner recovery retry the
real deletion. Every other ambiguous state still blocks startup. This removes
the six-attempt destroy wait from the healthy fleet's critical path.

Cloud outcome proof and ten consecutive complete slices are pending. No task,
model, prompt, evaluator, scoring rule, benchmark definition, or normal timeout
changed.

## Human feedback

The user requires ten sequential slices of ten benches with no INFRA failures,
at least three successful LLM queries per bench, smoke coverage, exact teardown,
per-bench and per-slice wall times, and inspection for hidden infrastructure
slowdowns. The temporary proof timeout is five minutes per bench and the hard
full-run cutoff is 30 minutes.

## Reusable lesson

Keep exact provider cleanup ownership without making an unrelated fleet wait
for an unattached provider-side deletion transition.
