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
  - "could not destroy volume vol_rnzx135j8xzo9okr — exact-owner recovery retained"
  - "infra_stop r001-j0001 anti-bot-apple-uk-macbook-pro INFRA_ERROR infra_jobs 1 scheduled_total 9"
tags:
  - cloudbench
  - fleet
  - volume
  - recovery
  - ownership
sources:
  - PR #1299
  - fleet run 20260929-194204-11550
  - benchmark run campaign-20261107-232156-2232678 (descend I-33 r001-j0001)
  - fleet run 20261107-232223-2242918
  - commit d73073baa1
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

## Recurrence 2026-11-07 (descend I-33)

The deferral covered only volumes that read `waiting_for_detach`. Proof-B2
(campaign-20261107-232156-2232678) started at 23:21:56. Its first job's startup
found four same-host dead owners (33d0d094, 6330e5ce, ee9958bb, fdfb01aa). Each
was left with one exact, unattached volume whose accepted teardown DELETE Fly
had dropped (see descend I-32 in
2026-11-06-stale-owner-recovery-never-resends-dropped-volume-delete). Those
volumes read `created`, not `waiting_for_detach`, so the deferral before and
after reaping refused them. `reap_registry_clones` failed and
`reconcile_stale_fleet_registries || exit 1` exited the new controller before
it allocated anything. r001-j0001 became INFRA_ERROR. With a fixed total of 9,
the infra-stop rule (20 × 1 ≥ 9) cancelled the whole campaign at 23:24:59. The
new fleet did not need any of those volumes.

Fix. The check after `reap_registry_clones` now calls
`stale_registry_only_waits_for_provider_detach <registry> after-reap`. In that
mode a typed disposable owner with an already dispatched DELETE intent may also
leave `created`, unattached volumes (`attached_machine_id` and
`attached_alloc_id` empty). That covers a dropped DELETE whose single
re-dispatch is spent or was dropped again. Every other precondition is
unchanged:

- v2 registry, no guest or runtime latches, no pool claims;
- canonical records;
- each exact Machine absent, or `destroyed` with the same name and mounted
  volume;
- not a warm volume.

The registry, its records and its capacity reservation stay owned. The next
startup or `--recover-stale-owner` retries; ownership is never released. The
check before reaping still requires `waiting_for_detach`, so a `created`
volume still goes through the reap that re-dispatches its dropped DELETE.
Legacy registries keep needing a fresh accepted destroy and a
`waiting_for_detach` read.

Red→green: `scripts/tests/cloudbench-disposable-recovery.test.py`
`test_fresh_controller_retains_unconverged_dead_owner_volume_and_runs_its_job`.
A dead owner's teardown DELETE ends in `waiting_for_detach`, Fly then drops it
(`created`, and a re-sent DELETE is dropped too). Variants: re-dispatch dropped
again, and re-dispatch already spent. A new controller runs
`reconcile_stale_fleet_registries || exit 1` and then
`provision_primary_machine`.

- On base 397c28a3ae it failed: exit 1 after
  `volume destroy reconcile 1/6..6/6 state=created (DELETE not resent)`, and no
  allocation.
- On the fix both variants pass: startup returns 0, the dead-owner record stays
  byte-identical, `retained dead-owner registry` is printed, and the new
  controller creates its own Machine.

Control: `test_attached_created_volume_still_blocks_startup` keeps fail-closed
startup for an attached volume. This suite is now registered in the deploy
structural gates. Before, only `scripts/test.sh` ran it.

At 10k agents: no new provider calls. The check reuses the exact read it
already makes.

## Human feedback

The user requires ten sequential slices of ten benches with no INFRA failures,
at least three successful LLM queries per bench, smoke coverage, exact teardown,
per-bench and per-slice wall times, and inspection for hidden infrastructure
slowdowns. The temporary proof timeout is five minutes per bench and the hard
full-run cutoff is 30 minutes.

## Reusable lesson

Keep exact provider cleanup ownership without making an unrelated fleet wait
for an unattached provider-side deletion transition.
