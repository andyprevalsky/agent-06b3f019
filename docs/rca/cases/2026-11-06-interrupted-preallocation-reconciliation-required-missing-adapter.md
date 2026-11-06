---
id: 2026-11-06-interrupted-preallocation-reconciliation-required-missing-adapter
date: 2026-11-06
title: Interrupted zero-allocation campaign and static TERM cleanup required nonexistent adapter bindings
surface: harness
component: deploy-interrupted-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: native cleanup dereferenced receipt.worker_result before recognizing canceled preallocation custody while local recovery required an isolated worker and KILL
symptoms:
  - worker ownership remains; reconcile exact cleanup before recovery
  - native cleanup proof refused with Path NoneType despite sealed empty allocation audits
  - local cleanup recovery raised worker_root KeyError for an ordinary static TERM receipt
tags:
  - deploy
  - interrupted
  - preallocation
  - custody
sources:
  - commit f271a2eba6c4f01fb442a3c6ddd7d1d781d03a36 cycle 16 interrupted focused attempt
  - commit cf7cb6564c47de6970d03e19e4f84662dc2e139c unchanged native and local cleanup validators
  - agent private interrupted-zero-admission-rca-result.json and immutable original attempt receipts
repro: python3 -B scripts/tests/deploy-test-plan.test.py InterruptedCustody
status: open
---

## Problem

The operator canceled an admitted focused batch after discovering a long elapsed
clock gap. Smoke retained a canceled/-9 native-producer receipt with no adapter
result or cleanup reference. All nine launched controllers later ended failed/143
with sealed, identical canonical/local empty allocation audits and absent owner
registries. The ordinary backend structural command ended canceled/-15; its
native supervisor reaped every TERM target and reported quiescence without KILL.
Both receipts correctly retained UNVERIFIED cases and lingering ownership.

## Diagnosis

Gate: NOT_INTRODUCED relative to the browser application changes. The same
owning refusals occur using the unchanged validators on main baseline cf7cb6564.
This is a harness custody contract gap, and remains the parent's assigned repair.

Actual read-only native reconcile raised Path NoneType on the null cloud adapter.
Its later guards require an uncanceled result-bound producer and provenance for
every parent. The missing-input exception covers only linked infra canaries;
the existing unlaunched layout requires zero controllers and cannot describe
these nine real parents. For static structural cleanup, direct validation raised
worker_root KeyError; the existing interrupted local path requires an isolated
worker and exit -9 with KILL, unlike the original npm route and TERM wait records.

The owning permanent control reproduces both unchanged validator refusals,
then exercises the corrected coordinator dispatch with the same receipt shapes.
The source-bound actual private replay additionally binds all nine native fleets,
the parent's separate real publication recovery and native Hub retirement.
Original bytes and historical reconciliations are compared before and after.

The original outer smoke receipt ended at 22:38:46.709364 UTC; native campaign
finalization finished at 22:39:49.038104 UTC. The original publication ACK does
not hash the final record and remains invalid. Separate native publication
recovery and actual Hub retirement supply later evidence without rewriting any
of those originals. All nine disposable flags are originally false, with
successful_runtime_inferred=false; older missing-runtime debt is distinct.

Archive searches used "native cleanup reference campaign interrupted provenance"
and "zero allocation canceled preflight owner". The unlaunched-campaign,
campaign-recovery and preallocation-owner cases are related boundaries. None
supports fabricating an adapter for this interrupted operation. The prior
preallocation mapper's recursive marker exclusion informs the zero-resource
proof, while all allocated-guest guards remain mandatory.

## Solution

Add one typed launch-only custody module and coordinator dispatch. Bind the exact
latest interrupted request/receipt, original source/execution contract and all
consumed original files. Require full sealed zero-allocation campaign closure,
source-bound producer ordering, native publication recovery and terminal Hub
consumer custody; static TERM uses genuine supervisor wait records and fresh
exact process-group/log-holder observations. Preserve the execution gate for
source-refresh revalidation. No original verdict, null adapter, time or owner
record is replaced. No execution or financial cleanup credit is awarded.

Permanent negatives cover every allocation class, nested markers and symlinks,
mixed allocation, wrong source/task/owner, retained registries, bad ACKs, missing
retirement, active log holders, early confirmation, changed contracts and
unreaped/live TERM targets. Actual provider/payment outcomes and older quarantined
guests are outside this fix. Parent owns final review, application and rerun;
this case remains open until those checks complete.

## Human feedback

The user authorized only the two exact interrupted shapes in a new module,
preserving raw application review inheritance and all historical debt. Existing
cleanup validators, cycle tests, guide, instructions and registry stay unchanged.
Never manufacture provenance, native execution, a cleanup waiver or a result
that the canceled producer did not emit.

## Reusable lesson

Reconcile interrupted launch custody from positive terminal ownership evidence without inventing the missing execution receipt.
