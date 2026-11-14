---
id: 2026-11-05-round16-cancelled-canary-execution-isolation
date: 2026-11-05
title: Exact round16 missing parent provenance blocked isolated successor
surface: harness
component: deploy-test-native-cleanup
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: native reconciliation requires absent parent execution provenance before assessing the exact failed operation's current execution partition
symptoms:
  - preallocation evidence absent from original adapter result
  - round16 one failed nine cancelled with linked two-machine canary
  - original adapter exists but parent runtime provenance is absent
tags:
  - cloudbench
  - isolated-validation
  - retained-owner
sources:
  - commit 3d4c6c5088b10c1da23622ed91ed22ee45482f8c
repro: python3 scripts/tests/deploy-test-cycle.test.py Round16CheckoutIsolation
status: mitigated
---

## Problem

The exact fc2 campaign retains an authentic adapter and eleven native audit
pairs: ten parents and one linked infra canary. Nine parents lack runtime
provenance; the successful-refresh parent and canary retain distinct actual
provenance. The SSH failure's cause remains unresolved. Historical evidence
cannot be manufactured to turn this into a completed cleanup or task pass.

## Diagnosis

Original source/patch, task records, parent/canary linkage, eleven lifecycles and
both copies of every native audit were inspected and pinned. Only the canary
allocated resources: two recorded machines were removed; their exact detached
volumes are terminal. All native registries retired, and three Hub owner files
remain. Fresh read-only native GETs establish the exact stopped warm instance
and configuration, and verify each recorded machine/volume partition. Current
host inspection verifies all original controller PIDs and relay scope quiescent
except the exact live Hub incarnation; its listening socket must also belong to
that PID on the original port. None of this establishes historical
cleanup completeness or converts source intent into execution provenance.

## Solution

A source/token/byte-pinned investigator admission handles only this original
operation. It reuses the existing execution-only verifier with operation-specific
snapshot and live resource checks. Exact participant/provenance membership,
canary linkage, native audit digests, all three Hub debts, adapter identity and
all four inherited admissions are mandatory. Future requests retain the old
machine/volume exclusions and need new token/root and normal source/environment
checks. Only a fully revalidated exact linked successor allows old proof renewal.
The ordinary cleanup path is unchanged. Always return cleanup_complete=false,
credit_granted=false and obligations_preserved=true. Do not mutate providers or
claim the underlying SSH error fixed. Delete/unify cannot recover historical
provenance that never existed; this bounded compatibility predicate preserves
that absence instead of relaxing future producer requirements.
Golden reference: not applicable (no approval-gated hunk).

## Human feedback

The user required all old/new financial and native obligations retained and
forbade fabricated provenance, absent-process historical cleanup claims,
provider transitions, Kernel allocations, canonical edits and a blind retry.
The earlier raw-exit diagnostic is observability work, not a cause fix or PASS.

## Reusable lesson

Use original native custody plus fresh exact resource partition evidence to authorize only isolated execution while preserving missing historical authority as debt.

## Combined inherited-admission integration failure

At canonical `9f03f9e03009794caabc776e3eb87caa65dc6b75`, round16 itself
validated but `isolated_admissions(state, 'smoke')` still refused round12's
old guest configuration. Rebuilding the old proof would replace historical
observations and cannot establish the current shared guest's identity.

The exact latest round16 admission may now supply current shared-guest and
successor-source authority only for its pinned round12/14 ancestors. Its full
validator must pass first on the current plan/source. All five admissions,
all original request edges, receipt hashes, sources, native roots and exclusions
must agree. Each old snapshot and current local Hub/process ownership is still
validated; ce/e92 retain their complete normal validation. Original proofs and
state are never rewritten. The latest proof alone cannot authorize a foreign,
missing, changed or credited ancestor. Ordinary cleanup is unchanged.

`Round16InheritedAdmission` in `scripts/tests/deploy-test-cycle.test.py`
reproduces the old combined admission failure and covers exact future-request
binding, omitted/foreign/changed debts, changed latest proof/source and
ancestor edges, wrong next source, reused token/root and unchanged original
state. The full owning suite passed 220 tests. A read-only check of the real
canonical five-admission set also passed both admission and successor binding;
no request was issued, and all original cleanup/credit flags remained false.
This repairs integration admission only; the original SSH cause is unresolved.

## Clean successor lifecycle correction

Independent review reproduced a follow-on error: a complete native successor
passed the existing `clean_isolated_successor` checks for all five debts, but
inherited admission still required the latest token to be round16. The exact
independent lifecycle reproduction was run before and after the correction.

A distinct post-successor branch now calls the unchanged full native successor
validator for every original debt, requires exactly those five bindings and
current source, then revalidates the original ancestry, snapshots and local
owners. Only this authenticated cleanup substitutes for the obsolete guest
observation. The pre-successor branch still requires the complete live round16
partition proof. No historical entries or credit/cleanup flags are rewritten.

Registered lifecycle regressions cover clean PASS, complete clean FAIL that
stays FAIL, focused/final admission, next-request binding, and rejection of
incomplete/owned/cancelled/timed-out/lingering executions, wrong source/command/
contract, omitted/foreign bindings, altered native evidence or requests, and
changed original proofs/local owners. The final full owning suite passed
224 tests. The production cloud failure and unknown SSH cause are not repaired
or credited by this controller admission correction.
