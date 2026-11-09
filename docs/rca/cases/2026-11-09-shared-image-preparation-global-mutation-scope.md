---
id: 2026-11-09-shared-image-preparation-global-mutation-scope
date: 2026-11-09
title: Shared image setup combines app-global mutation with whole-inventory qualification
surface: infra
component: cloudbench-source-preparation
classification: unresolved
problem_class: concurrency-inefficiency
first_bad_boundary: Parent facf cloudbench_maintenance.verify_transition rejects unrelated inventory membership churn after native setup; replacement outcome proof pending
symptoms:
  - native maintenance: extra/missing inventory target
  - native transition did not qualify; original exit retained
tags:
  - cloudbench
  - source-ownership
  - image-preparation
  - concurrent-lifecycle
sources:
  - commit facf1f1f8613293a82f153a7688e36866b274ecd
  - commit 8046dcbc3a67e7d4241d8eb6171b5c1652b85f71
  - PR #1635
  - fleet run 20261029-011042-1883979
repro: scripts/tests/cloudbench-original-image-failure.test.py
status: open
---

## Problem

Parent native image activation e9895d980baaf10648039d8e9dd3067b exited
setup 0 but qualification false and parent exit 1 after 230.282 seconds.
Recorded inventory changed from 45 to 54 Machines: 13 added, four absent,
zero changed common foreign rows. The target passed its image, stopped,
mount, volume and default parked shape checks. Setup also staged app-global
secrets, so dropping only foreign inventory assertions would be unsound.

## Diagnosis

The original parent source capsule is forensic evidence, not main. Main
8046dcbc does not contain the parent's unpublished cloudbench_maintenance.py.
Exact AST extraction of its verify_transition, fed byte-verified original
intent/result copies (qualified restored only on a deep copy to its pre-catch
value), reproduced ValueError: native maintenance: extra/missing inventory
target. The original receipt remains qualified false; no historical cleanup
or financial credit is granted. Native lifecycle outcome reproduction and
replacement fail/pass proof remain open.

Archive searches were `extra/missing inventory target` and `concurrent warm
image preparation secrets`. The earlier independently owned source case
2026-09-12-fleet-required-active-shared-source-without-owned-alternative is a
relative: it added an immutable private-source fleet consumer, but preparation
still needs an explicit native owned-resource producer rather than shared setup.
There is no Rose agent self-report: this failure occurs in native controller
preparation before a task agent starts.

## Solution

Implementation prepared for native outcome validation: reuse the existing private source manifest consumer,
with target-only native lease/version-bound preparation and immutable resource
creation authority. App-global secret staging stays outside this transaction;
target guest environment, source, image and installed dependency proofs must
be verified before publishing the successor snapshot manifest. The parent gets
an explicitly reviewed additive adapter preserving original debts and failures.

At 10,000 agents, preparation is keyed to each owned source and its native
lease, with bounded provider requests. No global idle window, app-wide inventory
equality or global preparation lock is introduced. The existing captured source
digest determines fleet pool isolation. The original pure verifier and byte-identical normalized intent/result are permanent forensic fixtures; their regression preserves the exact refusal and false outcome. Native HTTP boundary tests cover the new owned producer, source/secret/lease/CAS tampering and concurrent reader claims. Source-version and lost-guardian regressions failed on the old boundaries and pass on the repair. The existing private-source suite passes 168 cases. Real provider outcome validation and full deployment remain pending.
Golden reference: not applicable (ordinary native infrastructure code; any
approval-gated adapter hunks require separate frozen review).

## Human feedback

The user explicitly authorized this separate pre-parent-merge repair and full
deploy. They require genuine parallel independent smoke campaigns, no app-wide
quiet window, original unchanged receipts, exact source/image/volume ownership,
fail-closed unknown authority, measured capacity and normal admission. Protected
shared and foreign per-dependency sources and all old debts remain untouched.

## Reusable lesson

Prepare immutable fleet inputs under exact owned-resource authority without mutating shared app state or requiring unrelated lifecycles to remain idle.
