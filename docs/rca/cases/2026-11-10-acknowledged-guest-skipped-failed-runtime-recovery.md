---
id: 2026-11-10-acknowledged-guest-skipped-failed-runtime-recovery
date: 2026-11-10
title: A valid guest ACK bypassed failed runtime recovery
surface: harness
component: cloudbench-exact-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: valid guest ACK bypasses exact session cleanup after the native collector refuses an unsealed bundle
symptoms:
  - guest shutdown without sealed runtime evidence
  - sealed runtime evidence could not be recaptured
  - original-volume capture refuses a started Machine
tags:
  - cloudbench
  - recovery
  - runtime-evidence
  - ownership
sources:
  - PR #1881
  - commit a096a5fc3a3f6e2587bec7f07af8702e7592a938
  - fleet run 20261110-041707-3563283
repro: agents/benchmarks/cloudbench_dependency_sync_test.py
status: mitigated
---

## Problem

Source a096a5fc3a3f6e2587bec7f07af8702e7592a938. Original smoke campaign 2a447257bfe84d7b456eb85a27d674ddce74f6583023b7117650f6216ca41a2f remains failed/UNVERIFIED. Three once-only supported recoveries returned 1: test-shop owner1a7ab979c5484b99925bb2a1273000cf (04:32:30Z), setup-resume4f5566c57be44afc87bca64451ee708c (04:39:12Z), idempotent838704eaa4f64e87aac6b8107184aa43 (04:39:44Z). Each has valid original guest ACK, pending exact runtime ownership and native HTTP409 `runtime evidence is incomplete or changed` followed by `guest shutdown without sealed runtime evidence`. Subsequent read-only standard capture preflight refused each actual Machine as started. All remain retained.

This is the recovery failure, separate from the original KYC pagination/setup failure owned by another RCA. The completed new-user inert capture supplies adjacent startup evidence, not evidence that these three contain identical missing originals.

## Diagnosis

`recover_exact_stale_fleet_owner` validates original registry identity, same-host dead controller and policy, then the complete source-bound allocation plan and exact native configuration. Reconnected ACK validation succeeds. `fleet_recovery_reconnect_guest_shutdowns` proceeds to the strict runtime collector. The collector correctly refuses an incomplete execution seal. The old failure branch only attempts the existing startup archive; it never enters authenticated exact guest/session cleanup. Even if called, `cloudbench_recover_guest_cleanup_receipts` immediately accepts a valid ACK and skips its existing session-proof → exact Machine stop → native stopped-proof → provider cleanup chain. A guest ACK and a completed runtime seal are different facts.

## Solution

The unchanged registered test module executes extracted actual shell functions and the actual unchanged provider-manifest, stopped-proof and cleanup validators. Guest transport/native status are fixture boundaries; urllib network is forbidden. Frozen source: 8 failures/3 controls pass. The final17-control regression against v1 reproduces6 failures/11 passes; the same final controls against accepted v2 pass17/17 five times. The main causal assertion is `valid ACK bypassed original session evidence`; a second proves failed transfer never entered exact cleanup.

External candidate only changes two functions in run-bench-fleet and appends two tests to the existing test module. After an actual sealed-transfer failure, it requests existing cleanup only for that mapped output. Missing helper/proxy or failed output-directory preparation returns failure before any cleanup; those conditions are not classified as an attempted transfer. Before doing so it binds single-link descriptor-read bounded regular pending/owner JSON and accepted-start marker to the exact native guest token and Machine, refuses any existing seal, and preserves original ACK bytes. In this mode only, ACK and clean-runner shortcuts do not substitute for the existing exact session proof. The existing authenticated guest recovery and original provider manifest must succeed before the original exact stop path. Foreign/unknown state and failed manifest stop before any native-stop callback. Healthy peers and ordinary/sealed ACK handling remain unchanged.

The runtime latch is never cleared and the original failed transfer still returns failure; stopped original-volume capture/forensic verification remains a separate future operation. No benchmark success, retirement, or financial credit is granted by this patch.

## Validation and limits

- Final17 registered controls x5 all pass. Frozen a096 red originally gave8 failures/3 passes; v1 against the final17 controls gives6 failures/11 passes (the two review findings). Controls include original ACK byte preservation, neighboring output preservation, ordinary/sealed ACK, mismatched/symlink pending, wrong guest-state token, unknown state, rejected manifest and forged seal. Ordered events prove real manifest validation precedes the fixture exact-stop boundary, then real stopped-proof and cleanup validation.
- Final v2 focused neighbors:61 pass. Independent v2 review also ran8 neighboring controls; previous v1 focused sets are historical evidence only. These are local isolated tests, not live native acceptance.
- Existing `scripts/run-cloudbench-controller-local.py` selected-pytest expression selects all17 new cases via its existing `guest_shutdown_child_confirmation` family. File-level select_affected_tests reports no lane for the whole Python file; actual native -k collection is retained as the definitive test-specific selection proof. Registry and recipes are unchanged.
- Same-host/controller/source/config policy guards and their function bytes remain unchanged. Complete full controller/deploy suite and any live recovery of the candidate are pending parent integration.
- New-user original-volume observation: guest run.json, driver-clean ACK and driver.pid are genuinely missing; native capture cross-checked the exact prior state and provider-prestart-zero manifest. No originals were fabricated or used as retrospective test credit.

## Archive relation

Searches: `guest shutdown without sealed runtime evidence` and `guest-shutdown.confirmed` (archive-searches.json). October7 failed-startup execution-seal case establishes separate truthful cleanup and execution evidence; September29 runner-receipt/stack-cleanup case establishes exact state/session proof before stop. This is a related routing gap after a valid full guest ACK, not evidence that the strict runtime collector is wrong. No seal relaxation is proposed.

## Handoff

Source checkout/index/cycle unchanged; only private external candidate/evidence files written. No live provider/guest calls, new recovery, flag/ACK clearing, source integration, or resource changes during this RCA. Independent review accepted v2; parent must integrate and freeze before any normal source-bound validation or resource recovery. The three remaining retained resource obligations and historical financial custody remain.

## Independent v2 acceptance

Reviewer ph7fcc8jn5mbchfjv4w2qxa3ax8hwwvr ACCEPTED exact patch SHA256 ce2598209601b856a994a191a80f0849459f87c61c272aaadb75af092efe2a87. The first candidate incorrectly entered cleanup on unavailable transfer prerequisites and accepted hardlinked authority files. Both findings were reproduced offline and corrected. V2 separates prerequisites from the actual collector process and uses O_NOFOLLOW/O_NONBLOCK plus fstat single-link regular bounded reads. Independent wrong-target, mismatched authority, partial seal and hardlink probes reject; prerequisite failures make no cleanup call. Review artifacts: /var/tmp/cmd-deploy/resume/ack-recovery-independent/review.md and proof.json. No native recovery, provider mutation or deployment PASS is implied.

Parent independently completed the existing forensic/native recovery route for new-user at04:52:49.655Z; nine main owners are retired and three remain retained/started. That resource operation did not use this candidate. All original12 smoke outcomes and separate financial obligations remain unchanged.

## Human feedback

No new human preference was inferred. The standing instructions require exact ownership, original evidence preservation and no fabricated cleanup or test credit. This operational routing correction preserves those requirements.

Golden reference: not applicable to this infrastructure control flow; the existing authenticated provider/session proof and exact stopped-Machine verification remain authoritative.

## Reusable lesson

A guest acknowledgement must not replace a failed runtime transfer's separate recovery obligations. Enter the existing exact proof-before-stop path only after a real transfer attempt fails and its original identity is bound.
