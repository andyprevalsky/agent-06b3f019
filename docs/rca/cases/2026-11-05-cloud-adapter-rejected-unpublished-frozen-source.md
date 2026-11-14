---
id: 2026-11-05-cloud-adapter-rejected-unpublished-frozen-source
date: 2026-11-05
title: Cloud deployment adapter rejected the unpublished frozen source
surface: harness
component: deploy-test-cloud
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: execute forced CLOUDBENCH_SKIP_LOCAL_PATCH=1 while collection required request HEAD with no patch
symptoms:
  - requested benchmark commit is not fetchable from origin and local patch shipping is disabled
  - execution provenance base SHA does not match the requested guest checkout
tags:
  - deploy
  - cloud
  - source-provenance
sources:
  - commit 759d0d0a48717284fccfd8e2cf701857057e0736
repro: python3 scripts/tests/deploy-test-worker.test.py CloudSourceTransport
status: fixed
---

## Problem

The deployment must validate its unpublished branch before permission to push.
The adapter disabled the native fleet's existing complete-workspace patch
transport and accepted only provenance with the requested HEAD and no patch.
The actual preflight stopped before any cloud task. This is a harness failure;
it establishes no application or provider failure.

## Diagnosis

The original adapter contract regression fails because the actual dispatch
sets patch shipping to 1 (disabled). Native fleet already resolves unpublished
HEAD to a fetchable merge base and ships committed plus uncommitted content.
Archive searches covered unpublished/ref/patch/provenance and cloud/source
binding/workspace patch. Source verification must compare against an expectation
sealed before launch, never manufacture one from the returned provenance.

## Solution

Before dispatch, resolve the native transport base and generate its expected
patch. Apply that patch to a private Git index and compare its tree to an
independent index of the current workspace, preserving the native history-ledger
exclusion. Bind this expectation to the canonical request source, token and
workspace and record it before launch. Keep the original requested HEAD in the
native CLI so fleet detects and ships its committed delta. Enable native patch
shipping and remove inherited foreign patch pointers. Collection requires the
actual native base and patch digest to equal the prelaunch expectation, with
unchanged source and patch bytes. Published no-patch receipts keep their prior
exact-HEAD rule. Native cleanup now compares against that same hash-bound prelaunch seal for patched executions; published executions retain the old exact-HEAD rule. No timeout, task inventory, cleanup obligation or outcome rule is weakened.

## Validation

Offline regressions cover unpublished commits and untracked executable files,
published no-patch source, incomplete patches, stale patch bytes, wrong source,
wrong token/workspace, changed worktree, wrong native base/digest, and missing
transport proof. Cleanup controls also reject a retroactive seal and keep the original source binding after later workspace repairs. The existing registered deploy-test-worker suite owns them.
The final owning worker suite passes 132 tests; source transport and cloud campaign controls pass 27 tests. The patched cleanup acceptance test fails on the original verifier and passes after the fix; full cycle validation is recorded with the handoff receipt. No cloud resources, provider calls, database changes or pushes are involved.

## Human feedback

User requires validation before source push, exact-source attestation, and no
resource allocations or live probes during this repair. No gate is waived.

## Reusable lesson

Transport identity may be a base plus complete patch; prove equivalence to the
requested workspace before dispatch and compare native evidence to that seal.
