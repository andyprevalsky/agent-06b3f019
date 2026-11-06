---
id: 2026-11-06-stale-owner-recovery-never-resends-dropped-volume-delete
date: 2026-11-06
title: Stale-owner recovery never re-sent a volume DELETE that Fly accepted during waiting_for_detach and then dropped
surface: infra
component: run-bench-fleet reap_volume (disposable once-only DELETE)
classification: our-bug
problem_class: other
first_bad_boundary: scripts/run-bench-fleet reap_volume — with DISPOSABLE_REAP=1 an existing disposable-delete-volume intent (once_status=2) forbids any further DELETE, so an exact owned volume back in state created is only re-read
symptoms:
  - "volume destroy reconcile 1/6 id=vol_vgnqm710jmlxo0z4 state=created (DELETE not resent)"
  - "could not destroy volume vol_vgnqm710jmlxo0z4 — exact-owner recovery retained: flyctl volumes destroy"
  - "destroy accepted for volume vol_vgnqm710jmlxo0z4 but exact absence has not converged — retaining exact ownership"
tags:
  - cloudbench
  - fly-volumes
  - stale-owner-recovery
  - teardown
  - disposable-lifecycle
sources:
  - fleet run 20261106-102901-3314359
  - task google-drive-lease-recall
  - task family-office-angel-outreach
  - task summary-site-no-filetype
repro: scripts/tests/cloudbench-disposable-lifecycle.test.py
status: fixed
---

## Problem

After /descend batch 1 epoch 3 (campaign-20261106-095011-2029870) stopped at
its infra threshold, 15 fleet owners were retained. `scripts/run-bench
--recover-stale-owner` failed for 13 of them because 12 exactly-owned volumes
stayed in state `created` after their Machines were destroyed. The operator had
to run `flyctl volumes destroy` by hand on each one, then repeat recovery.

Evidence for one of them, `vol_vgnqm710jmlxo0z4` (google-drive-lease-recall,
fleet 20261106-102901-3314359, owner 657cf762…):

- Teardown (`r002-j0027.log`): the single DELETE was accepted silently, then
  `volume destroy reconcile 2/6 … 6/6 state=waiting_for_detach (DELETE not
  resent)` and `destroy accepted for volume … but exact absence has not
  converged — retaining exact ownership`.
- Recovery (`/var/tmp/descend-b1e3/recover-657cf762….log`): `volume destroy
  reconcile 1/6 … 6/6 state=created (DELETE not resent)`, then `could not
  destroy volume … exact-owner recovery retained`.

The same sequence covers the other 11 volumes in
`/var/tmp/descend-b1e3/retained-vols.txt`.

## Diagnosis

1. `reap_machine` destroys the Machine and then calls `reap_volume`. The
   volume is still `waiting_for_detach` when the first DELETE goes out.
2. Fly accepts that DELETE (exit 0, no output), but it does not destroy the
   volume. Once detach completes, the volume reads `created` again. It never
   reaches `pending_destroy`/`destroyed`, unlike the 35 volumes in the same
   epoch whose DELETE arrived after detach and which recorded
   `destroyed-provider-retained`.
3. With a disposable registry, `fleet_disposable_delete_intent` records the
   DELETE once-only. Every later pass, including `--recover-stale-owner`,
   gets once_status=2 and takes the "keep reconciling exact GET; never repeat
   DELETE" branch. Recovery can therefore only read `created` six times and
   fail; nothing in the owned code path can converge.

The once-only rule protects against duplicating an in-flight DELETE. A
`created` read a few seconds after an accepted DELETE is normal: the existing
regression for r004-j0014 shows `created` for three reads before
`pending_destroy`. The rule had no way to tell that transient window apart
from a DELETE the provider dropped, so it retained ownership forever.

## Solution

`reap_volume` may now re-dispatch exactly one more DELETE for a volume when
all of these hold:

- a disposable once-only DELETE intent already exists (once_status=2);
- an exact `volumes show` read returns the same ID, state `created`, and no
  `attached_machine_id` / `attached_alloc_id` (`volume_exact_created_detached`);
- the original intent file is older than
  `CLOUDBENCH_VOLUME_REDELETE_AFTER_SECONDS` (default 600 s), so an accepted
  DELETE still inside its transient window is never duplicated;
- a new once-only `disposable-redelete-volume-<id>.json` record is created
  atomically (O_EXCL, fsync) under the same owner/app policy checks
  (`fleet_disposable_redelete_intent`).

Anything else (an attached volume, a recent intent, an already-spent
re-dispatch, an identity mismatch or an unreadable state) keeps the previous
reconcile-only behavior and retains ownership. Machines are unchanged.

The regression in `scripts/tests/cloudbench-disposable-lifecycle.test.py`
covers the dropped-DELETE recovery (fails on the previous `reap_volume` with
the observed "reconcile 1/6 state=created (DELETE not resent)" and rc 1;
passes with exactly one DELETE and rc 74 after the fix), a recent intent, an
attached volume and an already re-dispatched volume. The suite is now
registered in the deploy structural gates; before this change it ran only from
`scripts/test.sh`.

At 10k agents this adds at most one exact `volumes show` read and one DELETE
per retained owned volume during teardown or recovery. There is no new shared
state or polling.

A related gap remains open: owners 99384ab3… (family-office-angel-outreach)
and d87f562b… (summary-site-no-filetype) hold zero clone records, and their
Machines and volumes are absent on Fly. Only the `runtime-evidence-unconfirmed`
latch remains, and `--recover-stale-owner` refuses at
`fleet_recovery_confirm_runtime_evidence` ("sealed runtime evidence is
absent"). main has no supported command that retires such an owner. The
documented `evidence-retire` exists only on the unmerged `tools/evidence-retire`
branch, and it retires worktree evidence, not owner claims.

## Human feedback

None recorded.

## Reusable lesson

A once-only mutation fence must distinguish an in-flight request from one the
provider accepted and dropped; give the exact-owner path a bounded, aged,
identity-checked re-dispatch instead of an unconvergeable read loop.
