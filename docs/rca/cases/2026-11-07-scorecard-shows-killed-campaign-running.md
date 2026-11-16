---
id: 2026-11-07-scorecard-shows-killed-campaign-running
date: 2026-11-07
title: Scorecard rendered a SIGKILLed campaign as RUNNING because it never checked controller liveness
surface: infra
component: cloudbench-scorecard
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: load_campaign derived state only from summary.json status/finished_at
symptoms:
  - "🔵 RUNNING · QUEUED 19 · IN_PROGRESS 16"
  - "Since last benchmark ended: RUNNING"
  - "summary.json status running, finished_at None, controller PID gone"
tags:
  - scorecard
  - campaign
  - stale-data
  - controller-liveness
  - descend-i-22
sources:
  - commit d5fafdc1ec (base; fix on branch rca/i-22-20261107)
  - benchmark run campaign-20261106-224723-821219 (descend-launch-e14)
repro: scripts/tests/cloudbench-scorecard.test.py
status: fixed
---

## Problem

`scripts/run-bench scorecard <campaign_dir>` rendered campaign
`campaign-20261106-224723-821219` as `🔵 RUNNING`, `QUEUED 19 · IN_PROGRESS 16
· COMPLETED 22/57` and `Since last benchmark ended: RUNNING` hours after a
boxes.dev workload-scope restart SIGKILLed its controller (PID 821219,
`run-bench-campaign.py`) and every job controller at 00:11:39Z on 2026-11-07.
`summary.json` was last written at 00:11:08Z with `status: running` and
`finished_at: null`; `ps -p 821219` returned nothing. This violates the
standing "Never show stale data" rule: the card showed a dead run as live.

## Diagnosis

`load_campaign` set the experiment state only from `summary.json`: without
`finished_at`, the `empty_experiment` default `RUNNING` survived, and the
non-terminal job rows (`status: running`) became `IN_PROGRESS`. A SIGKILL
cannot run the controller's finalizer, so a killed campaign's summary stays
`running` forever. The renderer never compared the recorded controller
identity with the live process table.

The identity exists: the campaign inventory publisher
(`scripts/cloudbench-campaign-inventory.sh`) writes `shared-inventory/owner`
with `parent_pid` and `parent_start` (`proc-start:<boot_id>:<start ticks>`,
or `ps lstart` on macOS) for its campaign controller. For the real campaign
it records `parent_pid=821219`, `parent_start=proc-start:6af9c450-…:14927378`
on the current boot; `/proc/821219` is absent.

Repro: new fixtures in `scripts/tests/cloudbench-scorecard.test.py` with a
spawned-and-reaped PID, the current PID with mismatched start ticks, and no
recorded identity. Before the fix all three rendered `RUNNING` (3 failures:
`'RUNNING' != 'CONTROLLER LOST'` ×2, `'RUNNING' != 'UNVERIFIED'`). The old
renderer on the real campaign printed `🔵 RUNNING` / `IN_PROGRESS 16`.

## Solution

`load_campaign` now checks a non-terminal campaign's recorded controller
(`controller_liveness`, using the same identity form as the publisher):

- PID alive with the same birth: `RUNNING` (unchanged).
- PID absent/zombie, or reused with a different birth on the same boot:
  `🔴 CONTROLLER LOST · last update <summary.json mtime, Pacific>`. In-progress
  jobs render as `INTERRUPTED/UNRECONCILED`; all counts are preserved; the
  "since last ended" line shows `END UNRECORDED`; a red ISSUES row names
  exact-owner recovery of the job controllers and guests.
- Identity not recorded, recorded on another host boot, or unreadable:
  `🟠 UNVERIFIED`, with `IN_PROGRESS (UNVERIFIED)` and an amber issue.

Neither state is terminal or a pass. Terminal campaigns (`finished_at`) are
unchanged. The real campaign now renders `🔴 CONTROLLER LOST · last update
Nov 6, 4:11:08 PM PST · controller PID 821219 not alive`. The check is one
`/proc/<pid>/stat` read per rendered campaign, independent of agent count.

Follow-up gap: campaigns without the shared inventory publisher (concurrency
1, production-only, or publisher already exited) have no recorded identity and
render `UNVERIFIED` while live; recording the controller's own PID/birth in
`summary.json` would close it.

## Human feedback

None recorded.

## Reusable lesson

A non-terminal status written by a process is only current while that exact
process (PID plus birth) is alive; verify the recorded identity before
rendering it as RUNNING.
