---
id: 2026-10-16-steel-readiness-guard-retained-out-of-scope-owner
date: 2026-10-16
title: Steel readiness guard retained an owner from the pre-merge implementation
surface: back-end
component: steel-session-replacement
classification: our-bug
problem_class: other
first_bad_boundary: merged recreateSessionWithinClaim readiness guard referenced retired handoffLease and boundProfile variables
symptoms:
  - TypeScript reported six unresolved handoffLease and boundProfile references
  - replacement owning control raised ReferenceError before its FAILED profile assertion
tags:
  - merge-integration
  - exact-owner
  - profile-readiness
  - regression
sources:
  - commit b6b2773fe2d7c045d3963410643f4d6a83125017
  - commit f0fe35fbb9ccbbb426fdbc49d46b36d0454c26f2
  - commit f3315c787a142c63cbe42c7f72aedc5542e44c0d
repro: back-end/src/tests/blackbox/steel-fingerprint.profile-handoff.behavior.ts
status: open
---

## Problem

A textual auto-merge combined upstream native profile readiness checking with a replacement implementation that moved ownership into nested durable claims. The resulting guard referenced two retired variables. The actual combined TypeScript gate failed with six TS2304 errors; the actual registered replacement owning fixture failed before its native FAILED profile assertion. The full combined backend lane also failed browser-provider and Steel domains, retained separately.

## Diagnosis

The first bad boundary is recreateSessionWithinClaim. Readiness belongs to its exact recorded profile and current task/profile ownership, not an older lexical lease. Its function already receives steelRecordedProfileId, writerReleased, and verifyLifecycleOwnership. A clean textual merge did not preserve that lifetime invariant. This ordinary code-integration problem is not a model or provider diagnosis. The private source/function reproduction establishes the invalid guard and its repair; final prepared gates and native verification are still required before closing the incident.

## Solution

The private two-file patch 940012d47cb9de7a2667cd6022651ad9084ebdc78d048b0f261e19b11026c433 uses current writerReleased and exact recorded profile, checks ownership before and after the returned read, preserves terminal FAILED handling and the existing bounded retry for non-READY/unavailable reads. The SAME registered fixture fails before and passes after; its 53 original assertions remain with 11 additional assertions covering FAILED, UPLOADING, unavailable reads and revoked ownership. Exact minimal private full backend typecheck exits zero. Two local tsx IPC attempts are denied per owning run; no transmission is admitted.

The separate legacy readiness test-only migration db6490b62d64cec95c143441fa3fc04f1fb57d24e5a6d99bad2b164e7236b466 uses actual durable claim seams and request-selected UUIDs. All 21 actual Steel cases and the typecheck pass privately. Five explicit old assertion mappings cover selected identity, ownership errors, and ERROR custody when native inspection still proves LIVE; confirmed release stays PAUSED. Unknown native IDs fail closed with 404 and foreign-ID rejection runs in all six readiness modes. Eight attempted connections in the whole domain are denied, with no admitted transmission. Fake storage expiry and provider behavior are supporting seam controls, not real concurrency/SDK proof. The original failures remain retained. Adoption and fresh combined gates are pending at this checkpoint.

## Human feedback

The user instructed agents to fix the failures and seek approval only at the actual deployment step. No failure waiver or permission to weaken provider ownership, tests, or timeouts was given.

## Reusable lesson

Bind composed readiness guards to the current owner's exact identifiers and lifetime, and verify the merged interaction even when Git reports no conflict.
