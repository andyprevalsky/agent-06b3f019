---
id: 2026-10-16-shared-worker-host-admission-ignored-old-autoscaler-pool
date: 2026-10-16
title: Shared-host admission ignored the original autoscaler's complete eligible pool
surface: infra
component: worker-process-deployment-admission
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: reconcileWorkerProcesses accepted eight pinned hosts without proving the old autoscaler could not later stop a shared host
symptoms:
  - unsafe old pool reached native facts
  - stopped same-surface ninth Machine remains eligible for the running old autoscaler
  - captured low minimum can qualify when native list and exact-host reads disagree
tags:
  - deployment
  - autoscaler
  - existing-machines
  - custody
  - native-identity
sources:
  - PR #1518 development qualification
  - commit 9eea156403dbddd8b6acf128987998e5ba797cdb
  - commit 58726c9ba5798eec0d263d8362731136a01324d4
repro: cd back-end && node --import tsx src/tests/unit/worker-process-deployment.test.ts
status: fixed
---

## Problem

A pre-deployment source audit identified a missing shared-host safety condition.
Keeping the old process alive and disabling the new process's autoscaler does
not prevent the original autoscaler from stopping the entire host. No candidate
process or production pointer was changed to reproduce this gap.

One read-only production-app observation at 09:02:41 UTC found eight started and
one stopped Machine, all in the old `f5734e638fc8` surface and `6ef22cc` build.
All nine native configurations set `MIN_MACHINES=8`; actuation was not disabled.
The stopped peer's newer-looking name did not change its actual old environment.
Its owner retained unknown-data custody and closed only the failed retry intent.

## Diagnosis

Critical path: retained eight-host plan → per-host config/health checks → new
process admission → original autoscaler app-wide surface selection → later
host stop. Exact OLD6ef source filters by the native surface, including stopped
peers, and clamps desired count to MIN. It can restart a ninth eligible peer,
then later stop an idle old-primary host while a new process is busy there.
The old health endpoint does not account for the new process's activity.

Archive searches used `MIN_MACHINES old autoscaler shared host stopped same
surface` and `sidecar worker process unplanned native pool scale down`. The
hardcoded deployment-floor case and stopped-worker build-provenance case are
relatives. Neither changes already-running OLD6ef or proves the new shared-host
controller's whole-pool admission condition. No native lease protection was
assumed.

The initial actual-owner reproduction retains seventeen existing passing
controls and fails the new unsafe-nine-pool assertion: eight host facts are read
where zero are permitted. The final unchanged fixture, with new read-only
transport and fixture adapters retained, also fails against only the original
core deployment owner. This source-scoped replay is not a whole-baseline build.

A further exact-owner control found that a saved MIN=2 configuration could
qualify against a list reporting MIN=8 followed by an exact read matching saved
MIN=2. The repair binds each list configuration to its retained fingerprint
before checking the actual floor; the existing exact-host CAS remains.

## Solution

Before any host command, read the complete native app Machine array and mirror
the old surface selector across every state. Require its exact member set to be
the planned eight, with unique identities, running state, retained configuration
fingerprints and actual minima covering all eight. Unknown data, an extra stopped
or created peer, a missing member, unsafe floor or list failure returns eight
UNKNOWN observations with zero facts/status/ensure calls. No result is cached.

The existing registered owner now has 23 passing groups. Its all-matching
MIN=7 list/plan/exact-read control fails when only the floor condition is relaxed
in a source mutant, proving that fingerprint equality alone cannot pass safety.
The same fixture passes after restoration. Native-shaped `instance_id` arrays
and foreign-surface isolation remain covered. Existing seventeen assertions
remain intact; the real-Postgres fixture receives only the necessary typed
read-only list and environment adapter.

The source owner reports full TypeScript, five-file lint, format and diff checks
passing. Root independently inspected the frozen code and causal logs, verified
all five file hashes on adoption, and ran the canonical owner: 23 groups PASS,
exit zero. Full composed-source qualification remains separate. No allocation,
Machine control, old-process
change, schema, prompt, retry policy or terminal behavior is added.

This repair intentionally denies the observed real nine-Machine pool. It does
not release the stopped peer's custody or authorize deleting unknown data. That
is the separate explicit operational decision `1518-retire8940-0902`; silence
is not approval. Production activation and all remaining gates stay incomplete.

At 10k agents, reconciliation adds one bounded native app GET per recovery tick,
with a fixed eight-host proof and no per-agent query, lock or polling. The native
transport keeps its existing response/deadline bounds. A changed or oversized
pool blocks admission instead of increasing an unbounded hot-path workload.

## Human feedback

The user requires finishing deployment through existing Machines and permits
optional skips. No new allocation, loss of unknown data, old-work interruption
or relaxation of the eight-worker gate is inferred from that instruction.

## Reusable lesson

An isolated new process is still exposed to the original host controller; prove
the complete controller-visible pool and its actual capacity floor before
admitting work on a shared host.
