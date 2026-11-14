---
id: 2026-11-05-interrupted-cloud-adapter-missing-result
date: 2026-11-05
title: Interrupted cloud adapter omitted original result needed for isolated admission
surface: harness
component: deploy-test-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: deploy_test_cloud waits for native drain before publishing result while its coordinator can kill the adapter first
symptoms:
  - "TypeError: argument should be a str or an os.PathLike object where __fspath__ returns a str, not 'NoneType'"
  - worker_result null with native_cleanup_reference null
  - cancelled true and native_exit -9
  - warm refresh started before missing execution provenance
tags:
  - deploy
  - isolated-validation
  - retained-owner
sources:
  - commit 1bd8133c0f47c27012a06ec3a9b48065433ad94d
repro: python3 scripts/tests/deploy-test-cycle.test.py Round12InterruptedIsolation
status: mitigated
---

## Problem

Round 12 left ten terminal native jobs but no original adapter result. Generic
native cleanup dereferenced the missing path before any isolation assessment.
All interrupted task outcomes remain UNVERIFIED. The source transport intent is
not proof of execution, and no historical adapter or provenance may be invented.

## Diagnosis

Original request/receipt, source intent/patch, ten lifecycles and matching native
audits survive. Generic resource admission was crossed. The tenth job log
records warm machine 683e47df5094d8 starting and a remote fetch upload, so empty
clone inventories cannot establish no mutation. Read-only native GET/exec/GET
on the same recorded instance found only init, hallpass and idle sleep, no
refresh descendants, no unreadable processes, and no original token path.
The only socket belonged to hallpass. Local observation found only the retained
Hub. Six original Hub owner records survive, including five starting records.
The original cancellation sender remains unknown and is outside this repair.

## Solution

Add one explicit, source/token/byte-pinned investigator-only admission before
the missing-adapter dereference. Preserve native outcome files, participant and
audit closure, the six Hub records, and both inherited ce/e92 admissions. Bind
the original native guest observation, then repeat read-only GET/exec/GET on every validation. Require the original started instance/config, no refresh processes or sockets, and no token file; recheck current local ownership. The
ordinary cleanup path is unchanged. The returned result always retains
cleanup_complete=false, credit_granted=false and obligations_preserved=true.
The successor still uses the existing fresh token/root, full inventory, source,
environment, input and command guards. Only validation_source may be renewed
under the existing explicit renewal protocol; original observations do not turn
into execution provenance. Guest quiescence is refreshed for each admission; the old captured observation
is never treated as perpetual exclusive custody of the shared warm machine.
Its normal maintenance lock remains mandatory for later native work.

This mitigates admission for this exact historical operation only. It does not
repair the adapter lifetime, settle historical provider cleanup or grant test
credit. A general future producer should publish request-bound dispatch and
cancellation evidence durably before its owning adapter can be terminated.
Delete/unify cannot recover bytes never published; the narrow reviewed legacy
boundary avoids weakening the normal cleanup contract for future producers.
Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The user forbade fabricated historical authority, ordinary cleanup credit,
waivers, source changes in canonical, provider mutation and new live tests.
They required all six Hub records and every inherited obligation to survive.
Independent parent review is required before integration.

## Reusable lesson

Separate proved retirement of an interrupted execution from missing historical cleanup authority, retaining every obligation when admitting isolated future validation.

The normal coordinator does not export FLY_API_TOKEN. The read-only observer
uses the existing native-release-audit token parser over canonical agents/.env
when the environment token is absent. It never exports the token or changes
the environment digest. The exact run-next setup accepted the proof with
FLY_API_TOKEN absent and unchanged environment/digest.

A later round exposed the stopped-donor contract: native fleets require the
shared source stopped, while the investigator observer originally required it
started for exec. Exact-id/instance/config stopped observations now use two
GETs and no exec. A running-to-stopped transition requires explicit renewal of
only validation_source, guest_observation, local_observation and confirmed_at;
the full original evidence and every debt are revalidated. Transitional states
and changed identities/configuration still reject. This does not reconcile
round 14 or authorize any provider stop/update.

The stopped-state renewal keeps clean_isolated_successor unchanged. A later
incomplete round, including round 14, remains a separate blocking owner; a
positive stopped observation grants neither retry readiness nor cleanup credit.
