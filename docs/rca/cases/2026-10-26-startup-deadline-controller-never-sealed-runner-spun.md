---
id: 2026-10-26-startup-deadline-controller-never-sealed-runner-spun
date: 2026-10-26
title: Seal deadline after controller creation left the runner spinning with no probes after a refused workspace cleanup
surface: infra
component: cloudbench-original600-runner
classification: our-bug
problem_class: other
first_bad_boundary: scripts/cloudbench-original600-runner.py:run (cleanup-workspace refusal with an existing allocation had no seal/re-probe path)
symptoms:
  - "Deadline: controller action deadline (disposable-controller seal, slow Fly read)"
  - GATE_HOST_RETAINED machine=<id>
  - "cleanup-workspace: Machine allocation exists or is ambiguous; seal/export required"
  - "cleanup.pending.json PENDING_EXTERNAL_OWNER_LIVE no_cleanup_retry; no supervisor probe files"
  - controller idles STARTED (GATE_EXPORT_IDLE_UNTIL) while billing
tags:
  - cloudbench
  - disposable-controller
  - sharded-original600
sources:
  - fleet run original600-1792981113422153716 shard-02 (machine 8940e1a6439768, volume vol_r685d3pq56l0mzn4, source ae2f7366c)
  - commit 69a00928b
repro: scripts/tests/original600-portable-operator.test.py (Portable.test_startup_deadline_controller_is_sealed_reprobed_and_released, test_startup_deadline_ambiguous_or_refused_seal_never_releases)
status: fixed
---

## Problem

The gate's `seal` call hit the controller action deadline during a slow Fly
read, after the controller Machine had already been created and started. No
`disposable-controller.ownership.json` was written. The gate retained the host
and exited. The runner picked `cleanup-workspace`, which correctly refused the
existing allocation. The runner then held a finished cleanup handle and no
Machine ID, so it never probed, downloaded or released anything. Meanwhile the
controller ran its campaign and idled, billing, while it waited for an export
download.

## Diagnosis

First-bad boundary: `scripts/cloudbench-original600-runner.py`, the
startup-failure path. A deadline during `seal` happens after the controller
Machine exists. The runner treated "no ownership record" as "nothing was
created" and chose `cleanup-workspace`. That cleanup correctly refused, and the
runner had no path back to probing or export download. Fly reported IAD packet
loss at the time, which made the seal read slow; the defect is the runner's
missing recovery state, not the provider. Problem class `other`: proposed class
"unbounded wait on an unreachable owner" (same class as
2026-10-25-runner-spun-forever-on-stopped-controller-after-suspend).

## Solution

When `cleanup-workspace` exits non-zero with no release and no ownership record,
the runner looks up the exact Machine by its create-intent name. Exactly one
match is required. It runs the pinned helper's `seal` once, which re-validates
name, image, shape, mount and volume attachment. It renames the refused intent
to `cleanup-call.workspace-refused.json`, resets to the controller path and
writes `export-recovery-required.json` (`EXPORT_DOWNLOAD_REQUIRED_SEAL_RECOVERED`).
It does not send launch sidecars to an already-joined controller. Once the
export is verified, the normal `cleanup` runs once and ends with
`CONTROLLER_RELEASE_VERIFIED`. Ambiguous or missing matches and a refused seal
never release anything.

### Verification

The new test fails on ae2f7366c ("runner spun after a refused workspace
cleanup": no probes) and passes with the fix. The full
`original600-portable-operator` structural gate passed 5 consecutive runs.
The live shard-02 controller was recovered the same way through the pinned
helper: seal, then download (sha matched manifest and on-host bytes), then
export-ready, then cleanup. The Machine was destroyed and the volume reached
pending_destroy.

### 10k-agent behavior

This adds one native list call and one helper call per stuck controller, only
on this failure path.

## Human feedback

None during the RCA. Infra fixes need no approval under the standing rule. The
parent verified the recovery natively and ended the stuck runner by exact PID.

## Reusable lesson

A deadline after a provider create is not proof that nothing was created. Before
choosing a "nothing exists" cleanup, look up the exact resource by its recorded
create intent. If exactly one match exists, recover it through the normal owner
path. If the match is ambiguous or missing, keep ownership and never release.
