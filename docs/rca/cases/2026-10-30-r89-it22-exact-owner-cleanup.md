---
id: 2026-10-30-r89-it22-exact-owner-cleanup
date: 2026-10-30
title: It22 retained cleanup recovered through exact-owner canonical routes
surface: infra
component: cloudbench-exact-owner-recovery
classification: unresolved
problem_class: observability-trace-capture-gap
first_bad_boundary: Four original owners retained cleanup state after campaign stop; underlying failures and recovery outcomes are separate
symptoms:
  - retained guest-cleanup-unconfirmed
  - retained runtime-evidence-unconfirmed
  - FAILED lifecycle with empty audit SHA
tags:
  - r89
  - it22
  - cleanup
sources:
  - commit 573847c1ea6ffbc28405d3ec29e39d8f86a5c2e8
repro: none-recorded; actual authorized canonical recovery receipts
status: open
---

## Problem

Original It22 retained four cleanup owners after the separately classified
operational stop. Original9PASS/3FAIL/8CANCELLED and historical producer-induced
infrastructure counts remain distinct from operational1of20. Original13
verified and fourFAILED lifecycle records must not be rewritten by recovery.

## Diagnosis

The original plan hash was
7db2cc68b773d1aafdf05794de5f7e95fe179420e0b862c63daebe55a627b2fe.
All169 supplied members were checked by size and hash. Owner8891 had a normal
seven-file manifest, no guest latch, a runtime latch, and an already-retired
primary. Ownersc843/54aa/16d6 retained both latches and one owned primary each.

Extracted canonical guest-plan logic ran offline against relocated scratch
copies. Missing transferred port files initially blocked three fixture plans;
subsequently supplied original ports8802/8816/8824 resolved that transfer gap.
Each then yielded one exact guest row;8891 yielded an empty guest plan. The
owner separately ran the unchanged normal-runtime and result validators on
8891's full originals, both exit0. No native operation occurred in this prep.

## Solution

No source patch or manual state edit. The coordinator authorized sequential
canonical exact-owner recoveries using unchanged source573847 and default
bounds, with dead-controller identity, locking, task/runtime provenance,
native ownership and audit checks. Each original failed lifecycle remains
byte-identical; recovered operational release is a separate assertion.

Current verified results:
- 8891dae258f3476ca8cf76573aebd885: rc0; canonical/mirror digest
 c97e5bfe73036caa0f8867bb120b69af10d5192a863837dd34445a39973796c4.
- c84393ebbbed43c3b61fa740d41b0894: rc0; digest
 14da70d907e0b74abf3d19f0fd9a29883ceda33773cd19ee97c2015ea84911f7.
- 54aa08386ee64a049957a47a8a866434: rc0; digest
 b2fdeac474d1c455c02e5708f17889ae985022bbbf8f2c206630241bec34ce4f.

Fourth owner16d634b0843742088884925b4909a4b9 also returned rc0; digest
80cc91aac6baeb8d9f54c2407e650a31bb3f4b65591ab3e5599515c1a1f40021.
All20 returned canonical audit files match the mirror, with separate
source-audit binding; original FAILED lifecycle remains unchanged.
Aggregate17 verification completed at1793318534.7898395. Receipt SHA256
1e507c3db0bd85d3e26554bd924f74adcbfe869e5e42970d3872dffa78be29ef
records17 unique original owners, matching canonical/mirror/source-audit
bindings, no retained registries, and provider-teardown-verified current audit
metadata. Parent matched all17 owner/fleet pairs and original lifecycle hashes:
13 remain verified and four remain FAILED with their original bytes unchanged.
This establishes scoped post-recovery operational release. Provider-retained
terminal dispositions do not prove universal native-object absence.

## Verification

Parent independently verified the first three canonical/mirror trees and
unchanged original lifecycle bytes. This investigator additionally reopened
c843 and54aa complete returned audit trees: all20 corresponding files match,
with the mirror's separate source-audit pointer binding the original digest.
Registry absence and original summary equality are recorded by the owner and
parent; no new query or independent native absence claim is made here.
No runtime tests, new model calls, provider queries or retries were performed
by this investigator. The fourth full returned tree was likewise independently compared here.
Parent independently hashed the original13 canonical trees and the four
recovery canonical/mirror trees. Current17 mirror/registry/summary state is
owner-local attestation cross-matched to those originals, not a new native
query by this investigator. Original summary hash
fe1bcc5bcc94747f8b527b59e932134f61edbb4e74072bce92d05b6eb0095063
and9PASS/3FAIL/8CANCELLED remain unchanged. Recovery supplies no score,
finish-time, original lifecycle or task qualification credit.

## Human feedback

The coordinator required per-owner plans rather than assuming the earlier
empty-retired shortcut, and separated original task grades, producer
infrastructure flags, operational stop and release. The fourth recovery and aggregate were checked before this documentation
commit was authorized. No runtime patch, broader cleanup, native query,
manual ACK, latch override, or new task launch was performed by this author.

## Reusable lesson

Validate retained owners against their exact latches and original custody,
and record operational recovery separately from immutable failed outcomes.
