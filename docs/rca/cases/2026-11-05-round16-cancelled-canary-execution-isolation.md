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
