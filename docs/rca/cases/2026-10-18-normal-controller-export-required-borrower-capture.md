---
id: 2026-10-18-normal-controller-export-required-borrower-capture
date: 2026-10-18
title: Normal controller export recovery required a borrower capture
surface: infra
component: cloudbench-resume-controller-export
classification: our-bug
problem_class: logical-inconsistency-in-harness-contracts
first_bad_boundary: export recovery unconditionally reads a payload-finalizer identity receipt that normal controller startup does not produce
symptoms:
  - normal controller export returned pending after its supervisor joined
  - local export recovery failed on missing payload-finalizer.identities.private.json
tags:
  - cloudbench
  - export
  - ownership
sources:
  - commit c9d4817832720cc2b1bc6a212383973a77baf004
  - commit a819e410264bf95c993d551d406375a8621026d2
  - fleet run original600-1792279176545861179
repro: python3 scripts/tests/cloudbench-resume-controller-export.test.py
status: open
---

## Problem

Original77's existing threshold watcher requested its owned stop. The supervisor joined, but the canonical collector returned export-pending status75. The normal external caller retained the controller and workspace, as required. The existing export recovery command then failed locally because it expected a payload-finalizer identity capture from a borrowed-startup path. This normally launched controller had never used that path.

## Diagnosis

The retained gate, caller, authority, sealed Machine/workspace, source and launch records agree on the original controller. The gate process is absent while its original external caller remains live. The diagnostic packets are bound by SHA256 dd6f8e3d49acbd2ad70eae34aad9605cd40276978f00890349ef16952cbe15fb, 9adbe05d7dda0576e63481b831f35dfab62a6e31924066dc0944adbf692b4dac and d0abf9d01c41be1025fda9fdd41b826cf6cf4ebd7eecccb75baed5724819e757.

The missing borrower capture is not evidence that the normal owner is invalid. Conversely, a new record must not pretend that the already-reaped gate was just observed alive. Normal ownership needs its own present-time proof from the canonical records that actually exist. The cause of the collector's pending result remains separate until its unchanged remote writer checks run.

## Prior archive search

Searches used `normal export missing payload-finalizer identities borrowed` and `joined controller export pending live owner`. The pre-supervisor cleanup case and retained-retirement FIFO case are related lifecycle failures, but neither supplies this missing normal-owner validation path.

## Solution

The existing export command builds a distinct in-memory normal-owner proof only when the borrowed receipt is absent. It validates the exact historical source and host, private original config, authority template and environment files, original clock, live caller birth and command, reaped gate, sealed Machine/workspace, launch envelope, task set, supervisor identity and sidecar bytes. Each action rechecks the proof. The proof is recorded only in a new operation journal; no borrower capture is fabricated or backdated.

The native incarnation check, remote writer checks, original collector, archive verification and release marker remain unchanged. The original external caller retains cleanup ownership. Borrowed-path binding bytes remain unchanged. This adds no Machine creation or task execution path.

## Verification and limits

The existing export owner's normal-startup fixture fails on the old missing borrower receipt and passes with the new proof. Fifteen controls cover canonical ownership, changed source/clock/caller, native identity, export transport and cancellation. Static calibration uses the retained original envelope, authority and profile, including legitimate extra mount metadata. The actual full local check, remote export and resource release remain required before this incident is closed.

## Human feedback

Continue the authorized deployment and benchmark goal while preserving the current run, exact resource ownership and every original failure. Do not fabricate historical identities, remove writer checks or destroy the controller before verified export.

## Reusable lesson

Recovery must validate the ownership path that created the resource. A receipt from another workflow cannot substitute for that proof, and its absence does not justify bypassing validation.
