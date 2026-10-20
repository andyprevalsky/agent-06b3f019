---
id: 2026-10-16-fresh-primary-teardown-destroyed-reusable-capacity
date: 2026-10-16
title: Fresh primary teardown destroyed capacity instead of confirming STOPPED and returning it
surface: infra
component: cloudbench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: cleanup sent successfully completed fresh primaries directly to registry reaping
symptoms:
  - "fresh successful Machines are destroyed and the next CLI creates replacements"
  - "fresh primary STOP/pool return was not verified"
tags:
  - cloudbench
  - teardown
  - pool
  - billing
sources:
  - PR #1525
repro: python3 scripts/tests/cloudbench-bootstrap-recovery.test.py FreshPrimaryPoolReturnTests
status: fixed
---

## Problem

The completed fleet cleanup passed fresh primary registry entries directly to
`reap_registry_clones`. It did not return healthy capacity to the pool, so a later
CLI needed new Machines. The user requires preserving IDs, Volumes and data,
while querying native state until compute is actually STOPPED.

## Diagnosis

The same two cleanup-callsite tests against unchanged `8fe23c8fe` fail three
assertions including subtests: cleanup reaps immediately, and simulated STOP or
return failure does not fence reaping. This is distinct from the earlier
claimed-pool evidence-copy branch defect in
`2026-10-16-runtime-copy-failure-skipped-owned-pool-stop`.

## Solution

Use the shared read-only live-owner primary plan to select the exact healthy
completed primaries. Check every selected name and Volume, reject protected warm
IDs and Volumes, request STOP with the existing bounded helper, and query until
all are observed STOPPED within the existing stop budget. A STOP acknowledgement
alone is insufficient. Then call the canonical live-owner pool return, which
independently requires its full stopped/native/provenance proof before publishing
capacity. Only after successful return may existing reaping handle remaining
registry entries. STOP or return refusal sets teardown failure and retains the
registry and data; there is no fallback primary deletion.

The live-owner plan and return implementation are a separate dependency,
`16038d366778c2ea94f0d6a865494a4239715eea`. This change does not weaken its positive
join, guest shutdown, runtime evidence or current-owner checks. Fresh primaries
with failed evidence and cold/preconfig lanes remain retained when those checks
refuse them; this change does not claim they are reusable. Remaining worker
cleanup is unchanged.

## Verification

Five registered owning tests passed five unchanged runs. They execute the actual
STOP helper and cleanup callsite with isolated native boundaries, checking a
never-stopped ACK, eventual STOPPED, foreign Volume, denied ownership, protected
warm identity, already-stopped revalidation, return ordering, and failure without
reaping. Shell syntax and diff checks passed. There were no provider or guest
calls; runtime qualification and integration remain root-owned.

## Human feedback

The user requires teardown to idle owned Machines, query Fly until actual
STOPPED, and preserve IDs, Volumes, data, protected warm capacity and Freedom.

## Reusable lesson

Successful compute teardown and ownership transfer are separate verified steps.
A failed transfer must retain custody, not fall back to deleting the resource.
