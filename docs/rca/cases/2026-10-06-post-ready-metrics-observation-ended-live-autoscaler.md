---
id: 2026-10-06-post-ready-metrics-observation-ended-live-autoscaler
date: 2026-10-06
title: Post-ready metrics observation failures ended a live autoscaler
surface: infra
component: benchmark-autoscaler
classification: our-bug
problem_class: timeout-too-aggressive
first_bad_boundary: bench_autoscaler promoted a lost post-ready metrics proxy or repeated empty scrape into terminal failure while exact primary and child ownership remained live
symptoms:
  - autoscaler exited after readiness before independent child completion
  - desired capacity already observed but metrics retry window failed
  - six empty post-ready desired-count scrapes wrote autoscaler.failed
tags:
  - autoscaler
  - metrics
  - observation
  - stage-handoff
sources:
  - PR #1424
  - commit 7872fa3d78d7ba38d2556d5b354fe0fc0400ee95
repro: agents/benchmarks/worker_capacity_loop_test.py
status: open
---

## Problem

After initial readiness, a lost metrics proxy exceeding a 30-second recovery
window, or six empty desired-count observations, wrote a terminal autoscaler
failure while primary identity and the independent task child remained valid.
The parent waits its task children before final aggregation; this does not
establish an immediate task kill or a live-fleet incident.

## Diagnosis

Two actual extracted-autoscaler controls use owned native local proxy and child
processes to cross each observation boundary. With identical final controls,
original source passes eight of ten and fails only the two new post-ready modes
in 14.761 seconds. The original assertions record failure after desired capacity
was observed and before independent child completion. A private corrected source
passes all ten in 16.192 seconds. All 30 pre-existing assertion ASTs remain.
Captured original native process births are positively absent and Popen children
are reaped. No provider, model or network calls occurred.

Archive searches for post-ready lost metrics and repeated empty desired-count
failures identify earlier inventory freshness and startup readiness cases as
related observation machinery. Those initial usable-stage and invalid-ownership
checks are distinct and remain required. No production race or performance gain
is inferred from these synthetic owning controls.

## Solution

Warn and retry these two post-ready observation failures within the existing
child/inventory lifecycle. An empty observation pauses capacity mutation and
resets scale-down confirmation. Previously owned workers remain owned; exact
runtime completion seals and bounded terminal reconciliation stay required.
Initial 600-second readiness, invalid ownership, actual primary/child/service
failures, task budget and independent overall release cutoff are unchanged.
The extended existing capacity family captures every replacement proxy birth
and treats empty PID publication as pending before parsing. The existing compact
deploy selector and benchmark blackbox discover it automatically; no new gate
or private monitor prerequisite is introduced.

Private original/candidate controls and source hashes are sealed under
.context/fresh-claude-grouped50-20261006/post-ready-observation-packet. Root
independently reviewed identical red/green controls and exact source. The fleet
is one input of the 39-file source recipe, so the final composed recipe requires
its ordinary reviewed policy binding. The 79 cold dependency inputs remain
unchanged. Final normal qualification is pending; live benchmark credit is zero.

## Human feedback

Intermediate observation failures should warn and continue when work can still
progress; require usable stage-end state, exact resource closure and the agreed
overall bounds. Preserve catastrophic owner/resource-loss handling and genuine
outcomes.

## Reusable lesson

A lost observation after readiness is not evidence of task or owner termination.
Pause decisions that require fresh data while preserving owned work and final
handoff requirements.
