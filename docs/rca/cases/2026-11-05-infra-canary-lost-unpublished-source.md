---
id: 2026-11-05-infra-canary-lost-unpublished-source
date: 2026-11-05
title: Nested infra canary lost the unpublished source patch
surface: harness
component: run-bench-fleet
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: fleet_infra_canary_preflight forwarded resolved BENCH_REF instead of original REQUESTED_BENCH_REF
symptoms:
  - cloud guest Kernel proxy custody preload is missing or unsafe
  - nested canary provenance records workspace_patch_sha256 none
  - parent sealed patch includes the required custody guard
tags:
  - cloudbench
  - source-transport
  - canary
sources:
  - commit e23dcd094d6fbafa6dcc120a4f79c3acc6e57408
repro: bash scripts/tests/fleet-infra-canary.test.sh
status: mitigated
---

## Problem

Round19's two canary guests failed closed before stack launch. Both boot logs
checked out e039a2a, omitted patch application, and then reported the required
Kernel custody preload absent/unsafe. The parent's sealed b4fa81f8 patch adds
the guard, but the canary execution provenance explicitly recorded no patch.
The guard does not exist in the base commit. The parent's generic adapter
validation failure is secondary to incomplete cleanup, not a proved identity
or inventory mismatch. Permissions are not established as the cause.

## Diagnosis

The parent preserves REQUESTED_BENCH_REF before resolving BENCH_REF to a
fetchable transport base. Its own patch includes all unpublished commits.
The infra-canary handoff passed only BENCH_REF. With a clean controller checkout,
the nested fleet saw requested==resolved and omitted that committed delta.
Current boot-driver code therefore ran against an old, unpatched repository.
The owning production-function test reproduced the incorrect forwarded ref.

## Solution

Forward REQUESTED_BENCH_REF, falling back to BENCH_REF only when the original
request is unavailable. The nested fleet uses its existing exact-source patch
producer and verification. No custody check, assertion, timeout or provider
policy is weakened. The same test now preserves the requested ref and original
failure exit. Existing custody tests verify denied proxy allocations, allowed
reads/reuse, missing guard rejection and runtime enforcement. Existing patch
transport tests retain digest and missing-payload rejection.

The adapter forwards its existing prelaunch-attested base and complete patch,
replacing any inherited foreign payload. Nested fleets verify the base, digest
and copied bytes, rather than independently reconstructing a patch. Patched
canary stamps and cohort receipt policy bind requested source, base and patch
digest. A changed/missing payload, different stamp identity or explicit
skip-local-patch with an unpublished delta fails closed. No guard-only copy is
used; native guest transport/provenance consumes the complete sealed patch.

## Validation and limits

The registered fleet-infra-canary structural test is red before and green after.
This is an offline harness repair, not a passed cloud canary or release gate.
Both recorded clones are destroyed; both volumes remain detached pending_destroy
in the read-only native observation. Original failures, Hub debts and incomplete
cleanup remain retained. No provider transition, payment action or retry occurs.

## Reusable lesson

Pass intended source identity across nested controllers; a fetchable base alone
is not the intended workspace when the parent carries unpublished commits.

## Human feedback

Preserve the zero-allocation guard and original failed-run evidence. Prove
the focused repair before repeating the full failed gate; do not restart
unaffected passing gates merely because the source was synchronized.
