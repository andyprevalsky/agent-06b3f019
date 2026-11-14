---
id: 2026-10-27-driver-prestack-cancel-evidence-gap
date: 2026-10-27
title: Driver cancellation during dependency setup acknowledged cleanup without representable runtime evidence
surface: harness
component: cloudbench-driver-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: driver cleanup before run.sh published an ACK but no supported pre-stack evidence seal
symptoms:
  - guest shutdown without sealed runtime evidence
  - runtime evidence is incomplete or changed
  - BILLING_STOP_REFUSED
  - accepted source lacked before-stack-launch recovery review
tags:
  - cloudbench
  - cancellation
  - prestack
  - evidence-retention
sources:
  - commit 34ff3f23e6efa9ced9ff75732357df973db14e86
  - benchmark run campaign-20261027-191411-2591810 r001-j0002 polar-bu-002
  - benchmark run 20261027-191440-2597567
  - task owner 49927b5b138945249cb5e040f87159c8
repro: python3 scripts/tests/cloudbench-prelaunch-cancel.test.py DriverPrestackCancel
status: open
---

## Problem

The Polar k2 batch was cancelled after its first confirmed infrastructure
failure. Nineteen of twenty primaries were gone when its controller exited;
Machine `8d9652df7e75e8` remained STARTED with volume
`vol_4qlw7ypw5xm9d9nr`. This cleanup problem is independent of the initial
infrastructure failure and of R1/R1a browser execution.

The launch owner performed the operational stop, requested at 19:36:03 UTC;
the native receipt reports STOPPED at 19:36:11 UTC. The volume remained attached
and no evidence or resource was deleted. This investigation performed no
provider mutations, deployment, or benchmark launch.

## Diagnosis

The original guest archive establishes these transitions on the exact source:

1. Boot began at 19:28:10 UTC. Git fetch took 161 seconds and checkout 65 seconds.
2. The native driver reached `git_sync` at 19:31:56, then `env_decode` and
   `dep_sync` at 19:31:57. It refreshed baked JavaScript and Python overlays.
3. The campaign received TERM at 19:32:24.721. The driver's log records graceful
   shutdown and the boot supervisor records `interrupt_status=0 cleanup_ack=1`
   and `rc=143` at 19:32:44.
4. The original controller did not record that ACK. It marked guest cleanup
   unconfirmed, changed its owner policy to `retain`, and the billing helper
   refused. No per-request shutdown-health trace survives; the reason the
   original controller missed the ACK is **unresolved**. Its absence must not be
   inferred from the later evidence failure.
5. Supported stale-owner recovery observed the ACK. Runtime capture returned
   HTTP 409 because the driver had no `services.json` or full stack bundle.
   It also had no boot-supervisor prelaunch seal, because the driver had run.
6. The fallback captured the exact original files and no live driver descendants.
   Its source-bound verifier then rejected executable fingerprint
   `674889fa712328fa44d5a20013d033bea2dde854a525f508f2720beaaca0c136`:
   the trusted policy did not approve `before-stack-launch` for this recipe.

The first representability defect is in the native driver's pre-stack terminal
transition: it can truthfully acknowledge cleanup but cannot publish the
corresponding runtime evidence. The existing prelaunch contract covers a boot
that never launches its driver; the complete-stack contract covers a launched
`run.sh`. Neither covers this intermediate state. The independent missing source
review prevents historical fallback recovery; it is not a provider failure.

Archive searches `BILLING_STOP_REFUSED` and `stale owner runtime evidence cleanup
bootstrap` found the October 16 billing-custody case and October 24 prelaunch
cancellation case. These are relatives. The latter's five existing controls and
all 26 billing controls pass on this source; the missing driver-phase control is
not the earlier boot-phase case.

## Solution

Implementation was independently reviewed before application. Exact patch
`d0cd2cb72651dc6ae1e31a0ae106ce63842758067419db2b03c185d0927dcb6c` was
marked GROUNDED by reviewer `ph7dr4b0p5nc2qjtnfhtgsqpmx8h2zq6`. It adds:

- The driver writes an exact-token pre-stack seal before ACK only when it never
  attempted stack launch, has no stack PID or active command, and no stack
  artifact exists. A launch-attempt latch is set before the asynchronous spawn,
  covering cancellation before PID assignment.
- Boot removes the previous generation's pre-stack seal with its other markers.
- The status owner requires the actual seal, ACK, exited driver, absent PID and
  absent stack artifacts. It serves the complete driver log and seal under a
  distinct `prestack` field, never claims the driver did not launch.
- Both collectors and the final fleet verifier preserve exact schema, token,
  hash, bounded read and atomic-publication checks. The result-free evidence
  discharges the runtime latch, with no benchmark result or streak credit.
- A separate source-policy entry for the original fingerprint is permitted only
  after independently reviewing that exact recipe's pre-stack boundary. It
  neither trusts future recipes nor widens any other phase.

Grounding is the existing native `publish_cleanup_ack`/`cleanup_stack` ownership,
boot `publish_prelaunch_seal`, and the real status/collector/fleet evidence
pipeline. The source-policy gate remains a committed-source gate. The original
archive replay must pass through it; a mocked policy is not proof.

## Verification

Baseline `python3 scripts/tests/cloudbench-prelaunch-cancel.test.py
DriverPrestackCancel` writes the real cleanup ACK, then fails in the actual
status manifest function with missing `services.json`, matching the HTTP409
boundary. The applied repair passes the same test through a real local HTTP server, both
collectors and the fleet validator. The registered six-test family passes, including
foreign-seal, live-PID, stack-artifact, active-command and launch-attempt refusal
controls. Existing boot-phase cancellation tests remain green.

A separate replay uses the exact original archive and config, remapping only
local custody paths. It reproduces the original source-policy assertion at
`cloudbench-forensic-retirement.py:213`. After committing the reviewed policy, the exact same archive replay passed:
`phase=pre-service`, `proof_credit=0`, `verified=true`. The original archive SHA256
is `41976e458a5495bc1fd80b2e31c2d8bd328ca5ddb26869eef141758eb1612e70`.
Final applied-source gates: six lifecycle tests passed; 102 existing
`driver_cleanup or runtime_evidence or prelaunch` controls passed; 14 pre-stack
recovery tests passed; the full bootstrap recovery suite completed 233 tests
with seven existing root-only tests skipped. Shell/Python syntax, exact reviewed
patch equality and RCA archive validation passed. No new campaign outcome or native ownership retirement is claimed.

Evidence is retained under `.context/polar-i5/`. The original native recipe
validates every injected executable against `34ff3f23e`, and produces recipe hash
`485a7583840095874d8651a372ac318fa9b154a92d818444a49920d0bc05d39d` and the
fingerprint above. The launch owner's original stopped receipt remains the
operational outcome, independent of local tests.

## Retained-volume handoff

The original Machine is already stopped; it cannot serve a new HTTP capture.
Do not restart the benchmark or manually promote the rejected archive. On the
launch owner, use the integrated reviewed source and the documented exact-owner
original-volume capture preflight for this owner, task, Machine and volume.
The generic capture path then boots only the exact retained volume with an inert
command, captures originals, stops it and restores its original configuration;
that operation requires the parent's coordination and is not performed here.
Build its interrupted-owner archive with the supported helper, then continue
`run-bench --recover-stale-owner 49927b5b138945249cb5e040f87159c8` through native
release verification. The reviewed source-policy entry admits only the original
pre-stack recipe. Archive readiness, physical STOP and full ownership retirement
remain separate receipts, each with zero task credit.

## Human feedback

The parent requested one I5 fix slot, no task edits, no paid runs or deployment,
and independent exact-snapshot grounding before runtime application. The launch
owner alone performs operational cleanup; do not race it. Preserve R1/R1a,
Freedom, evidence, resource identity and the attached volume.

The batch contract remains 10 distinct shortest tasks, k2, 20 individual runs in
one CLI launch under the parent's coordination. No singleton proof is authorized.

## Reusable lesson

Every acknowledged terminal lifecycle phase needs a truthful evidence contract.
A boot that never launched its driver and a driver that never launched its stack
are different phases. Preserve their distinction instead of inventing a task
result, bypassing evidence validation, or keeping compute running indefinitely.
