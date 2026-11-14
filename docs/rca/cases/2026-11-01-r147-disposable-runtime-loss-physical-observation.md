---
id: 2026-11-01-r147-disposable-runtime-loss-physical-observation
date: 2026-11-01
title: Disposable owner lacks runtime evidence after deletion; physical-only observation succeeds
surface: infra
component: cloudbench-disposable-recovery
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: acknowledged cancelled guest has no collected sealed runtime bundle before documented disposable teardown
symptoms:
  - sealed runtime evidence was never collected
  - exact full recovery refuses the missing manifest
  - original failed lifecycle and runtime latch remain after physical observation
tags:
  - r147
  - it34
  - disposable
  - physical-observation
sources:
  - commit 3d29b35fef17263e0963b6a7a16ed1c9efb203a3
  - fleet run 20261101-220015-75116
  - plan: original owner 0f5851c3833246b4a395eefe17b66cfe
  - plan: physical observation receipt 0225a6f6a03735d53dbf09938cbe0bb9b754b8136f73b2c4e65a2a9d09835df3
repro: copied original owner inputs reject in actual runtime-confirm helper; existing local forensic observer separately records physical terminal states
status: open
---

## Problem

It34 j0010 remains originally CANCELLED. Its guest acknowledged shutdown after the controller received TERM, but the sealed runtime manifest was never collected. The original cleanup records runtime evidence missing and retires the exact disposable Machine857614ef320418 and Volumevol_v8ewoqz9kmg83dkv. The original fleet lifecycle remains failed; neither cancellation nor evidence loss becomes a task PASS.

## Diagnosis

Exact source and original owner/audit inputs bind the deletion to this disposable allocation. The committed disposable-lifecycle documentation expressly permits deletion despite missing runtime evidence. Source cleanup retains the failure and evidence latch; this is not a missing protection inferred solely from filenames. `destroyed-provider-retained` denotes a terminal provider object, not a recoverable data backup. The `volume-backups` records only disable scheduled snapshots and preserve native identity; they contain no data archive. Available driver and aggregate/live-publication files do not establish normal7 or the contents of a remote Hub bundle.

An offline replay using copied original inputs and actual runtime-confirm/helper code returned1 at the absent sealed manifest, without reaching any native call. ACK and runtime latch remained. The generic forensic and retired-diagnostic routes lack their required original capture for this case. Archive searches for runtime-evidence retention and forensic/native ordering found related cases, but their preserved-volume/complete-archive prerequisites differ; they do not authorize synthesizing evidence here.

## Solution

No runtime patch. The existing `cloudbench-local-forensic-closure.py` supplies a separate physical-only observation route. Supplemental original custody contained26 regular native-fence files; their indexed hashes and the exact single destroy-incarnation/ACK join were independently verified. The real binding helper accepted the original owner, task, allocation and volume identity. One local prepare returned0 with two resources and zero provider calls.

The initial observation failed on local output-directory setup; that attempt remains preserved and supplies no physical proof. After separately authorized directory preparation, the corrected existing observer returned0. All ten corrected packet hashes and receipt0225a6f6 were verified. Its three GET records cover app authority, exact Machine and exact Volume. Offline replay of the existing terminal validator classifies both resources `PROVIDER_TERMINAL_RETAINED`: terminal=true, absent=false.

The receipt expressly retains runtime_sealed=false, claims_released=false, guest_cleanup_confirmed=false, benchmark_success_inferred=false and original_release_epoch=null. It resolves physical-state uncertainty at that observation without native mutation, ordinary full-release credit, registry retirement or reconstructed runtime. Missing runtime evidence and the registry/claim gap remain open. No source application or new code candidate is implied.

## Human feedback

None specific.

## Reusable lesson

Use the existing typed physical observation when disposal and evidence completeness diverge. Preserve its narrower meaning; a terminal native object does not supply missing runtime, historical cleanup proof or benchmark credit.
