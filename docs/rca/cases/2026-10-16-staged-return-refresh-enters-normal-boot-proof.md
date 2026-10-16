---
id: 2026-10-16-staged-return-refresh-enters-normal-boot-proof
date: 2026-10-16
title: Staged pool return audit refresh entered the normal boot-config validator
surface: harness
component: run-bench-fleet pool return audit
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: pool_verify_reuse_proof refresh skipped explicit-idle verification and called pool_native_reuse_proof with normal boot assumptions
symptoms:
  - 'File "<stdin>", line 32, in <module>'
  - 'could not reconcile this controller's exact pool claims'
  - 'fresh primary STOP/pool return was not verified; retaining exact ownership and data'
tags:
  - staged-boot
  - pool-reuse
  - return-audit
sources:
  - PR #1525
  - commit d05203f18; run 20261016-080741-1711 owner f83ed63d565c4fc2999a305fe88e3646
  - fleet run 20261016-080741-1711; private v41-command-cfeee9cc78680cca/response.json
repro: scripts/tests/cloudbench-explicit-idle-admission.test.py StagedPrimaryReturn.test_actual_audit_refresh_release_and_next_claim
status: open
---

## Problem

Both N2 substrate probes had successful typed STOPPED_PROBE_VERIFIED receipts with zero real-task credit, but the following pool audit refresh raised an assertion and retained both claims. The overall run was not successful. Root separately verified both Machines stopped; no native operations were performed by the fix author.

## Diagnosis

The staged verifier had already checked current stopped native pairs, Volume identity, current claims, launch ACK, typed probe results and guest shutdown. Next, fleet_audit_record_pool_machine called pool_verify_reuse_proof with refresh. That mode deliberately skipped the explicit-idle branch and entered pool_native_reuse_proof without a cold argument. Its line 32 required init.cmd to be bash /cloudbench-boot.sh. The staged transport intentionally retains sleep infinity, so the audit applied a different transport's contract. The registered actual audit caller reproduces that precise old assertion with fake native reads and the real claim/return pipeline. This is separate from the earlier mutable Volume counter refusal.

## Solution

For staged transport only, refresh reruns the full existing typed verifier with fresh reads. A read-only comparison then binds that result to the original indexed return, retaining all stable fields and validating the original descriptors. Only the three new native observation descriptors differ; record() is not called again. The audit and exact claim release remain unchanged. Tests cover real audit-to-release-to-next-claim, typed probes, changed native/runtime/claim, corrupt saved receipt, and the unchanged normal transport refusal. Existing return and admission bytes remain unchanged. No broad suite or provider calls were used.

The source correction is locally verified; final native verification is still pending. Dead-owner recovery of the already failed run is a separate requirement and is not authorized by the live-owner verifier.

## Dead-owner follow-up

The original failed run cannot use the live-owner refresh after its controller exits. Its saved typed probe returns and owned claims were captured in private packets `v41-command-cfeee9cc78680cca`, `v41-command-55d959c1948dd1a6`, and `v41-command-ac8d986776cdff80`. The old preconfiguration recovery correctly refuses a released boot barrier, so it is not a recovery path for these executed probes.

A separate `cloudbench-staged-probe-recovery.py` path now requires the canonical inherited recovery mutex, a live recovery caller, the absent original owner, failed original lifecycle, a joined zero-worker typed probe cohort, intact original return indices/claims/audits, and fresh stopped native pairs and Volumes. It archives original records before releasing each exact claim under its Machine mutex, then links the release to the original immutable return. It neither changes the failed outcome nor credits real tasks. Live verification remains pending; incomplete or absent claims, latches, mixed/fresh allocations, and changed evidence refuse instead of falling back to another recovery mode.

## Human feedback

The user requires existing Machine reuse, idle teardown and preservation of IDs, Volumes and data. Root specifically required immutable original return receipts, full fresh typed validation and no live-owner impersonation for subsequent dead-owner recovery.

## Reusable lesson

Route audit refresh through the same transport-specific proof contract that established the return, while preserving its original immutable receipt.
