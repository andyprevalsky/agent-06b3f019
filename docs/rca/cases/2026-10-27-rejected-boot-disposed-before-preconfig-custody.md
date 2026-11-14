---
id: 2026-10-27-rejected-boot-disposed-before-preconfig-custody
date: 2026-10-27
title: Rejected boot configuration was disposed before preserving its preconfig evidence
surface: infra
component: cloudbench-fleet-preconfig
classification: our-bug
problem_class: observability-trace-capture-gap
first_bad_boundary: normal cleanup collected a guest runtime manifest for a rejected boot and entered disposable reaping without invoking the existing preconfig custody producer
symptoms:
  - primary runtime evidence remains incomplete
  - sealed runtime evidence is absent
  - absent primary with retained runtime-evidence-unconfirmed and no provider-teardown-verified.epoch
tags:
  - cloudbench
  - preconfig
  - evidence-custody
  - cancellation
sources:
  - commit 34ff3f23e6efa9ced9ff75732357df973db14e86
  - benchmark run campaign-20261027-191411-2591810 r002-j0017
  - benchmark run 20261027-191440-2597636 owner 2674cbe1a90842d79a4955c4fe0bb5fd
repro: agents/benchmarks/cloudbench_dependency_sync_test.py test_current_preconfig_captures_before_disposable_reap
status: open
---

## Problem

The Polar k2 campaign stopped at its one authentic Fly408 (r002-j0017). The
Machine d8d99353a46378 had three failed config updates, a boot-config-unapplied
marker and no post-config start acceptance, status proxy or guest ACK. Its child
finished 125. Cleanup correctly skipped an impossible guest ACK, but still
required a runtime manifest. It then disposed the exact disposable allocation,
recording destroyed-provider-retained for volume vol_4oj62kq6mz8e55xr, without
preserving the existing preconfig phase archive. The failed lifecycle, evidence
latch and unsealed audit accurately reflect incomplete custody; native absence
must not be used to forge a complete release receipt.

The launch owner supplied immutable representative bundle SHA256
7cb6322cdb3bc07edc45caf21f07c195cfdf78b10628d656f9c578bbbfcf89a8 and all18
coverage bundle 795d98907942391014064c7baa2db03c2da8406c1dfa69eb0ddb9c678087c64d.
Its native inventory is the original 19:36:15Z observation. Original TERM was
19:32:24.721Z; campaign finished 19:33:38.08Z. No fresh provider reads were made.

## Diagnosis

Path: failed boot update -> durable preconfig marker/runtime intent -> guest
shutdown skips unstarted guest -> normal runtime collection -> disposable reaper
-> final release gate. The missing producer is before disposable reaping. The
same repo already has an exact whole-owner preconfig archive producer, but only
stale-owner recovery invokes it. That producer needs positive identical native
instance/config observations; the marker alone is insufficient.

Two archive searches were `runtime evidence is incomplete failed result retained
disposable` and `provider release receipt missing resources destroyed`. A further search `boot-config-unapplied preconfig` found the September29
capacity-rejected mapping case and its October15 preconfig extension. This is
a relative of that stale-owner path and the October24 prelaunch/October8 recovery
projection cases: the former owns accepted boot/driver states; this failure is
configuration rejection before guest admission. The release gate is not faulty.

The untouched validator rejects original j0017 and j0001 manifests as absent,
while the original j0015 prelaunch manifest validates. All18 no-receipt owners
split 14 accepted/ACK-yes, 3 accepted/ACK-no, and 1 unaccepted (j0017). I5 owns the accepted
prestack class; this case covers only the distinct preconfig class.

## Solution

Applied after independent exact-snapshot review. Reuse the
existing whole-owner archive after producer joins, before ordinary collection
and reaping. Require unchanged exact native inert configuration across two
reads, preserve all original bytes under the existing1030-file/512-MiB ceilings,
commit/fsync zero-credit custody before consuming pending evidence, and retain
resources if any capture or proof fails. The normal collector revalidates the
existing consumed cohort. The final teardown/audit/epoch gate is unchanged.

The registered unchanged command was:
`PYTHONPATH=agents agents/venv/bin/python -m pytest -q agents/benchmarks/cloudbench_dependency_sync_test.py -k current_preconfig_captures_before_disposable_reap --tb=short`.
It failed five controls on the original producer (one existing unjoined guard
passed) in 6.25 seconds, then passed all six in 1.66 seconds. The missing receipt
is the positive failure; changed native instance, accepted start, allocated
worker and failed projection originally also failed to retain resources.
The positive control preserves the failed result, no guest ACK, no benchmark
run, and explicit zero credit. The related preconfig/collection/release family
passes 34 tests; the archive family passes 12, and shell/Python syntax checks
pass. The regression is registered in the normal benchmark-live-results gate.

Independent reviewer ph7dr4b0p5nc2qjtnfhtgsqpmx8h2zq6 returned GROUNDED for patch
SHA256 2524730ae0305415643d2337ada37f962b85674d072c7eec1be5911bddcf1cdc. All
three reviewed file hashes matched after application. Opened reference mechanisms:
Codex14ff9c3a43ebf9bf543cf5f7c45cff2bfea2e512
`core/src/thread_manager/shutdown.rs:112-159` and
`core/src/agent/control/runtime.rs:62-75` join admitted work and retain persistence
failure before caller retirement; OpenClaw76ddbf697fc263cc1bf89fe3f4d08d96ed4a43af
`src/gateway/server-close.ts:277-302,533-578` drains terminal persistence before
database/process retirement and joins cleanup before shared owner retirement.
The existing Rose preconfig helper supplies the unchanged stricter exact native
predicate and 1030-file/512-MiB bounds. Hermes cleanup is best-effort and supplies
no equivalent custody guarantee; it was not used to loosen this contract.
At 10,000 agents the added scan is local per fleet; only rejected-configuration
cohorts invoke the existing bounded archive and two native reads. No new poller,
provider mutation, timeout or shared lock was added.

Historical j0017 is not repaired: its native-before/native-after custody was
never captured. A new unchanged workload is needed for outcome proof, owned by
the parent. No task/rubric/timeout/model changes, paid benchmark or deploy.

## Human feedback

The user/parent required preserving all resources and Freedom, retaining
incomplete evidence as failure, separating I5 prestack from I7 preconfig, and
independent exact-snapshot GROUNDED review before harness application.

## Reusable lesson

A terminal state with no admitted guest needs its own positive evidence producer
before destroying the native source. Physical absence cannot replace missing
custody or turn a failed lifecycle into verified release.
