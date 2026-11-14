---
id: 2026-11-02-r150-it36-cleanup-floor-admission-observability-gap
date: 2026-11-02
title: It36 cleanup admission refused without failure-time capacity operands
surface: infra
component: cloudbench-cleanup-tickets
classification: undetermined
problem_class: observability-trace-capture-gap
first_bad_boundary: c001 cleanup-ticket prepare raised insufficient_physical_floors before selected task admission
symptoms:
  - twenty selected jobs cancelled without starting
  - final-edge capacity projection passed but actual prepare refused
  - failure receipt omits capacity and effective policy operands
tags:
  - cloudbench
  - cleanup-admission
  - disk-capacity
  - original-evidence
sources:
  - commit d904db6fe5cd01a684644f854d1446b7661dbb2a
  - benchmark run campaign-20261102-023433-474387
  - agent ph7eq6ca0cp3vnxvh8qh26c4ts8h5bmt
  - plan: It36 original terminal custody and separate hold cancellation receipt
repro: Original c001 prepare refusal preserved; no deterministic causal reproduction established
status: open
---

## Problem

It36 ended on its original source after approximately 20.4 seconds, before any
selected job started. Its summary records twenty CANCELLED jobs, peak concurrency
zero, and c001 aborted with `cleanup_ticket_failure=prepare`, `ValueError`, and
`insufficient_physical_floors`. This is an admission failure, not twenty task
failures. The original summary SHA256 is
`30a8edf40905b8fa225ce9f1f833ea2d16ab320620d65d0f6532e0d6555e4b75`.

## Diagnosis

Archive searches used `insufficient physical cleanup cohort floors` and
`cleanup admission free space headroom preflight`. The October 6 concurrent
reserve case's Solution and Human feedback describe a demonstrated accounting
race and fixture isolation repairs. They do not establish recurrence here.

The exact cleanup helper (SHA256
`78afbdbb0fd70ebd13e0b2edf498f225848fd0602cd0b07a8b7d2079f4a65b0d`)
holds the admission lock and computes available capacity as current filesystem
free bytes minus cold/legacy liability minus per-slot headroom. For sixteen jobs
plus the canary, unchanged defaults require 17 times (256 + 32) MiB:
5,133,828,096 bytes, plus liabilities. It raises the recorded error when the
remaining amount is below the minimum; budget/grant publication follows that
check. The campaign invokes prepare before seed/canary/task admission.

The final-edge projection at epoch 1793586873.5247347 observed 5,150,781,440
free bytes and zero liability, a 16,953,344-byte margin under those defaults.
That is not the failing prepare observation. The later existing-only sample
also is not that observation. The failure receipt does not serialize free
bytes, effective policy environment, or complete cold-grant state at the
failed call. The captured empty legacy admission state alone cannot establish
zero cold liability then. No exact capacity delta, writer, policy mismatch, or
accounting defect is proved.

Independent custody checks verified 315 checksum entries and 198 campaign
index entries, including 179 regular-file hashes. The initial collector's
producer-ledger-change refusal remains preserved alongside a supplemental
exact-prefix check identifying the two expected launch/end rows; it was not
silently converted into an unchanged-input receipt.

## Solution

No runtime repair is claimed or proposed from these observations. Preserve the
original refusal and capacity floors. Additional logging would be prospective
observability work, not a repair or retroactive measurement of this incident.
A causal conclusion requires the failing admission's free-space sample,
effective reserve/minimum/headroom values, and complete liability inputs.

The coordinator reports applying the separately reviewed terminal record once:
iteration 36 is an unscored history gap at its original finish, with raw twenty
CANCELLED jobs and no invented infrastructure task grade. The acceptance ledger
remains byte-identical at 110 PASS, 83 FAIL, and 207 unscored slots. The separate
matching hold receipt records cancellation. Neither terminal bookkeeping nor
that receipt establishes full resource release or benchmark success. No new
benchmark, retry, provider request, or capacity-policy change is part of this
investigation.

## Human feedback

None specific to this incident.

## Reusable lesson

A nearby passing projection does not explain a later admission refusal. Preserve
the failure-time operands before attributing the difference to capacity growth,
configuration, or accounting.
