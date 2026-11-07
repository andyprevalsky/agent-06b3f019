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
  - "volume destroy reconcile 6/6 id=vol_rnzx135j8xzo9okr state=waiting_for_detach (DELETE not resent)"
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
  - benchmark run campaign-20261107-225538-1478726 (descend I-32 proof-B teardown)
  - fleet run 20261107-231158-1917439
  - benchmark run campaign-20261107-232156-2232678 (proof-B2 startup recovery r001-j0001)
  - fleet run 20261107-232223-2242918
  - benchmark run campaign-20261107-181733-711331 (epoch 18 r003-j0029..j0032)
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

## Recurrence 2026-11-07 (descend I-32)

The aged-intent fix did not hold for a startup that comes soon after the
teardown. Proof-B (campaign-20261107-225538-1478726) got TERM at 23:17:54 while
four clones were provisioning. Each teardown destroyed the Machine, sent the
once-only volume DELETE (intents 23:17:59–23:18:03) and then read
`waiting_for_detach` on reconciles 2/6–6/6 and returned 75. Proof-B2
(campaign-20261107-232156-2232678, r001-j0001 lines ~226–266) started at
23:21:56. Its startup recovery of the four dead owners (33d0d094, 6330e5ce,
ee9958bb, fdfb01aa) read every volume as `created`, unattached ×6 with
`(DELETE not resent)`. The intents were 4–7 minutes old, below the 600 s
`CLOUDBENCH_VOLUME_REDELETE_AFTER_SECONDS` gate, so `fleet_disposable_redelete_intent`
returned 3. `reap_volume` returned 1 and the startup failed (descend I-33).
Epoch 18 (r003-j0029..j0032, owners 14879062/50e626e8/dbb919eb/84333329) shows
the same TERM-during-provisioning sequence. Its four volumes stayed `created`,
unattached for at least 16 minutes (`/var/tmp/descend-e18/be18-vol-audit-*.txt`).

What the Fly evidence shows. Fly's docs do not list `waiting_for_detach` (see
https://docs.fly.io/volumes/volume-states and the Machines volumes API). It is a
state Fly shows after a DELETE:

- At 23:29:53–23:32:27 `--recover-stale-owner` (intents now older than 600 s)
  sent one more DELETE to each `created`, detached volume. Each read
  `waiting_for_detach` twice and then `pending_destroy`; all four read
  `pending_destroy` at 23:34:43–45 (`/var/tmp/descend-e20p/recover-*.log`,
  `be20p-recovery-volume-receipts.txt`).
- When the DELETE is honoured, `waiting_for_detach` lasts about two reads before
  a terminal state. Examples: the proof-B infra canary (vol_rnzx162yd8p1mq0r and
  vol_r1jd71wlon2p1ppr, recorded `destroyed-provider-retained`) and epoch-18
  owner 0e72c495.
- When it is dropped, `waiting_for_detach` lasts all six reads and then becomes
  `created`, unattached. That happened to 12 volumes in b1e3, 4 in epoch 18 and
  4 in proof-B.

An honoured DELETE never went from `waiting_for_detach` back to `created`. Once
`waiting_for_detach` has been seen after our DELETE, a later exact `created`,
detached read means Fly finished that DELETE without deleting. The age gate is
then unnecessary. The ambiguous in-flight window (r004-j0014: `created` for a
few reads before `pending_destroy`) never passes through `waiting_for_detach`.

Separate gap: a coordinator audit built from `flyctl volumes list --json`
without `--all` returns only `created` volumes. It reported these volumes ABSENT
while they were in `waiting_for_detach`. In-repo teardown and recovery already
decide absence only from the exact `volumes show <id>` read
(`volume_inventory_contains_id`). The list was the coordinator's private
`/var/tmp/descend-e20/be20-cleanup.py`.

Fix. `reap_volume` now records a once-only receipt,
`disposable-delete-volume-<id>.detach-observed.json` (same owner/app policy,
O_EXCL, fsync), the first time an exact read after a dispatched disposable
DELETE shows `waiting_for_detach`. `stale_registry_only_waits_for_provider_detach`
records the same receipt. `fleet_disposable_redelete_intent` admits its single
re-dispatch when that receipt exists or when the intent is older than 600 s.
Everything else is unchanged: the volume must be exact, `created` and detached,
the re-dispatch is once-only, and attached volumes or spent re-dispatches are
refused. At most two DELETEs are sent per volume.

Red→green: `scripts/tests/cloudbench-disposable-lifecycle.test.py`
`test_startup_recovery_resends_a_delete_fly_dropped_while_waiting_for_detach`.
The fake provider replays the observed sequence: first DELETE →
`waiting_for_detach` ×6 → `created`; second DELETE → `waiting_for_detach` ×2 →
`pending_destroy`. It runs `reap_machine` teardown, then
`reap_registry_clones stale` 4 minutes later.

- On base 397c28a3ae it failed. Startup printed
  `volume destroy reconcile 1/6..6/6 id=vol_owned state=created (DELETE not resent)`,
  `could not destroy volume vol_owned` and `startup=1`, with one DELETE.
- On the fix it passes: two DELETEs, `startup=0`, `destroyed-provider-retained`,
  record retired.

Controls: an attached volume and a spent re-dispatch get no DELETE.
`test_second_dropped_delete_is_not_resent_and_retains_ownership` checks that a
second drop is not re-sent and ownership stays (bounded at two DELETEs).

10k agents: one extra once-only receipt write per owned volume that reaches
`waiting_for_detach`. No new reads, polling or shared state.

## Human feedback

None recorded.

## Reusable lesson

A once-only mutation fence must distinguish an in-flight request from one the
provider accepted and dropped; give the exact-owner path a bounded, aged,
identity-checked re-dispatch instead of an unconvergeable read loop.
