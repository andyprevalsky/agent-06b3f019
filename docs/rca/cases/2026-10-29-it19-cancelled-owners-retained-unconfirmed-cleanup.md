---
id: 2026-10-29-it19-cancelled-owners-retained-unconfirmed-cleanup
date: 2026-10-29
title: Cancelled It19 owners retained unconfirmed cleanup until canonical recovery
surface: infra
component: cloudbench-owner-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Four original controllers retained delivered-but-unacknowledged guest cleanup and incomplete runtime capture; original guest-side completion timing is not captured; a fifth lifecycle stayed failed after verified provider teardown
symptoms:
  - "1 guest(s) did not acknowledge browser/session cleanup; retaining provider ownership"
  - "a delivered guest is still draining"
  - "runtime evidence is incomplete; retaining original fleet volumes"
tags:
  - cloudbench
  - it19
  - cancellation
  - cleanup
sources:
  - commit d1b1062cfd420832467d4e2b7e10c770a0318157
  - plan:.context/r68/proof.json
  - plan:.context/r68/five/five-failed-cleanup-index.private.json
  - plan:.context/r68/aggregate17-release.private.json
repro: none-recorded
status: open
---

## Problem

It19's original20-task campaign was stopped after independently confirmed
BU072r2 TLS failure. Original summary remains7PASS/4FAIL/9cancelled, with
final producer finish2026-10-29T18:23:39.731795+00:00. Cancellation-induced
INFRA_ERROR labels were not counted as new independent failures. Twelve fleet
lifecycle receipts were verified; five were failed. No full release was claimed
from campaign termination or matching file hashes alone.

## Diagnosis

The investigator verified162 safe original member hashes. Four cancelled
owners retained both guest-cleanup-unconfirmed and runtime-evidence-unconfirmed,
with cleanup_policy=retain. Their logs report a delivered guest still draining,
no acknowledgement and no collected sealed runtime manifest. They are:

- j0005 owner860237d0dcfd491ba3c64cfa20704b1a, Machine8747990be39728,
  Volumevol_v8ey9lzqlz8ggm7v.
- j0008 owner7cb09e51ba7945198d82aafc691edd97, Machine8ee326a7349458,
  Volumevol_rkgd2j0qkqgjezw4.
- j0011 owner516cb4fe6fbf4f01ab955f35038608e5, Machine8ee325c71561e8,
  Volumevol_vlyx3kjp9xwpw2g4, plus volume-only allocation
  vol_r7y5kpz9ngyme8nr with no recorded Machine ID.
- j0015 ownerfe2163419696489cb3e7628cdc83f91e, Machine8911676a6d7d68,
  Volumevol_42kd1nzymd921j04.

The fifth, j0003 owner03e0286451d342859e33e339f6a378f5, had guest cleanup
acknowledged, provider teardown verified, absent registry, and a matching
canonical/mirror auditffe0e3f361296c5f1dd58bdd4accbb78cf41b8899ff885b938fcb32843850c88.
Its original lifecycle still said failed. That lifecycle status is not a claim
that the provider resources remain active.

Exact source already supports these states: recover_exact_stale_fleet_owner
handles an absent registry with sealed audit through terminal projection;
quarantined retained owners require proven-dead same-host controller, exact
recovery lock, canonical output-to-Machine mapping, authenticated guest
shutdown, and runtime evidence before reaping. Volume-only records remain in
the owned ledger but do not become invented guests. Missing original guest
response bodies and timing prevent attributing the initial drain failure to
a specific race or transport defect. No new code repair was justified.

The initial17 lifecycle files match their supplied individual hashes; this is
custody verification only. It does not turn five FAILED lifecycle statuses
into VERIFIED. Archive searches for delivered guest cleanup and failed terminal
projection found related existing recovery cases, not a new proved recurrence.

## Solution

Operational recovery was performed by the separately authorized owner through
four canonical exact-owner invocations, all returning0. The parent independently
verified each canonical/mirror digest and the aggregate17 release joins.
The investigator executed no provider/native/recovery action.

Aggregate receipt observed1793299466.60343 confirms all17 provider audits
verified, all17 registries absent, original lifecycle bytes unchanged
(12verified/5failed), and original grades unchanged. The c001 cleanup budget
has a retired receipt, no exact grant remains, and cold/legacy liability bytes
are0. Resource disposition is destroyed-provider-retained, not universal
provider absence. These are operational closure facts, not benchmark score or
normal-execution evidence promotion.

The receipt SHA is recorded in the handoff. Initial cause remains OPEN; no
runtime changes, new tests, retries, timeout changes or task regrades were made.

## Human feedback

The coordinator required five individual ownership plans, separation of guest
and runtime gates, no new native reads during investigation, and preservation
of cancellation labels and historical lifecycle bytes. After canonical recovery,
the coordinator authorized this docs-only record of verified operational closure.

## Reusable lesson

Reconcile exact owner, guest acknowledgement, runtime custody and provider audit
independently, and never rewrite historical lifecycle failure into task success.
