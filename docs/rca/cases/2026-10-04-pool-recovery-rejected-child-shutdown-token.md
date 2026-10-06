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
  - existing guest cleanup confirmation is unsafe
  - stopped exact Machine has no sealed provider-state proof
tags:
  - cloud-fleet
  - teardown
  - recovery
sources:
  - PR #1410
  - fleet run 20261004-201108-11163
  - PR #1299
  - commit e33e3c94e285c5665f77b198c25e7bca3f1ac9c6
  - fleet run 20261006-115614-55990
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

## October 6 recurrence: fresh canary recovery rejected the child format

The unchanged fifty-copy cached campaign at `e33e3c94` aborted before its strict
cohort released: zero of fifty outer jobs reached readiness. Its task-free
infrastructure canary had allocated two fresh Machines. Exact native recovery
reported `existing guest cleanup confirmation is unsafe` for both outputs.
The original regular files contained the two owner-derived guest tokens,
matching the original guest `RUNSTAMP`, rather than the fleet run ID.
Their retained SHA256 digests are
`d22d816da882a8cc4454ebb99c892d07b865620aef1b58afa34cd11dd23f4a72` and
`ea7251c5453b0108f8de15c9c11bcb2309bda89633a685a80c3a3dae1459ad6e`.

Archive searches were `existing guest cleanup confirmation is unsafe` and
`infra probe interrupted child token fleet run identity`. This recurs at a
sibling consumer of the October 4 identity contract. The earlier correction
covered pool claim confirmation, while general guest cleanup recovery still
required only the batch ID. The most upstream additional defect was the child
producer: its infra-probe shortcut wrote a confirmation during interrupted
startup even though the guest had not completed. Normal fleet cleanup skipped
an existing marker; later recovery rechecked guest health and rejected the
token, exposing the disagreement.

The permanent producer and recovery controls use the original owner/token
format and run these real shell functions. With unchanged assertions, the
immutable original source produced **5 failures and 5 passes in 1.04 seconds**;
the repair produced **10 passes in 1.37 seconds**:

```bash
agents/venv/bin/python -m pytest agents/benchmarks/cloudbench_dependency_sync_test.py -q -k 'guest_shutdown_child_confirmation_uses_fleet_identity_only_after_completion or exact_guest_recovery_archives_bound_child_token_without_treating_it_as_ack'
```

The negative cases preserve rejection of a foreign owner, wrong task ordinal,
wrong Machine, wrong fleet run, symlink, and arbitrary existing marker. The
positive recovery case explicitly requires stopped-Machine proof, exact
provider cleanup, receipt validation, and only then confirmation publication.
The original child marker alone cannot satisfy any of those steps.

The producer now receives the canonical fleet run ID and emits that identity.
The held-driver shortcut requires a completed guest; interruption requests
real shutdown. Existing marker reuse requires the expected identity and a
regular nonsymlink file. For the already allocated original guests, recovery
may preserve the old child-token bytes only after binding owner metadata,
fleet run, immutable catalog ordinal, output Machine mapping, and the native
guest token. It archives that marker as diagnostic evidence and continues the
existing stopped-state/provider proof path; it never promotes the legacy
marker to an acknowledgement. This narrow compatibility exists to retire
the original immutable failed invocation, while future producers share one
canonical identity. It does not relax cleanup or benchmark acceptance.

Twenty-one related lifecycle controls and all fifty-nine Codex-auth controls
passed. The existing completed-probe Codex fixture now explicitly supplies
`FINISHED=1`; its assertions were unchanged. The fixture previously omitted
that production completion state, so its intentional completed-driver shortcut
looked indistinguishable from interrupted startup. The owning producer and
recovery tests are included in the compact deploy selection.

Native reviewed recovery ran for eleven seconds and correctly advanced past
the token mismatch. It then refused teardown because the stopped guests had
no sealed provider manifest, backend capture, or guest-state capture. Both
Machines are stopped, and their volumes and quarantined ownership claim remain
preserved for truthful forensic recovery. The separate 1,200-second resource
release cutoff was breached. This remains **zero benchmark credit** and does
not prove the requested cached executions, evaluator latency, full resource
release, or the original Hub-upload failure fixed. Those native outcome and
cleanup obligations remain open; passing boundary tests do not substitute.

At ten thousand guests, the producer change adds no remote calls or model
work. Legacy handling performs bounded local reads only for a mismatched
existing receipt; exact provider cleanup and native release checks remain
required for each owning resource.
