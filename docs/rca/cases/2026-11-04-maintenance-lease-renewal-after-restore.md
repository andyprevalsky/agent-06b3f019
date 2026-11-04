---
id: 2026-11-04-maintenance-lease-renewal-after-restore
date: 2026-11-04
title: Workspace restoration consumed the maintenance script lease
surface: back-end
component: project-maintenance
classification: our-bug
problem_class: concurrency-inefficiency
first_bad_boundary: The runner entered the sync script without renewing the project lease after sandbox creation and checkout
symptoms:
  - the project lease was lost before the snapshot could be published
  - valid long restoration leaves insufficient project lease for the script budget
tags:
  - maintenance
  - lease
  - ownership
sources:
  - PR #1634, review 5760150058, finding 4461008285
  - commit 632811006a19f471f00caccf000384c1729d586d
repro: node /project/rose-speed-comparison-20261028/nov3-maintenance-lease-renewal/proof.cjs
status: fixed
---

## Problem

The claimed lease covers the configured script timeout plus ten minutes. Creating the sandbox and restoring its checkout consumed that time before the script started. The runner had no caller of the existing conditional extendLease mechanism. A valid schedule could expire the project lease before publication while the sandbox remained within its original timeout.

## Diagnosis

The same deterministic command executed the actual runner and store with fake I/O and a fake clock. Two minutes of creation, nine minutes of restoration, eight minutes of script execution and a ten-second snapshot tail caused the original reconciler to expire the run after nineteen minutes. The sandbox's original twenty-minute deadline was not exceeded. Before the repair, two controls passed and two failed. After the repair all four passed, including refused renewal, restoration failure and publication ownership loss. The test preserves the original script, command and sandbox timeouts. Original proof logs and source hashes are retained in the private release evidence.

## Solution

After successful restoration, renew the existing project lease with the same duration and run identity. If renewal is refused, fail before writing or running the script. Existing cleanup, snapshot ownership and successor protection remain unchanged. Register the four actual-module controls in the existing project-maintenance suite. Parent integration runs that owning suite, typecheck, lint and normal release gates.

## Human feedback

The controlled store uses fake Prisma I/O and does not prove PostgreSQL interleavings. This is a stage-boundary renewal, not a periodic heartbeat or a guarantee that arbitrary work fits the sandbox lifetime. The pre-existing race where reconciliation selected an expired row before renewal is outside this proof. Do not weaken lease checks, suppress publication failure, lengthen test timeouts or release a successor's custody.

## Reusable lesson

Renew conditional ownership after setup and before entering a separately budgeted phase. A total lease that nominally covers one phase does not reserve that phase’s time after lengthy setup. Refused renewal must stop work before side effects.
