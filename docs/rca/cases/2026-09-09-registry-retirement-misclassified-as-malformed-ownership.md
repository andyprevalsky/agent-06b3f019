---
id: 2026-09-09-registry-retirement-misclassified-as-malformed-ownership
date: 2026-09-09
title: Concurrent registry retirement was misclassified as malformed ownership
surface: infra
component: cloudbench-fleet-ownership
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-fleet reconcile_stale_fleet_registries treated an owner-retired absent meta path as invalid controller identity
symptoms:
  - "❌ invalid controller identity in /workspace/.git/cloudbench-fleet-ownership/94038c7f8af44976bc5c56e7c60cf2d2"
  - valid version app cleanup policy and host were read before the ownership registry disappeared
  - registry_owner_alive returned invalid after re-reading the retired meta path
tags:
  - cloudbench
  - fleet
  - ownership
  - registry
  - concurrency
  - lifecycle
sources:
  - commit 9ae3456c19d52c8c363472d42f107e16f0c1f563
  - fleet run 20260909-195021-262313
repro: scripts/tests/cloudbench-multi-workstream.test.sh
status: fixed
---

## Problem

A one-task Polar Fleet reached valid Hub registration and then aborted startup
with `invalid controller identity` for owner token
`94038c7f8af44976bc5c56e7c60cf2d2`. The exact ownership path was absent after
the campaign controller completed provider teardown, so the terminal symptom
could not be explained by a still-present malformed registry.

The deterministic owning-boundary command
`CLOUDBENCH_TEST_REGISTRY_RETIRE_RACE_SELF_TEST=1 bash scripts/tests/cloudbench-multi-workstream.test.sh`
published a complete live-owner registry, started a concurrent owner process,
let the scanner read valid metadata, and made that exact owner remove its
registry before `registry_owner_alive` re-read the meta file. Before the fix the
command exited 1 with the same `invalid controller identity` error.

## Diagnosis

Critical path: a controller starts and enumerates shared ownership registries →
the scanner reads version, app, cleanup policy, and host → the live owner
finishes exact teardown and removes its registry → the scanner calls
`registry_owner_alive` → its now-missing metadata reads are empty and return
status 2 → reconciliation maps every non-live/non-dead status to malformed
identity → startup aborts before capacity admission.

Instrumentation proved the initial values were all valid while `metaPresent=0`
by the time owner classification began. The owner result was status 2 with the
path still absent. A companion fixture retained a malformed meta file and
produced the same status 2 with `metaPresent=1`.

The first bad boundary was therefore the scanner's status-to-lifecycle mapping,
not atomic registry publication or identity validation. The deepest owned cause
was a lifecycle-contract inconsistency: reconciliation had states for live,
dead, and malformed ownership but no benign transition for a registry whose
exact owner completed and retired it during observation.

## Solution

`reconcile_stale_fleet_registries` now rechecks the exact meta path before
turning a non-live owner classification into an error. A vanished path is a
completed owner lifecycle and the scanner continues; a still-present malformed
file remains a hard admission failure. No uncertain registry is reaped and no
ownership validation is relaxed.

The unchanged concurrency repro now passes, including its companion assertion
that the present malformed registry fails closed. The complete Cloud Benchmark
Lifecycle and fake-provider multi-workstream gates pass, and no live Fleet was
started or signaled.

At 10,000 agents the change adds only a constant-time local existence check for
each registry already encountered by startup reconciliation. It creates no
per-agent polling, provider calls, shared lock, fan-in channel, or accumulated
state.

## Human feedback

The user required a deterministic concurrent owning-boundary repro before the
fix, benign handling only for a vanished registry, continued fail-closed
handling for still-present malformed ownership, no paid benchmark, and no
interaction with any live Fleet.

## Reusable lesson

Revalidate lifecycle existence before classifying a concurrently removable ownership record as malformed.
