---
id: 2026-11-16-coalesced-cutover-ran-newer-job-with-older-controller
date: 2026-11-16
title: A coalesced Fly cutover ran a newer release's job with the executing run's older controller scripts
surface: infra
component: worker-deployment-queue
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: back-end/scripts/worker-deployment-queue.ts runQueue — after coalescing, it spawns the executing checkout's controller for whatever job is FIFO head, including a head from a strictly newer release
symptoms:
  - "recoveringPredecessor\":true"
  - "coalesced\":true"
  - "supersededBy"
  - "controller fix never ran"
tags:
  - fly-cutover
  - coalescing
sources:
  - commit 224a7c8c20 (deploy-agents run 43791105681 executed job c2b6101f)
  - commit c678865ab9 (job c2b6101f source)
  - commit 843236605b (#2147 controller fix, not exercised)
repro: back-end/src/tests/unit/worker-deployment-coalesce.cases.ts newerReleaseControllerCases (run via BACKEND_UNIT_TEST_FILES=worker-deployment-queue.test.ts npm run test:unit)
status: mitigated
---

## Problem

On 2026-11-16, run 43791105681 for #2257 (checkout 224a7c8c20) acquired the global
deployment lease and coalesced the queued jobs f9f10706 (224a7c8c20) and 75a82e08
(843236605b) into the newest one, c2b6101f (c678865ab9). It then ran c2b6101f's cutover
with its own `scripts/worker_pool_cutover.py`. Prod rows show both jobs SUPERSEDED at
02:30:26 with `supersededBy` c2b6101f and owner b84957d0, and c2b6101f SUCCEEDED by that
owner at 02:42. #2147's controller fix (843236605b) was therefore never executed, although
the deploy recorded its Fly lane as verified by the descendant cutover.

## Diagnosis

`runQueue` coalesces when it holds the lease. It then spawns `command`, which is always the
executing checkout's controller, for whatever job is FIFO head. The newer release's own run
had already recorded the ancestry fact (older ⊂ newer), so an older run reaching the lease
first supersedes its own job into a newer head and drives that cutover with older
controller code. Deploy runs have no GitHub concurrency group, so the newer release's run
is alive and waiting on the same lease.

Running the controller from the job's source commit was rejected. The controller's surface
is not closed: it imports back-end providers such as `database.ts`, and it would need that
commit's `node_modules`.

Repro: enqueue c1 and c2 jobs, record the c2 run's ancestry fact, then start c1's
controller. On the old CLI it emits `coalesced: true` and then `runningJobId` = c2's job
with `recoveringPredecessor: true`.

## Solution

`runQueue` identifies its controller by the checkout's `git rev-parse HEAD` and decides per
FIFO head:

- It runs the head when the head's release equals `HEAD` or local git proves `HEAD`
  contains it. This covers FIFO predecessors and deploy.md's manual resume from main.
- It defers when it has durable proof that the head is newer: its own job was superseded
  into the head, and that job's source is `HEAD`. This is the incident case and needs no
  network call.
- Otherwise it defers only on a memoized ancestry proof (git, then one GitHub compare).
  Unprovable pairs keep today's FIFO recovery.

A deferral emits `NEWER_RELEASE_CONTROLLER`, releases the lease and waits 5 s (or returns
under `--if-idle`). The newer release's own waiting run, a resume, or the scheduled
recovery then executes the head with a controller that contains it. Tradeoff: if the newer
release's run has died, its job now waits for recovery instead of being run by an older
controller.

10k behavior: unchanged. There is one queue per Fly app, and a deferring run adds one short
lease acquisition every 5 s.

## Human feedback

None recorded.

## Reusable lesson

When a coordinator coalesces work into a newer release, the code that executes it must come
from a checkout that contains that release. Otherwise prove which run executed the cutover
before calling a controller fix shipped.
