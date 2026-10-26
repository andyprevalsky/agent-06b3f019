---
id: 2026-10-26-startup-deadline-controller-never-sealed-runner-spun
date: 2026-10-26
title: Seal deadline after controller creation left the runner spinning with no probes after a refused workspace cleanup
surface: infra
component: cloudbench-original600-runner
classification: our-bug
problem_class: unbounded-wait-on-unreachable-owner
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
  - full run original600-1792981113422153716 shard-02 (machine 8940e1a6439768, volume vol_r685d3pq56l0mzn4, source ae2f7366c)
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

## Fix

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

## Verification

The new test fails on ae2f7366c ("runner spun after a refused workspace
cleanup": no probes) and passes with the fix. The full
`original600-portable-operator` structural gate passed 5 consecutive runs.
The live shard-02 controller was recovered the same way through the pinned
helper: seal, then download (sha matched manifest and on-host bytes), then
export-ready, then cleanup. The Machine was destroyed and the volume reached
pending_destroy.

## 10k-agent behavior

This adds one native list call and one helper call per stuck controller, only
on this failure path.
