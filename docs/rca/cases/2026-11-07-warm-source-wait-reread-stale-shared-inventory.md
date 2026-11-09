---
id: 2026-11-07-warm-source-wait-reread-stale-shared-inventory
date: 2026-11-07
title: Fleet warm-source wait re-read the stale shared inventory generation, turning a one-second donor update into an INFRA stop
surface: infra
component: run-bench-fleet-warm-source-wait
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: scripts/run-bench-fleet warm-source stop wait — after cloudbench_wait_machine_stopped saw the donor stopped via the direct read, it re-listed through campaign_inventory_capture/fleet_admission_machines_json, which returned the borrowed shared snapshot generation that still recorded `replacing`
symptoms:
  - "❌ warm source must be stopped before fleet provisioning (state=replacing)"
  - "⏳ warm source is replacing; waiting until stopped before fleet provisioning"
  - "INFRA STOP: 1/9 scheduled jobs are confirmed infrastructure failures (>= 5%)"
  - "infra canary preflight FAILED (exit=1) — refusing capability fleet (INFRA)"
tags:
  - cloudbench
  - warm-source
  - shared-inventory
  - campaign
  - stale-snapshot
  - deploy-smoke
sources:
  - PR #1745
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_fleet_warm_source_wait_rereads_a_newer_shared_generation
status: fixed
---

## Problem

During the PR #1745 `/deploy` (2026-11-07) the cloud smoke campaign failed
twice within minutes of launch. Each time one job logged
`⏳ warm source is replacing; waiting until stopped before fleet provisioning`
immediately followed by
`❌ warm source must be stopped before fleet provisioning (state=replacing)`,
which the campaign counted as INFRA (1/9 ≥ 5%) and used to cancel every job.
On the second run all nine jobs failed this way. Fly events for the donor
`683e47df5094d8` show only one-second updates (`launch` 03:12:31 → `stopped`
03:12:32; 03:20:12 → 03:20:13): concurrent park/maintenance by my own jobs on
the first run and by another workspace's fleet on the second. The campaign's
shared `machines.json` still read the donor as `stopping`/`replacing` after it
had stopped.

## Diagnosis

The wait was designed to tolerate a sibling's park/update: it polls the direct
machine read (`pool_machine_state`) until `stopped`. The direct read saw
`stopped` at once (the helper printed no per-attempt line), but the following
re-list used `fleet_admission_machines_json`, which in a campaign borrows the
parent publisher's snapshot. That generation had been captured during the
update, so it still said `replacing` and the fleet exited. Every borrower read
the same stale generation, so one transient failed them all.

Repro: the new regression test runs the real extracted wait with a direct
read of `stopped` and a shared feed whose current generation says
`replacing`. On the pre-fix logic (the old block wrapped unchanged as the
function, via `CLOUDBENCH_FLEET_SCRIPT_UNDER_TEST`) it fails with
`❌ warm source must be stopped before fleet provisioning (state=replacing)`.

Why possible: the wait mixed two observation sources with different freshness
and treated the slower one as authoritative without fencing on generation.
Gate: NOT_INTRODUCED for PR #1745's product change; it blocked the deploy's
required smoke, so the deploy owner fixed it.

Golden reference: not applicable (no approval-gated hunk).

## Solution

The wait is now `await_stopped_warm_source`. After the direct read sees
`stopped`, it re-lists; while a shared snapshot still disagrees it waits for a
newer generation with the existing `refresh_machines_snapshot_after` fence,
within the original stop budget (attempts × sleep). A live list (no snapshot
loop) still fails closed at once, as before. The donor is still never stopped
by the wait. The regression passes post-fix; the existing structural ordering
test and 47 warm-source tests pass. 10k-agent behavior: no new provider
reads; borrowers wait on the existing shared publisher instead of failing.

A separate, still-open defect multiplied the cost: every cancelled smoke
campaign leaves its `agent_link_server.py` (ppid 1) behind, so the deploy
cycle's smoke receipt retains a cleanup owner and cannot be re-executed; each
smoke infra stop forced a full cycle re-init.

## Human feedback

None recorded.

## Reusable lesson

When a wait polls a fast direct read and then re-reads through a shared snapshot, fence the re-read on a newer snapshot generation; never let a cached sample overrule the observation the wait just made.
