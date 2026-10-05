---
id: 2026-10-04-pool-recovery-rejected-child-shutdown-token
date: 2026-10-04
title: Pool recovery rejected authentic child shutdown receipts
surface: harness
component: cloudbench-exact-owner-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: fleet_recovery_confirm_pool_claims compared only the batch ID
symptoms:
  - All fifty authenticated guest shutdown receipts exist but claims remain retained
  - Recovery searches for a never-started receipt after real execution
  - Child token and batch ID use different owning identifier formats
tags:
  - cloud-fleet
  - teardown
  - recovery
sources:
  - PR #1410
  - fleet run 20261004-201108-11163
repro: test_exact_pool_claim_confirmation_requires_guest_receipt
status: mitigated
---

## Problem

The failed wide slice had fifty stopped primary Machines, complete captured
runtime files and fifty guest-shutdown confirmations. Canonical recovery still
retained fifty claims because it rejected the existing receipt identifiers.
This was recovery evidence handling, not a missing shutdown acknowledgment.
The failed slice retains zero acceptance credit.

## Diagnosis

The child writes its exact owner/catalog-ordinal token only after authenticated
HTTP 204 from shutdown-health. Controller recovery writes the batch run ID.
The claim confirmer accepted only the controller format and then looked for a
never-started receipt on an already executed benchmark. Archive searches for
guest shutdown receipt token batch recovery found the September 29 runner
receipt case; that case concerns shutdown ordering rather than this identifier
compatibility boundary.

The existing owning claim-confirmation test was extended with the actual child
format, both supported writer formats, a wrong ordinal and a foreign owner.
It failed unchanged on the old source and passed after the narrow consumer fix.
Original cloud receipts and the zero-credit archive were preserved.

## Solution

Derive the child token from the exact claim, owning registry and immutable task
catalog ordinal. Accept that token or the batch ID in the existing regular
receipt. Foreign owners and another task's ordinal remain rejected. No receipt
is rewritten, no new provider call is added, and recovery grants no benchmark
credit. The compact always-run deploy control includes this owning test.

## Human feedback

The user asked to avoid unnecessary resets and verification that rejects valid
execution, while retaining real resource release and one allocation E2E bound.

## Reusable lesson

A recovery consumer must support the identifiers actually emitted by every
owning producer. Verify exact ownership without inventing a second execution
or release requirement.
