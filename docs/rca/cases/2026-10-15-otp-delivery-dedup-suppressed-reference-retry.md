---
id: 2026-10-15-otp-delivery-dedup-suppressed-reference-retry
date: 2026-10-15
title: OTP delivery dedup suppressed retry of an unaccepted reference write
surface: agents
component: spawn-browser-agent-v3-native-input
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: _append_new_otp_user_messages marks delivery seen before reference persistence and later empty-mailbox polls never retry the reference
symptoms:
  - empty-mailbox poll did not retry the owned reference write with its original provenance
  - save_browser_credential_ref_message
tags:
  - otp
  - persistence
  - acknowledgement
  - deduplication
sources:
  - commit 897bf3a80e77ab0dc54aa288495939e3f3b2561b
  - commit c82a43d748dfc8c2653f9acfe75923251b4f19f0
  - commit 5a83ece839a48fd224aa8248dbd04223a40c89ca
repro: agents/tests/blackbox/otp_retry_behavior.py
status: mitigated
---

## Problem

The real helper delivers a native OTP and stable credential reference before awaiting the writer. If the writer returns False or is cancelled, seen-code delivery dedup prevents a subsequent mailbox poll from attempting that unaccepted write again. This is a focused owned-runtime defect, not evidence explaining the original live authentication-choice failures.

## Diagnosis

The writer's accepted boolean contract was conflated with one-time USER-message delivery. The corrected primary owning controls execute the actual activity with hidden internal state: first False or cancellation, then an empty mailbox poll. Baseline897 fails with the literal missing-owned-write assertion above, not TypeError from a new helper signature. Candidate attempts exactly twice; later duplicates or another credential with the same code create no additional delivery/write and preserve first provenance. A separate native-input control proves False ACK does not block immediate usable OTP input. Stale input and absent credential IDs retain existing behavior.

Evidence is .context/otp-simplified-owner-receipt.json in the private repair tree: corrected full control set baseline21PASS/9FAIL and candidate30PASS/0FAIL; only persistence_false/persistence_cancelled are causal evidence for this case. The separate helper refund baseline TypeError is not persistence proof. Final coherent snapshot retains both controls passing within31/0. Hard socket/httpx/requests guards record0 attempts. No live model, DB or provider calls were made for these corrected proofs.

Archive search OTP credential ref persistence retry accepted false found the auth-handoff-before-drain case and first-Gmail-account case. Those are related context, not demonstrated recurrence of acknowledgement/delivery state conflation.

## Solution

Keep the original seen-code early skip and one-time delivery/reference mapping. Add only an owned pending-reference dictionary independent of mailbox output; each existing poll retries pending writes, and True removes the entry. False/cancellation retains pending; genuine WorkflowGenerationSealed aborts rather than entering transient retry. Restore the existing consumed provenance outbox clearing, without retained maps, late-ID enrichment or an accepted set. No new polling loop, timer, numeric cap or retry budget. Candidate c82 includes this correction; review-only5a83 preserves it. Mitigated means focused offline correction proved, not deployed or original incident closed. Combined preview/full canonical and exact-hunk approval remain pending.

## Human feedback

The parent required independent usable OTP delivery and durable-reference acknowledgement, bounded existing polling/action limits, no prompt/tool/task/evaluator or timeout changes, strict offline network guards, exact before/after owning controls, and review-only checkpoints before any adoption. Parent rejected implementation-mirroring assertions, retained-map provenance expansion, global archive scans, path-derived ownership and treating sealed generations as transient failures.

## Reusable lesson

Track durable-write acknowledgement independently from one-time delivery deduplication.


### Golden-reference qualification

Parent independently read OpenClaw src/infra/outbound/delivery-queue-ack.ts:43-67: retain captured attempt ownership until acknowledgement before releasing artifacts. This is an architectural acknowledgement analogy, not a native OTP or original benchmark outcome proof.
