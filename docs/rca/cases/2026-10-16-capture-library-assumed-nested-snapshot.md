---
id: 2026-10-16-capture-library-assumed-nested-snapshot
date: 2026-10-16
title: Worker token resolution assumed nested libraries inside a flat fleet snapshot
surface: infra
component: cloudbench-original-volume-capture
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cloudbench-original-volume-capture.py bash_lib resolved only scripts/lib while the canonical fleet snapshot stores shell libraries beside Python helpers
symptoms:
  - "resolve_fly_token failed (exit 127)"
  - "autoscaler.failed"
  - "worker-clones.ids remained empty after scale up +1"
tags:
  - cloudbench
  - staged-worker
  - snapshot
  - shell-library
sources:
  - PR #1525
  - fleet run 20261016-175139-10334
  - commit d7c6300206afade18e582c9c14bb227a774889d0
repro: sudo -n python3 scripts/tests/cloudbench-explicit-idle-admission.test.py WorkerStageSnapshotToken PreconfigSnapshotLayout
status: open
---

## Problem

Actual worker qualification attempt 54 requested one worker after its N2
preflight passed. The autoscaler then failed before staging that worker:
`cloudbench-staged-boot-return.py` called the original explicit-admission
entrypoint, which invoked `resolve_token`, ending in the exact exit-127 refusal.
The main REAL task continued; no worker runtime qualification is inferred.
Original evidence is retained in the root continuation packets
`read-during-publisher-879ff8941bfdbf4a/response.json` and
`read-during-publisher-9ce5424458b3d42e/response.json`. The latter confirms the
snapshot has `cloudbench-inventory.sh` beside its Python scripts and no `lib/`
directory. Original assignment, claim, and failed outcome remain unchanged.

## Diagnosis

Canonical fleet copy list -> flattened immutable snapshot -> staged worker
entrypoint -> original admission `main` -> original capture `resolve_token` ->
`bash_lib` -> shell library source is the failing path. `bash_lib` constructed
`<snapshot>/lib/cloudbench-inventory.sh`; source failed, but the shell continued
to an undefined `resolve_fly_token`, producing 127. The recorded working
directory is not sufficient to explain a missing shell function: the absolute
library path is already wrong. The local repro preserves the canonical copy
list, original main and stage validators, and substitutes only the provider
transport with an offline callback. It fails at the identical 127 boundary and
passes through real GET-only worker staging after the correction.

Archive searches were `resolve_fly_token exit 127` and `flattened snapshot shell
library`; neither returned this token-resolution incident. The existing
`PreconfigSnapshotLayout` regression covered the same layout for a separate
preconfig PID helper but explicitly expected the shared capture helper to
remain broken. This is a related incomplete convergence: the local repair did
not fix the general shared shell-library resolver. That obsolete inverse is
now a positive regression for the shared helper.

## Solution

The shared capture resolver supports the two actual producer layouts: prefer
the repository's nested library, otherwise select the flat snapshot sibling.
Validate that selected input using the existing regular-file, no-follow reader;
missing and linked libraries still refuse. A failed shell source must exit
before invoking its function. The original shell token precedence, worker
admission module, stage/return predicates, provider budgets and task profiles
are unchanged. Existing `cloudbench-explicit-idle-preconfig.py:pid_birth_state`
is the in-repository reference for the two layouts; external agent loops do not
produce this fleet-specific snapshot format.

Six new registered controls exercise the canonical flat-copy worker entrypoint,
repository entrypoint, missing/linked library refusal, shell-source failure,
and nested-layout precedence. Four existing preconfig layout controls remain.
The baseline flat-worker test failed with the same 127 refusal; the unchanged
test passes after the fix. This adds no per-machine scan or provider call.
The case stays open until root executes the exact worker qualification and
verifies its real runtime, STOP and release; local transport fixtures do not
prove that outcome. No native operations were performed by this lane.

### Failed-prestage recovery boundary

The later task PASS does not erase the unresolved worker claim. Current cleanup
correctly rejects the missing worker return. Any recovery must be a separate
explicit action: pin the original assignment, exact claim, autoscaler failure,
and absent stage/START/guest artifacts; prove the original owner and children
have joined; acquire the canonical recovery and MID locks; then collect fresh
exact STOPPED Machine/Volume evidence. A distinct NOT_LAUNCHED recovery receipt
may describe that evidence. It must not fabricate a staged-success or ordinary
worker-runtime return, nor replay the original stage. No recovery code or native
recovery is included in this source fix.

## Human feedback

The root operator required an isolated source reproduction and registered
regression, preserving the original failure and active attempt. No timeout,
credential-policy, task-profile or runtime-evidence relaxation was authorized.

## Reusable lesson

Resolve shared shell libraries through the snapshot producer's actual layouts and exercise the real flattened entrypoint before qualifying a worker path.
