---
id: 2026-07-25-marker-cleanup-enumerated-via-eventually-consistent-visibility
date: 2026-07-25
title: Worker-activation marker cleanup enumerated workflows through eventually-consistent Temporal visibility, so a just-created marker was missed
surface: infra
component: deploy-pipeline
classification: our-bug
problem_class: fixture-environment-data-mismatch
first_bad_boundary: "cleanupSupersededWorkerActivationMarkers — enumerates markers via Temporal visibility (Elasticsearch), which is eventually consistent"
symptoms:
  - "13ac same_sha_old_marker_is_retired_without_retiring_current_attempt flakes"
  - a just-created activation marker is absent from a visibility list query
tags:
  - temporal
  - visibility
  - eventual-consistency
  - deploy-gate
  - flake
sources:
  - PR #897
  - memory:project_temporal_cutover_first_prod_deploy
repro: none-recorded
status: fixed
---

## Problem

The deploy's 13ac validator flaked on
`same_sha_old_marker_is_retired_without_retiring_current_attempt`:
`cleanupSupersededWorkerActivationMarkers` enumerates activation markers via Temporal
**visibility** (Elasticsearch), which is eventually consistent, so a single pass can
miss a marker that was just created.

## Diagnosis

A correctness check was built on a read model that offers no read-your-writes
guarantee. The cleanup itself is idempotent and the routing path is safe —
routing uses exact marker IDs, not visibility, so a straggler is harmless and
self-heals on the next deploy — but the _validator_ asserted a post-condition
against the lagging index and therefore failed intermittently on correct behavior.
Worth knowing for future diagnosis: `RoseWorkerDeploymentActivationMarker` has no
worker at all; it is a started-but-never-executed pure marker/flag with no
continue-as-new.

## Solution

Retry the idempotent cleanup inside the validator with a bounded 60s window
(PR #897) so the eventually-consistent index has time to converge, rather than
weakening the assertion or removing the check.

## Human feedback

None recorded.

## Reusable lesson

Never assert a post-condition against an eventually-consistent index — retry the
idempotent operation within a bounded window, and check exact IDs where correctness
depends on it.
