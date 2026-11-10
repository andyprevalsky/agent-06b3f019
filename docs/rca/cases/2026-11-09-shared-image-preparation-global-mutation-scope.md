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

## Native validation in progress

The first native allocation on frozen d8f1bcd128c02bb938b64323991eabd70748e175
retained an ambiguous volume-create outcome. Its original pending marker was
written at 22:51:48.939776 UTC; the failure marker followed 20.004305 seconds
later with no HTTP status. A read-only inventory found one exact reserved-name
40-GiB volume, created at 22:51:50.024 UTC and still restoring, unattached.
The client collapses transport, JSON and absolute-deadline failures at this
boundary, so the precise transport cause remains unknown. No Machine create
was attempted and the original failure is unchanged. This is not a PASS or
allocation-free refusal. Supported exact-name reconciliation is being evaluated
against the original writeahead; no second POST or inferred cleanup authority
is allowed. Later-clone environment binding is also under final review.

The bounded live source now has exact reconciled Volume and Machine authority,
with both original POST acknowledgements honestly absent. The Machine is stopped
on its own encrypted volume. Native validation exposed two further causal
boundaries: a donor image activation after the owned snapshot fork incorrectly
invalidated immutable fork inputs, and the provider omitted false/empty defaults
and expanded mount metadata in its Machine response. Focused unchanged regressions
failed before each repair and pass after narrow input-scope/normalization fixes.
Snapshot, dependency, environment, mount and owned-volume tampering still refuse.
Full raw native evidence stays private; public reconciliation output is bounded
to identities and receipt hashes. Preparation and benchmark outcome proof remain
pending; these allocation records grant no benchmark or historical task credit.

The first live preparation on stabilization source
81ef70b1cb23a0fee892296b70cf90cdee35433d failed before START. A full native
200 response acknowledged the owned Machine CAS to the pinned image and
4-CPU/8192-MiB preparation shape, with a new instance ID. The next GET exposed
the exact predecessor configuration and instance in state `replacing`.
`wait_state` called the strict final-identity verifier before checking whether
that known replacement had completed. Cleanup also failed, and the original
receipt remains qualified false and cleanup false. Its stop transport has no
retained response; no successful STOP acknowledgement is inferred. No guest
execution, START, snapshot or task admission occurred.

The unchanged HTTP transition regression fails against the old wait boundary
and passes when only the exact acknowledged CAS predecessor is tolerated
within the original deadline. Unknown instance IDs/configurations still refuse;
START requires the acknowledged version in the requested state. The same rule
covers the image update, final park and cleanup park. A separate, credit-free
bootstrap recovery verifies the failed request, historical producer source,
original wire responses, original creator authority and exact current known
version under a new native lease. It reparks the same owned Machine without
starting it. A new request/nonce and successful preparation remain mandatory;
recovery publishes neither a source manifest nor benchmark credit. Local HTTP
failure/recovery/fresh-preparation/retirement controls pass. Independent review
and the actual recovered-source outcome are pending.

## Human feedback

The user explicitly authorized this separate pre-parent-merge repair and full
deploy. They require genuine parallel independent smoke campaigns, no app-wide
quiet window, original unchanged receipts, exact source/image/volume ownership,
fail-closed unknown authority, measured capacity and normal admission. Protected
shared and foreign per-dependency sources and all old debts remain untouched.

## Reusable lesson

Prepare immutable fleet inputs under exact owned-resource authority without mutating shared app state or requiring unrelated lifecycles to remain idle.
