---
id: 2026-10-17-released-startup-workspace-blocked-bound-launch
date: 2026-10-17
title: Released startup workspace had no bound launch continuation
surface: infra
component: original600-launch-recovery
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: the bound launch reader accepts pre-execution failures but cannot consume a canonical released-workspace terminal after an uncertain Machine create
symptoms:
  - failed to forward request during controller Machine creation
  - FAILED_STARTUP_WORKSPACE_RELEASED with no task or supervisor started
tags:
  - cloudbench
  - startup
  - recovery
sources:
  - commit 69aa6ff584588cfaa07d0a875fb9bdf308267c5c
  - fleet run original600-1792271666901142356
repro: python3 scripts/tests/original600-portable-operator.test.py
status: open
---

## Problem

Original74 recovered all 551 candidate reservations and passed the fresh capacity gate. The controller Machine-create call then returned a forwarding error before a Machine ID was published. The original gate exited. Its canonical workspace cleanup issued one deletion intent, initially observed deletion still pending, and kept the owning caller alive. One later invocation of the existing cleanup command followed its exact existing marker, performed only reads, and wrote the canonical release. The original caller consumed that release and joined. No supervisor or task started.

The existing bound-launch continuation accepts specific failures before gate execution. It lacks a typed transition for this released-workspace outcome even though the original request, configuration, reservation proofs and admission deadline remain available.

## Diagnosis

The upstream cause of the forwarding error is unknown; the error does not establish that the create request was never dispatched. The launch packet SHA256 is 6cc3d8f2a44e892be9c2e60859a98e470fd06f2433c7ac9f815142c63277033d. Its exact volume-delete marker binds the original authority and workspace. The closure packet SHA256 is cccbc76041ed1c7f4b30fad2f79d697302233d7a82d835bd15600d10a33afb6f.

The terminal is FAILED_STARTUP_WORKSPACE_RELEASED, with gate exit 1, original cleanup-helper exit 1 and external reconciliation recorded. The release reports no live matching Machine, a pending-destroy workspace and no verified command history. The caller and monitor joined. These facts permit an explicit new launch transition; they do not turn the old uncertain create into a successful or never-dispatched request.

## Solution

Add a typed branch to the existing prelaunch failure validator and reuse the existing bound-launch continuation. Require the exact canonical terminal/release, original authority/workspace/create/delete bindings, known source bytes, closed private output membership, original configuration and positive caller closure. Refuse controller ownership, supervisor or payload-transfer artifacts, an active caller, changed files, expiry, or a previously claimed successor.

The continuation must retain the old output, create a new exclusive successor and authority, obtain fresh capacity and native reservation proof, and preserve the original workload and 90-minute deadline. No old create or delete request is replayed. This change addresses the missing recovery transition, not the unproven upstream forwarding failure.

## Human feedback

The user asked to simplify startup and explain why full parallelization was failing. This failure occurred before parallel workers existed. Keep the recovery within the existing launch mechanism and retain all 600 tasks and timing limits.

## Reusable lesson

An uncertain allocation followed by canonical release is a distinct state from an operation that never started. A continuation should prove closure and preserve that distinction rather than erase the old attempt or invent success.

## Successor archive continuity

The bound launch records its new configuration through the fixed host-launch-successor pointer while retaining the original admission configuration and reservation request. The recovered-reservation reader must follow this exact chain after full current-archive closure. It verifies both configurations and source identities, the complete old input hash map and membership, the canonical prior release, and the original request descriptor. It preserves the old recovery host proof rather than treating the successor as a fresh reservation. Seven owning controls cover the full closed successor archive, the previous reader rejection, and altered pointers, clocks, configurations, source identities and recorded input hashes. These are local reader controls, not task success credit.

The actual bound continuation created controller80eeed0b5537d8 and verified its bulk transfer in a42.592-second observed file window. The earlier forwarding error remains unexplained; this does not change the old failure or prove task completion.

The next full read-only preparation exposed an earlier dispatcher that still recognized only the old pre-execution successor shapes. Route the exact released-workspace stage through the existing recovered reader, return its current derived configuration, and retain full current-archive validation before recovering the original request. Sixteen owning controls include the full unused-reservation → closed-archive → recovered-request path, the old dispatcher rejection, altered closed history, and ordinary bound launches with an explicitly null failure. This is reader compatibility for the recorded successor; it does not relax ownership checks or grant task credit.
