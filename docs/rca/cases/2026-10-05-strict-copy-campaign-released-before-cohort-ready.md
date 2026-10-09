---
id: 2026-10-05-strict-copy-campaign-released-before-cohort-ready
date: 2026-10-05
title: Strict repeated campaign released each copy before its cohort was ready
surface: infra
component: benchmark-campaign-startup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: scripts/run-bench-campaign.py forwarded strict-barrier to independent one-task fleets without coordinating their start releases
symptoms:
  - first copy executes before the last requested copy finishes startup readiness
  - a pre-ready controller failure occurs after sibling copies have already executed
  - peak active controller count is mistaken for simultaneous task execution
tags:
  - cloudbench
  - campaign
  - strict-barrier
  - startup
  - ownership
sources:
  - PR #1299
  - commit 871e2949bf30cebb086749c64795496876719b7c
repro: agents/benchmarks/cloudbench_campaign_barrier_test.py
status: fixed
---

## Problem

The requested cached fifty-copy startup experiment needs actual concurrent task
execution. The supported `-k 50 --concurrency 50` CLI creates fifty independent
one-task fleet controllers. Each fleet's existing strict barrier covers only its
own stack, so a ready copy can execute while later copies are still starting.
The campaign's `peak_concurrency` measures controller processes, not execution
overlap. This diagnosis does not establish that an earlier live fifty-task fleet
failed: the previous flat fleet already had a shared start barrier.

## Diagnosis

The owning reproduction executes the actual campaign scheduler and actual fleet
`release_start_barrier` function with local controlled child startup and data-plane
transport. It records readiness, release and cleanup events without invoking
providers or changing benchmark tasks. On original source the first ready copy
released before another copy was ready; a startup-failing child left siblings
already executing; repeated bounded cohorts also released incomplete groups.
The identical four-control command produced **3 failed, 1 passed in 6.11 seconds**.
The passing inverse preserved ordinary non-strict sliding scheduling.

Archive searches for `campaign strict barrier copies concurrency premature
release` and `synchronized start barrier controller readiness autoscaler` found
the earlier unregistered campaign Hub parent, dead-driver observation and
scheduler-window fixture cases. They informed ownership and process ordering;
none supplies this missing cross-controller release boundary.

The existing startup capacity reservation is released after all primary starts
are provider-visible, before stack readiness. A campaign rendezvous inserted
later therefore does not retain transient replacement reservations. Existing
fleet and remote driver startup budgets already cover readiness waiting;
coordination should consume their remaining budget instead of imposing a new
short timeout or changing the execution harness.

## Solution

Only repeated campaigns using existing `--strict-barrier` or its existing
environment equivalent form fixed cohorts bounded by requested concurrency.
Each fleet joins a local rendezvous after unchanged stack and mandatory
autoscaler readiness, immediately before its unchanged authenticated release.
The existing campaign process owns a lifetime file lock and a fresh manifest
of expected jobs and child PIDs. Exact ready receipts allow the parent to release
the whole cohort. A known pre-release child exit, including premature exit zero,
writes an abort marker and stops later cohorts; ready and booting siblings exit
through normal owned fleet cleanup. This failure path adds no TERM/KILL deadline.
Loss of the parent lock also refuses release. Post-release genuine task FAILURE
retains normal behavior and does not cancel peers.

The unchanged four controls passed **4 passed in 7.57 seconds**. Independent
review identified one deployment gap: the functional fixture used live helper
files and could miss omission from the immutable controller copy set. The new
helper is included in the existing snapshot owning assertion, and that existing
control is selected in the compact deploy wrapper. The assertion fails against original
871e source with `cloudbench-campaign-barrier.py missing from snapshot copy set`;
the final combined scope passes **5 passed, 655 deselected in 9.46 seconds**.
The regression gate remains offline and small; no paid fleet stage was added.
Independent review approved the final source and archive, separately executing
the same **5 controls, 655 deselected in 8.52 seconds**, with clean Ruff, Bash
syntax and diff checks. No further verification was requested.

Private receipts live under `.context/acceptance/`:
`cloudbench-campaign-barrier-owning-red.private.log`,
`cloudbench-campaign-barrier-owning-green.private.log`,
`cloudbench-campaign-snapshot-owning-red.private.log`, and
`cloudbench-campaign-barrier-final-green.private.log`.

## Human feedback

The user requested parallel progress, visible continuous stage updates,
unchanged benchmark outcomes, a five-minute execution window, and compact
permanent deploy coverage. Keep ordinary non-strict scheduling, tasks, prompts,
models, evaluators, cache identities and execution timeouts unchanged. Actual
cloud task start/terminal intervals still determine observed width; an offline
cohort control or fifty active controllers cannot replace that measurement or
earn LIVE acceptance credit. Fifty cached mass-demo copies retain fifty GP
children each and genuine declared judges; they are not fifty distinct tasks.

## Reusable lesson

Synchronize workload width at the actual task-release boundary across the
scheduler's independent controllers. Process occupancy alone cannot prove
execution overlap. Scope new coordination to the requested mode and reuse
established readiness, startup budgets and owned cleanup; do not turn a startup
diagnostic into a fabricated task result or a new aggressive teardown deadline.


## October 6 non-strict fixture recurrence

The normal structural gate on immutable `85070617776b8355565266bf16f08a58093c1072`
failed the existing ordinary sliding-launch inverse: the first observed execute
occurred after the last ready event. The fixture delayed a later child with a
one-second sleep, which did not establish ordering on the loaded host. The
original output retains that inverted event order; it does not establish a
production scheduler regression.

The later non-strict fixture child now waits for the first actual transport
execute event before publishing readiness. Strict fixtures continue to use the
real complete-cohort rendezvous. Original first-execute/last-ready assertions,
strict outcome checks, failed-child controls and ordinary topology are retained.
The local campaign outer guard uses the shared generous fixture host guard;
production release endpoints and execution budgets are unchanged. The same
owning inverse and existing strict controls passed in the final sixteen-case command, and the existing compact
selector still discovers it. Original/final private proofs are under
`.context/fresh-basic-claude-final50-20261006/deploy/root-structural-fixture-repair/`.
This establishes the intended offline ordering scenario, with no LIVE proof
credit or benchmark behavior change.
